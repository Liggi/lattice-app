/**
 * Antigravity CLI (`agy`) provider adapter.
 *
 * Runs one long-lived `agy` print-mode process per Lattice conversation, with
 * stream-json on both sides: each stdin line `{"event":"user","message":...}`
 * runs one turn, and stdout is a stream of `init`, `step_update` and `result`
 * events. This adapter translates those into the Claude-CLI-shaped JSONL the
 * harness consumes.
 *
 * Event mapping (agy -> emitted line):
 *   init                                  -> system/init (conversation_id is the session id)
 *   step_update agent_response text_delta -> accumulated per step, assistant text on DONE
 *   step_update tool ACTIVE               -> assistant tool_use
 *   step_update tool DONE / ERROR         -> user tool_result
 *   result                                -> result
 *
 * agy does not stream its thinking text, only a token count, so there are no
 * thinking blocks. SIGINT makes agy end the turn with an "interrupted" result
 * and exit; the next message respawns it with `--conversation`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { ProcessAdapter, ProcessHandle, SpawnConfig } from '@liggi/agent-ui-harness/server';
import { createLogger } from '../services/infrastructure/logger.js';
import { parseJson } from '../utils/json.js';
import { agyModelArg, DEFAULT_ANTIGRAVITY_MODEL_ID } from '../constants/antigravity-models.js';
import { createStdoutQueue } from './stdout-queue.js';
import { parseAttachmentBlocks } from './attachment-blocks.js';
import { createHash } from 'node:crypto';

const logger = createLogger('AntigravityAdapter');

/** The installer puts `agy` in ~/.local/bin, which a launchd PATH often lacks. */
function agyBinary(): string {
  if (process.env.LATTICE_AGY_BIN) return process.env.LATTICE_AGY_BIN;
  const installed = path.join(os.homedir(), '.local', 'bin', 'agy');
  return fs.existsSync(installed) ? installed : 'agy';
}

function argValue(args: readonly string[] | undefined, prefix: string): string | undefined {
  const hit = args?.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function stringExtra(config: SpawnConfig, key: string): string | undefined {
  const value = config.extra?.[key];
  return typeof value === 'string' ? value : undefined;
}

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
}

const IMAGE_EXTENSION: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};

/**
 * agy's stream input takes text only, but the model opens an image file it is
 * pointed at. So an attached image is saved under `dir` and the prompt names
 * its path; attached text goes inline. Throws on an attachment agy cannot read.
 */
export function agyPromptWithAttachments(text: string, rawAttachments: unknown, dir: string): string {
  if (rawAttachments === undefined || rawAttachments === null) return text;
  const parsed = parseAttachmentBlocks(rawAttachments);
  if (!parsed.ok) throw new Error(parsed.error);
  const parts: string[] = [];
  let images = 0;
  for (const block of parsed.blocks) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'image' && block.source.type === 'base64') {
      const data = Buffer.from(block.source.data, 'base64');
      const name = `${createHash('sha256').update(data).digest('hex').slice(0, 16)}.${IMAGE_EXTENSION[block.source.media_type] ?? 'png'}`;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, data);
      images += 1;
      parts.push(`[Attached image ${images}: ${file} — open this file to see it before you answer.]`);
    } else {
      throw new Error('Antigravity in Lattice supports image and text attachments, but not PDF attachments');
    }
  }
  if (text.trim().length > 0) parts.push(text);
  return parts.join('\n\n');
}

