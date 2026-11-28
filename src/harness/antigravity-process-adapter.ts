/**
 * Antigravity CLI (`agy`) provider adapter.
 *
 * Runs one long-lived `agy acp` process per Lattice conversation and speaks
 * the Agent Client Protocol to it over stdio: `session/new` or
 * `session/resume` (agy's conversation id), then one `session/prompt` per
 * input. This adapter translates agy's `session/update` notifications into the
 * Claude-CLI-shaped JSONL the harness consumes.
 *
 * Update mapping (agy -> emitted line):
 *   agent_thought_chunk                 -> assistant thinking, when the thought ends
 *   agent_message_chunk                 -> assistant text, when the reply segment ends
 *   tool_call / tool_call_update        -> assistant tool_use, then user tool_result once completed or failed
 *   usage_update                        -> the context size on each message; a sharp drop is a compact boundary
 *   session/prompt answered, none left  -> result
 *
 * A prompt sent while a turn runs steers it (agy reads it after its current
 * step), which is what `steer()` uses. SIGINT sends `session/cancel` and agy
 * stays up for the next input.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { ProcessAdapter, ProcessHandle, SpawnConfig, SteerOutcome, SteerRequest } from '@liggi/agent-ui-harness/server';
import { createLogger } from '../services/infrastructure/logger.js';
import { parseJson } from '../utils/json.js';
import { agyModelArg, DEFAULT_ANTIGRAVITY_MODEL_ID } from '../constants/antigravity-models.js';
import { createStdoutQueue } from './stdout-queue.js';
import { parseAttachmentBlocks } from './attachment-blocks.js';
import { createHash, randomUUID } from 'node:crypto';

const logger = createLogger('AntigravityAdapter');

/** The installer puts `agy` in ~/.local/bin, which a launchd PATH often lacks. */
export function agyBinary(): string {
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
 * followed by the opening of one of agy's `<SYSTEM_MESSAGE>` or `<USER_REQUEST>` wrappers.
 */
export function agyReplyText(text: string): string {
  const invented = /^user[ \t]*\r?\n\s*(?:The following is a <SYSTEM_MESSAGE>|<SYSTEM_MESSAGE>|<USER_REQUEST>)/m.exec(text);
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

interface RpcError { code?: number; message?: string }

/** How one `session/prompt` call ended. */
type PromptEnd = { ok: true; stopReason: string } | { ok: false; error: string };

/** How long `steer()` waits for agy to show it took the input before answering `uncertain`. */
const STEER_ACK_TIMEOUT_MS = 15_000;

/** A context that falls below this share of the previous call's means agy condensed its history. */
const COMPACTION_DROP_RATIO = 0.7;

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

  private sessionId = '';
  private sentInit = false;
  /** initialize, then session/new or session/resume, then the model: every prompt waits on it. */
  private ready: Promise<void> = Promise.resolve();
  private nextRpcId = 0;
  private readonly rpcWaiters = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  /**
   * One Lattice turn can span several prompts: a prompt sent while a turn runs
   * steers it, agy answers the earlier prompt at once, and the turn ends only
   * when no prompt is left unanswered.
   */
  private turnOpen = false;
  private unansweredPrompts = 0;
  /** The newest prompt's outcome, which a steer waits on to see its own input taken. */
  private latestPrompt: Promise<PromptEnd> = Promise.resolve({ ok: true, stopReason: 'end_turn' });
  private turnStartedAt = 0;
  private turn: Required<Omit<AgyUsage, 'thinking_tokens'>> = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };

  private text = '';
  private thought = '';
  private segment = 0;
  /** Per-handle nonce so a respawned agy process never reuses earlier runs' message ids. */
  private readonly runNonce = randomUUID().slice(0, 8);
  /** Tool calls already announced as tool_use, so an update without the first event still gets one. */
  private readonly announcedTools = new Set<string>();
  /** The context size at the newest model call, from agy's usage_update. */
  private contextUsed: number | null = null;
  private stderrTail = '';

  constructor(private readonly options: HandleOptions) {}

  get alive(): boolean {
    return this.aliveValue;
  }

  async start(prompt: string): Promise<void> {
    this.child = spawn(agyBinary(), ['acp', '--dangerously-skip-permissions'], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid;
    this.processId = `agy-${this.child.pid ?? Date.now()}`;

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
    });
    this.child.stdin.on('error', (err) => logger.warn('agy stdin closed', { error: String(err) }));
    this.child.on('error', (err) => {
      logger.error('agy failed to start', { error: String(err) });
      this.emitError(`Antigravity CLI failed to start: ${String(err)}`);
      this.close(1);
    });
    this.child.on('exit', (code, signal) => {
      if (this.turnOpen) {
        logger.warn('agy exited mid-turn', { code, signal, stderr: this.stderrTail });
        this.emitError(this.stderrTail.trim() || `Antigravity CLI exited (${signal ?? code})`);
      }
      for (const waiter of this.rpcWaiters.values()) waiter.reject(new Error('Antigravity CLI exited'));
      this.rpcWaiters.clear();
      this.close(code ?? 1, signal ?? undefined);
    });

    this.ready = this.openSession();
    this.ready.catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('agy session setup failed', { error: message, stderr: this.stderrTail });
      this.emitError(`Antigravity session could not start: ${message}`);
      this.child.kill('SIGTERM');
    });
    void this.sendPrompt(prompt);
  }

  private async openSession(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const session = { cwd: this.options.cwd, mcpServers: [] };
    if (this.options.resume) {
      await this.rpc('session/resume', { sessionId: this.options.resume, ...session });
      this.sessionId = this.options.resume;
    } else {
      const created = await this.rpc('session/new', session) as { sessionId?: unknown };
      if (typeof created?.sessionId !== 'string' || !created.sessionId) throw new Error('session/new returned no session id');
      this.sessionId = created.sessionId;
    }
    if (this.options.model) await this.rpc('session/set_model', { sessionId: this.sessionId, modelId: this.options.model });
    this.emitInit();
  }

  write(input: string, extra?: Record<string, unknown>): void {
    // Synchronous, so an attachment agy cannot read fails the send visibly.
    void this.sendPrompt(agyPromptWithAttachments(input.replace(/\n$/, ''), extra?.attachments, this.options.attachmentDir));
  }

  /**
   * Deliver into the running turn by sending another prompt, which agy's ACP
   * server takes as steering: the agent reads it after its current step, and
   * agy answers the prompt it was running straight away. That answer is the
   * acknowledgement, and it is also the incorporation, since the turn has
   * now been handed to the new prompt.
   */
  async steer(request: SteerRequest): Promise<SteerOutcome> {
    if (!this.aliveValue) return { status: 'rejected', reason: 'Antigravity CLI is not running' };
    if (!this.turnOpen || this.unansweredPrompts === 0) return { status: 'rejected', reason: 'Antigravity has no running turn to steer' };
    let text: string;
    try {
      text = agyPromptWithAttachments(request.input.replace(/\n$/, ''), request.extra?.attachments, this.options.attachmentDir);
    } catch (err) {
      return { status: 'rejected', reason: err instanceof Error ? err.message : String(err) };
    }
    if (!text.trim()) return { status: 'rejected', reason: 'Nothing to steer with' };

    const previous = this.latestPrompt;
    request.onStage?.({ kind: 'handed-over' });
    const mine = this.sendPrompt(text);

    type Seen = { kind: 'taken' } | { kind: 'refused'; error: string } | { kind: 'timeout' } | { kind: 'exited' };
    let timer: NodeJS.Timeout | undefined;
    const taken: Promise<Seen> = Promise.race([
      previous.then((): Seen => ({ kind: 'taken' })),
      mine.then((end): Seen => (end.ok ? { kind: 'taken' } : { kind: 'refused', error: end.error })),
      this.exited.then((): Seen => ({ kind: 'exited' })),
    ]);
    const seen = await Promise.race([
      taken,
      new Promise<Seen>((resolve) => { timer = setTimeout(() => resolve({ kind: 'timeout' }), STEER_ACK_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);

    const detail = { sessionId: this.sessionId, deliveryId: request.deliveryId };
    const incorporated = (): void => request.onStage?.({
      kind: 'incorporated',
      where: 'mid-turn',
      evidence: 'agy answered the prompt it was running and went on with this one',
    });
    switch (seen.kind) {
      case 'taken':
        request.onStage?.({ kind: 'accepted', late: false, detail });
        incorporated();
        return { status: 'accepted', detail };
      case 'refused':
        return { status: 'rejected', reason: seen.error };
      case 'exited':
        return { status: 'uncertain', reason: 'Antigravity CLI exited before it acknowledged the input' };
      case 'timeout':
        void taken.then((late) => {
          if (late.kind !== 'taken') return;
          request.onStage?.({ kind: 'accepted', late: true, detail });
          incorporated();
        });
        return { status: 'uncertain', reason: `agy did not take the input within ${STEER_ACK_TIMEOUT_MS / 1000}s` };
    }
  }

  /** SIGINT cancels the running turn and leaves agy up for the next one; any other signal stops it. */
  signal(sig: NodeJS.Signals): void {
    if (!this.aliveValue) return;
    if (sig === 'SIGINT') {
      if (this.turnOpen && this.sessionId) this.notify('session/cancel', { sessionId: this.sessionId });
      return;
    }
    this.child.kill(sig);
  }

  private sendPrompt(text: string): Promise<PromptEnd> {
    if (!this.aliveValue) return Promise.resolve({ ok: false, error: 'Antigravity CLI is not running' });
    if (!this.turnOpen) {
      this.turnOpen = true;
      this.turnStartedAt = Date.now();
    }
    this.unansweredPrompts += 1;
    const end = this.ready
      .then(() => this.rpc('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }))
      .then((result): PromptEnd => {
        const r = (result ?? {}) as { stopReason?: unknown; usage?: Record<string, unknown> };
        this.addUsage(r.usage);
        return { ok: true, stopReason: typeof r.stopReason === 'string' ? r.stopReason : 'end_turn' };
      }, (err): PromptEnd => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    void end.then((outcome) => this.promptAnswered(outcome));
    this.latestPrompt = end;
    return end;
  }

  private promptAnswered(end: PromptEnd): void {
    if (this.unansweredPrompts > 0) this.unansweredPrompts -= 1;
    // A failed setup or an exit has already ended the turn with its own error.
    if (!this.turnOpen) return;
    if (!end.ok) {
      this.flush();
      this.emitAssistant({ type: 'text', text: `Antigravity error: ${end.error}` }, `agy-error-${Date.now()}`);
    } else if (end.stopReason !== 'end_turn' && end.stopReason !== 'cancelled') {
      this.flush();
      this.emitAssistant({ type: 'text', text: `Antigravity stopped the turn: ${end.stopReason}` }, `agy-stop-${Date.now()}`);
    }
    // A steered turn goes on under the newer prompt.
    if (this.unansweredPrompts > 0) return;
    this.flush();
    const ok = end.ok && end.stopReason === 'end_turn';
    this.emitResult(!ok, ok ? 'success' : 'error_during_execution');
  }

  private addUsage(usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    const n = (key: string): number => (typeof usage[key] === 'number' ? usage[key] as number : 0);
    // agy's inputTokens leaves out what it read from cache, as the print-mode counts did.
    this.turn.input_tokens += n('inputTokens');
    this.turn.output_tokens += n('outputTokens');
    this.turn.cache_read_tokens += n('cachedReadTokens');
  }

  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.aliveValue) return Promise.reject(new Error('Antigravity CLI is not running'));
    const id = ++this.nextRpcId;
    return new Promise((resolve, reject) => {
      this.rpcWaiters.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private reply(id: unknown, body: { result: unknown } | { error: RpcError }): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n');
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = parseJson(line) as Record<string, unknown>;
    } catch {
      logger.warn('agy wrote a non-JSON line', { line: line.slice(0, 200) });
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (typeof msg.method !== 'string') {
      const waiter = typeof msg.id === 'number' ? this.rpcWaiters.get(msg.id) : undefined;
      if (!waiter) return;
      this.rpcWaiters.delete(msg.id as number);
      if (msg.error) waiter.reject(new Error((msg.error as RpcError).message ?? JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
      return;
    }

    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (msg.method === 'session/update') {
      this.handleUpdate((params.update ?? {}) as Record<string, unknown>);
      return;
    }
    if (msg.id === undefined) return;
    if (msg.method === 'session/request_permission') {
      // agy runs with --dangerously-skip-permissions, so this should not come; if it does, allow as print mode did.
      const options = Array.isArray(params.options) ? params.options as Array<Record<string, unknown>> : [];
      const allow = options.find((o) => o.kind === 'allow_always') ?? options.find((o) => o.kind === 'allow_once') ?? options[0];
      this.reply(msg.id, allow
        ? { result: { outcome: { outcome: 'selected', optionId: allow.optionId } } }
        : { result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    this.reply(msg.id, { error: { code: -32601, message: `Lattice does not handle ${msg.method}` } });
  }

  private handleUpdate(update: Record<string, unknown>): void {
    const content = (update.content ?? {}) as Record<string, unknown>;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (this.thought) this.flush();
        if (typeof content.text === 'string') this.text += content.text;
        return;
      case 'agent_thought_chunk':
        if (this.text) this.flush();
        if (typeof content.text === 'string') this.thought += content.text;
        return;
      case 'tool_call':
      case 'tool_call_update':
        this.flush();
        this.handleTool(update);
        return;
      case 'usage_update':
        this.handleContextSize(update.used);
        return;
      default:
        return;
    }
  }

  private handleTool(update: Record<string, unknown>): void {
    const callId = typeof update.toolCallId === 'string' ? update.toolCallId : `call-${this.runNonce}-${this.segment}`;
    const id = `agy-${this.sessionId}-${callId}`;
    const name = typeof update.name === 'string' && update.name ? update.name : 'tool';
    if (!this.announcedTools.has(callId)) {
      this.announcedTools.add(callId);
      const raw = update.args ?? update.rawInput;
      const params = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      this.emitAssistant({ type: 'tool_use', id, ...agyToolUse(name, params) }, `agy-tool-${callId}`);
    }
    const status = update.status;
    if (status !== 'completed' && status !== 'failed') return;
    this.announcedTools.delete(callId);
    const rawOutput = (update.rawOutput ?? {}) as Record<string, unknown>;
    const contentText = Array.isArray(update.content)
      ? (update.content as Array<Record<string, unknown>>)
        .map((c) => ((c.content ?? {}) as Record<string, unknown>).text)
        .filter((t): t is string => typeof t === 'string')
        .join('\n')
      : '';
    const output = typeof rawOutput.output === 'string' ? rawOutput.output : contentText;
    this.emitToolResult(id, name === 'run_command' ? agyCommandOutput(output) : output, status === 'failed');
  }

  /**
   * agy's ACP server says nothing when it condenses its history, but the next
   * call's context is then much smaller than the one before, which no other
   * step does. That drop is marked as a compaction.
   */
  private handleContextSize(used: unknown): void {
    if (typeof used !== 'number' || used <= 0) return;
    const before = this.contextUsed;
    this.contextUsed = used;
    if (before !== null && used < before * COMPACTION_DROP_RATIO) {
      this.stdout.push(JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: this.sessionId,
        // The size after is what the composer's context count shows; without it the count hides until the next reply.
        compact_metadata: { pre_tokens: before, post_tokens: used },
        provider: 'antigravity',
      }));
    }
  }

  /** Thinking or text gathered from chunks becomes one message when something else starts. */
  private flush(): void {
    if (this.thought.trim()) {
      this.emitAssistant({ type: 'thinking', thinking: this.thought.trim() }, `agy-thought-${this.runNonce}-${this.segment++}`);
    }
    this.thought = '';
    const text = agyReplyText(this.text.trim());
    if (text) this.emitAssistant({ type: 'text', text }, `agy-text-${this.runNonce}-${this.segment++}`);
    this.text = '';
  }

  private emitInit(): void {
    if (this.sentInit) return;
    this.sentInit = true;
    this.stdout.push(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      cwd: this.options.cwd,
      tools: [],
      mcp_servers: [],
      model: this.options.model ? `agy:${this.options.model}` : DEFAULT_ANTIGRAVITY_MODEL_ID,
      permissionMode: 'antigravity-managed',
      apiKeySource: 'antigravity',
      provider: 'antigravity',
    }));
  }

  private emitAssistant(block: Record<string, unknown>, id: string): void {
    if (!this.sentInit) this.emitInit();
    this.stdout.push(JSON.stringify({
      type: 'assistant',
      session_id: this.sessionId,
      message: {
        id, type: 'message', role: 'assistant', content: [block],
        model: this.options.model ? `agy:${this.options.model}` : DEFAULT_ANTIGRAVITY_MODEL_ID,
        ...(this.contextUsed !== null ? { usage: agyCallUsage({ input_tokens: this.contextUsed }) } : {}),
      },
      provider: 'antigravity',
    }));
  }

  private emitToolResult(id: string, content: string, isError: boolean): void {
    this.stdout.push(JSON.stringify({
      type: 'user',
      session_id: this.sessionId,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
      },
      provider: 'antigravity',
    }));
  }

  private emitError(message: string): void {
    if (!this.turnOpen) return;
    this.flush();
    this.emitAssistant({ type: 'text', text: message }, `agy-error-${Date.now()}`);
    this.emitResult(true, 'error_during_execution');
  }

  private emitResult(isError: boolean, subtype: string): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    const duration = this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
    this.stdout.push(JSON.stringify({
      type: 'result',
      subtype,
      is_error: isError,
      duration_ms: duration,
      duration_api_ms: duration,
      num_turns: 1,
      session_id: this.sessionId,
      usage: { ...agyCallUsage(this.turn), server_tool_use: { web_search_requests: 0 } },
      provider: 'antigravity',
    }));
    this.turn = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
  }

  private close(code: number, signal?: string): void {
    if (!this.aliveValue) return;
    this.aliveValue = false;
    this.stdout.terminate();
    this.exitedResolve({ code, ...(signal ? { signal } : {}) });
  }
}