function pick(params: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

/**
 * agy's tool call as the tool the chat already knows how to draw, so a command
 * shows its command and a file step its path. A tool with no counterpart keeps
 * agy's own name and parameters.
 */
export function agyToolUse(name: string, params: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  const filePath = pick(params, 'Path', 'AbsolutePath', 'TargetFile');
  switch (name) {
    case 'run_command': return { name: 'Bash', input: { command: pick(params, 'CommandLine', 'Command') } };
    case 'write_file': return { name: 'Write', input: { file_path: filePath } };
    case 'edit_file': return { name: 'Edit', input: { file_path: filePath } };
    case 'read_file': case 'view_file': return { name: 'Read', input: { file_path: filePath } };
    case 'grep': case 'grep_search':
      return { name: 'Grep', input: { pattern: pick(params, 'Query', 'Pattern'), path: pick(params, 'SearchPath', 'Path') } };
    case 'find_by_name':
      return { name: 'Glob', input: { pattern: pick(params, 'Pattern', 'Query'), path: pick(params, 'SearchPath', 'Path') } };
    case 'list_dir': case 'list_directory':
      return { name: 'LS', input: { path: pick(params, 'Path', 'DirectoryPath', 'SearchPath') || '.' } };
    case 'search_web': return { name: 'WebSearch', input: { query: pick(params, 'Query') } };
    case 'read_url_content': return { name: 'WebFetch', input: { url: pick(params, 'Url', 'URL') } };
    default: return { name, input: params };
  }
}

/** A command's output without agy's timestamp header; a failed command keeps its exit code. */
export function agyCommandOutput(output: string): string {
  const marker = 'Command output:\n';
  const at = output.indexOf(marker);
  if (!output.startsWith('Created At:') || at < 0) return output;
  const exit = /Command exited with code (\d+)\./.exec(output.slice(0, at));
  const body = output.slice(at + marker.length).replace(/\r\n/g, '\n');
  return exit && exit[1] !== '0' ? `Exit code ${exit[1]}\n${body}` : body;
}

/**
 * A reply cut where Gemini runs on into a turn it invented: a bare `user` role line
 * followed by the opening of one of agy's `<SYSTEM_MESSAGE>` injections.
 */
export function agyReplyText(text: string): string {
  const invented = /^user[ \t]*\r?\n\s*(?:The following is a <SYSTEM_MESSAGE>|<SYSTEM_MESSAGE>)/m.exec(text);
  return invented ? text.slice(0, invented.index).trim() : text;
}

export interface AntigravityCloudBilling {
  googleCloudProject?: string;
  googleCloudLocation?: string;
}

/** The environment that makes `agy` use gcloud's application-default login and bill a Cloud project. */
export function agyCloudEnv(billing: AntigravityCloudBilling | undefined): Record<string, string> {
  const project = billing?.googleCloudProject?.trim();
  if (!project) return {};
  return {
    AGY_ADC_AUTH: 'true',
    GOOGLE_CLOUD_PROJECT: project,
    GOOGLE_CLOUD_QUOTA_PROJECT: project,
    GOOGLE_CLOUD_LOCATION: billing?.googleCloudLocation?.trim() || 'global',
  };
}

/** agy's token counts in the shape the harness reads; agy's input count leaves out what it read from cache. */
export function agyCallUsage(usage: AgyUsage): { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number } {
  return {
    input_tokens: usage.input_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: usage.cache_read_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
  };
}

export class AntigravityProcessAdapter implements ProcessAdapter {
  readonly managedStreamingIds = new Set<string>();

  constructor(private readonly cloudBilling: () => AntigravityCloudBilling | undefined = () => undefined) {}

  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    const cwd = config.cwd ?? process.cwd();
    const model = agyModelArg(
      argValue(config.args, '--model=') ?? stringExtra(config, 'model') ?? DEFAULT_ANTIGRAVITY_MODEL_ID,
    );
    const resume = config.resume && !config.resume.startsWith('pending-') ? config.resume : undefined;

    const sessionId = stringExtra(config, 'sessionId') ?? 'session';
    const attachmentDir = path.join(os.tmpdir(), 'lattice-agy-attachments', sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
    const handle = new AntigravityProcessHandle({
      cwd, model, resume, attachmentDir, env: { ...agyCloudEnv(this.cloudBilling()), ...config.env },
    });
    await handle.start(agyPromptWithAttachments(config.prompt, config.extra?.attachments, attachmentDir));
    this.managedStreamingIds.add(handle.processId!);
    logger.info('agy session started', { processId: handle.processId, cwd, model, resumed: Boolean(resume) });
    return handle;
  }
}

interface HandleOptions {
  cwd: string;
  model?: string;
  resume?: string;
  attachmentDir: string;
  env?: Record<string, string>;
}

class AntigravityProcessHandle implements ProcessHandle {
  readonly stdout = createStdoutQueue();
  pid?: number;
  processId?: string;

  private child!: ChildProcessWithoutNullStreams;
  private aliveValue = true;
  private exitedResolve!: (value: { code: number; signal?: string }) => void;
  readonly exited = new Promise<{ code: number; signal?: string }>((resolve) => {
    this.exitedResolve = resolve;
  });

  private conversationId = '';
  private sentInit = false;
  /** Turns written to agy that have not reported a result yet; agy queues a prompt sent mid-turn. */
  private pendingTurns = 0;
  private turnStartedAt = 0;
  /** Text deltas of the agent_response steps still streaming, by step index. */
  private readonly textByStep = new Map<number, string>();
  /** Tool steps already announced as tool_use, so a DONE without ACTIVE still gets one. */
  private readonly announcedTools = new Set<number>();
  private stderrTail = '';
  /** The newest model call's token counts; its prompt size is the session's context size. */
  private lastCall: AgyUsage | null = null;
  /** The model calls of the turn in progress, added up. */
  private turn: Required<Omit<AgyUsage, 'thinking_tokens'>> = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };

  constructor(private readonly options: HandleOptions) {}

  get alive(): boolean {
    return this.aliveValue;
  }

  async start(prompt: string): Promise<void> {
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      ...(this.options.model ? ['--model', this.options.model] : []),
      ...(this.options.resume ? ['--conversation', this.options.resume] : []),
      // Print mode with the prompts arriving on stdin; `-p` alone would take the next flag as its prompt.
      '-p=',
    ];
    this.child = spawn(agyBinary(), args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid;
    if (this.options.resume) this.conversationId = this.options.resume;
    this.processId = `agy-${this.child.pid ?? Date.now()}`;

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
    });
    this.child.on('error', (err) => {
      logger.error('agy failed to start', { error: String(err) });
      this.emitError(`Antigravity CLI failed to start: ${String(err)}`);
      this.close(1);
    });
    this.child.on('exit', (code, signal) => {
      if (this.pendingTurns > 0) {
        logger.warn('agy exited mid-turn', { code, signal, stderr: this.stderrTail });
        this.emitError(this.stderrTail.trim() || `Antigravity CLI exited (${signal ?? code})`);
      }
      this.close(code ?? 1, signal ?? undefined);
    });

    this.sendPrompt(prompt);
  }

  write(input: string, extra?: Record<string, unknown>): void {
    // Synchronous, so an attachment agy cannot read fails the send visibly.
    this.sendPrompt(agyPromptWithAttachments(input.replace(/\n$/, ''), extra?.attachments, this.options.attachmentDir));
  }

  signal(sig: NodeJS.Signals): void {
    if (!this.aliveValue) return;
    this.child.kill(sig);
  }

  private sendPrompt(text: string): void {
    if (!this.aliveValue) return;
    if (this.pendingTurns === 0) this.turnStartedAt = Date.now();
    this.pendingTurns += 1;
    this.child.stdin.write(JSON.stringify({
      event: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n');
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = parseJson(line) as Record<string, unknown>;
    } catch {
      logger.warn('agy wrote a non-JSON line', { line: line.slice(0, 200) });
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (typeof event.conversation_id === 'string' && event.conversation_id) {
      this.conversationId = event.conversation_id;
    }

    switch (event.event) {
      case 'init': {
        const init = (event.init ?? {}) as Record<string, unknown>;
        this.emitInit(Array.isArray(init.tools) ? init.tools.map(String) : []);
        break;
      }
      case 'step_update':
        this.handleStep((event.step_update ?? {}) as Record<string, unknown>);
        break;
      case 'result':
        this.handleResult((event.result ?? {}) as Record<string, unknown>);
        break;
      default:
        break;
    }
  }

  private handleStep(step: Record<string, unknown>): void {
    if (typeof step.conversation_id === 'string' && step.conversation_id) {
      this.conversationId = step.conversation_id;
    }
    if (!this.sentInit) this.emitInit([]);
    const index = typeof step.step_index === 'number' ? step.step_index : -1;
    const state = String(step.state ?? '');
    const finished = state !== 'ACTIVE';

    // A finished model step reports that one call; agy's result adds up the whole session.
    // A checkpoint (agy condensing its history) is a call too, but not the size of the next prompt.
    if (finished && step.usage && typeof step.usage === 'object' && (step.step_type === 'agent_response' || step.step_type === 'checkpoint')) {
      const usage = step.usage as AgyUsage;
      if (step.step_type === 'agent_response') this.lastCall = usage;
      this.turn.input_tokens += usage.input_tokens ?? 0;
      this.turn.output_tokens += usage.output_tokens ?? 0;
      this.turn.cache_read_tokens += usage.cache_read_tokens ?? 0;
    }

    if (step.step_type === 'agent_response') {
      if (typeof step.text_delta === 'string') {
        this.textByStep.set(index, (this.textByStep.get(index) ?? '') + step.text_delta);
      }
      if (finished) {
        const text = agyReplyText((this.textByStep.get(index) ?? '').trim());
        this.textByStep.delete(index);
        if (text) this.emitAssistant({ type: 'text', text }, `agy-text-${index}`);
      }
      return;
    }

    if (step.step_type === 'tool') {
      const info = (step.tool_info ?? {}) as Record<string, unknown>;
      const name = String(step.tool_name ?? info.name ?? 'tool');
      const id = `agy-${this.conversationId}-${index}`;
      if (!this.announcedTools.has(index)) {
        this.announcedTools.add(index);
        const params = (info.parameters && typeof info.parameters === 'object' ? info.parameters : {}) as Record<string, unknown>;
        this.emitAssistant({ type: 'tool_use', id, ...agyToolUse(name, params) }, `agy-tool-${index}`);
      }
      if (finished) {
        this.announcedTools.delete(index);
        const output = typeof info.output === 'string' ? info.output
          : info.output !== undefined ? JSON.stringify(info.output)
          : typeof step.error === 'string' ? step.error : '';
        this.emitToolResult(id, name === 'run_command' ? agyCommandOutput(output) : output, state !== 'DONE');
      }
    }
  }

  private handleResult(result: Record<string, unknown>): void {
    // agy reports a shutdown as an error result even when no turn is running.
    if (this.pendingTurns === 0) return;
    // Flush text from a step that never reported DONE, so nothing is lost.
    for (const [index, raw] of this.textByStep) {
      const text = agyReplyText(raw.trim());
      if (text) this.emitAssistant({ type: 'text', text }, `agy-text-${index}`);
    }
    this.textByStep.clear();
    const ok = result.status === 'SUCCESS';
    if (!ok && typeof result.error === 'string' && result.error && result.error !== 'interrupted') {
      this.emitAssistant({ type: 'text', text: `Antigravity error: ${result.error}` }, `agy-error-${Date.now()}`);
    }
    this.emitResult(!ok, ok ? 'success' : 'error_during_execution', this.turn);
    this.turn = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
  }

  private emitInit(tools: string[]): void {
    if (this.sentInit) return;
    this.sentInit = true;
    this.stdout.push(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: this.conversationId,
      cwd: this.options.cwd,
      tools,
      mcp_servers: [],
      model: this.options.model ? `agy:${this.options.model}` : DEFAULT_ANTIGRAVITY_MODEL_ID,
      permissionMode: 'antigravity-managed',
      apiKeySource: 'antigravity',
      provider: 'antigravity',
    }));
  }

  private emitAssistant(block: Record<string, unknown>, id: string): void {
    this.stdout.push(JSON.stringify({
      type: 'assistant',
      session_id: this.conversationId,
      message: {
        id, type: 'message', role: 'assistant', content: [block],
        model: this.options.model ? `agy:${this.options.model}` : DEFAULT_ANTIGRAVITY_MODEL_ID,
        ...(this.lastCall ? { usage: agyCallUsage(this.lastCall) } : {}),
      },
      provider: 'antigravity',
    }));
  }

  private emitToolResult(id: string, content: string, isError: boolean): void {
    this.stdout.push(JSON.stringify({
      type: 'user',
      session_id: this.conversationId,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
      },
      provider: 'antigravity',
    }));
  }

  private emitError(message: string): void {
    if (this.pendingTurns === 0) return;
    if (!this.sentInit) this.emitInit([]);
    this.emitAssistant({ type: 'text', text: message }, `agy-error-${Date.now()}`);
    // The process is gone, so every turn still waiting on it ends here.
    while (this.pendingTurns > 0) this.emitResult(true, 'error_during_execution', {});
  }

  private emitResult(isError: boolean, subtype: string, usage: AgyUsage): void {
    if (this.pendingTurns === 0) return;
    this.pendingTurns -= 1;
    const duration = this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
    this.turnStartedAt = Date.now();
    this.stdout.push(JSON.stringify({
      type: 'result',
      subtype,
      is_error: isError,
      duration_ms: duration,
      duration_api_ms: duration,
      num_turns: 1,
      session_id: this.conversationId,
      usage: { ...agyCallUsage(usage), server_tool_use: { web_search_requests: 0 } },
      provider: 'antigravity',
    }));
  }

  private close(code: number, signal?: string): void {
    if (!this.aliveValue) return;
    this.aliveValue = false;
    this.stdout.terminate();
    this.exitedResolve({ code, ...(signal ? { signal } : {}) });
  }
}
