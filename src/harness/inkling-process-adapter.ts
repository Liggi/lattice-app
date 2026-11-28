/**
 * Inkling provider adapter.
 *
 * Runs one `inkling acp` process per Lattice conversation and speaks the
 * Agent Client Protocol to it over stdio: `session/new` or `session/resume`
 * (Inkling's saved session id), then one `session/prompt` per input. Inkling
 * is a local model behind a llama-server, so there is no sign-in and no model
 * to switch.
 *
 * Update mapping (inkling -> emitted line):
 *   agent_thought_chunk                 -> assistant thinking, when the thought ends
 *   agent_message_chunk                 -> assistant text, when the reply segment ends
 *   tool_call                           -> assistant tool_use, drawn as the matching Claude tool
 *   tool_call_update (completed/failed) -> user tool_result
 *   usage_update                        -> the context size on later messages
 *   session/prompt answered, none left  -> result
 *
 * Inkling always runs in its ask mode, and every side-effecting tool call
 * arrives as `session/request_permission`. The permission bridge decides it
 * from the conversation's Lattice permission mode, its allowlists, or an
 * approval card, so a mode change applies to the very next tool call.
 * SIGINT sends `session/cancel`; Inkling kills any running command and stays
 * up for the next input.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { ProcessAdapter, ProcessHandle, SpawnConfig } from '@liggi/agent-ui-harness/server';
import { createLogger } from '../services/infrastructure/logger.js';
import { parseJson } from '../utils/json.js';
import { DEFAULT_INKLING_MODEL_ID } from '../constants/inkling-models.js';
import { createStdoutQueue } from './stdout-queue.js';
import { parseAttachmentBlocks } from './attachment-blocks.js';

const logger = createLogger('InklingAdapter');

/** `uv tool install` puts `inkling` in ~/.local/bin, which a launchd PATH often lacks. */
export function inklingBinary(pathValue: string | undefined = process.env.PATH): string | null {
  if (process.env.LATTICE_INKLING_BIN) return process.env.LATTICE_INKLING_BIN;
  for (const dir of [...(pathValue ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')]) {
    if (!dir) continue;
    const candidate = path.join(dir, 'inkling');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function inklingInstalled(pathValue?: string): boolean {
  return inklingBinary(pathValue) !== null;
}

/** The llama-server `inkling` talks to, as `inkling acp` resolves it. */
export function inklingBaseUrl(): string {
  return (process.env.INKLING_BASE_URL || 'http://127.0.0.1:8670').replace(/\/$/, '');
}

export interface InklingStatus {
  installed: boolean;
  /** Whether the local model server answered its health check. */
  serverReachable: boolean;
  baseUrl: string;
}

export async function inklingStatus(): Promise<InklingStatus> {
  const baseUrl = inklingBaseUrl();
  const installed = inklingInstalled();
  let serverReachable = false;
  if (installed) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      serverReachable = response.ok;
    } catch {
      serverReachable = false;
    }
  }
  return { installed, serverReachable, baseUrl };
}

/** What one approval request resolves to. */
export type InklingApproval = { allow: true } | { allow: false; feedback?: string };

export interface InklingApprovalRequest {
  conversationId: string;
  streamingId: string;
  /** The tool as Lattice names it (Bash, Write, Edit), so allowlist patterns and the card read as for Claude. */
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Inkling's own preview of the call: the command and folder, or the diff. */
  preview: string;
}

/** Decides Inkling's approval requests; the server wires it to the permission tracker. */
export interface InklingPermissionBridge {
  decide(request: InklingApprovalRequest): Promise<InklingApproval>;
  /** Withdraw every undecided card of this process: its turn ended or it exited. */
  withdraw(streamingId: string): void;
}

/** Without a bridge, side-effecting tools are refused rather than run unasked. */
export const DENY_ALL_BRIDGE: InklingPermissionBridge = {
  decide: async () => ({ allow: false, feedback: 'Lattice could not ask the user for approval.' }),
  withdraw: () => {},
};

function resolvePath(cwd: string, value: unknown): string {
  if (typeof value !== 'string' || !value) return cwd;
  const expanded = value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value;
  return path.resolve(cwd, expanded);
}

function defined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== ''));
}

/**
 * Inkling's tool call as the tool the chat already knows how to draw, so a
 * command shows its command and a file step its path. A tool with no
 * counterpart keeps Inkling's own name and arguments.
 */
export function inklingToolUse(name: string, args: Record<string, unknown>, cwd: string): { name: string; input: Record<string, unknown> } {
  switch (name) {
    case 'run_shell':
      return { name: 'Bash', input: defined({ command: args.command, timeout: typeof args.timeout === 'number' ? args.timeout * 1000 : undefined }) };
    case 'read_file':
      return { name: 'Read', input: defined({ file_path: resolvePath(cwd, args.path), offset: args.offset, limit: args.limit }) };
    case 'write_file':
      return { name: 'Write', input: { file_path: resolvePath(cwd, args.path), content: typeof args.content === 'string' ? args.content : '' } };
    case 'edit_file':
      return { name: 'Edit', input: defined({ file_path: resolvePath(cwd, args.path), old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all }) };
    case 'list_files':
      return { name: 'LS', input: { path: resolvePath(cwd, args.path) } };
    case 'search_files':
      return { name: 'Grep', input: defined({ pattern: args.pattern, path: typeof args.path === 'string' ? resolvePath(cwd, args.path) : undefined, glob: args.glob }) };
    case 'web_search':
      return { name: 'WebSearch', input: { query: typeof args.query === 'string' ? args.query : '' } };
    case 'fetch_url':
      return { name: 'WebFetch', input: { url: typeof args.url === 'string' ? args.url : '' } };
    default:
      return { name, input: args };
  }
}

/**
 * Inkling reads text only: attached text goes inline and an image or PDF is
 * refused, since the model has no vision. Throws on an attachment it cannot read.
 */
export function inklingPromptWithAttachments(text: string, rawAttachments: unknown): string {
  if (rawAttachments === undefined || rawAttachments === null) return text;
  const parsed = parseAttachmentBlocks(rawAttachments);
  if (!parsed.ok) throw new Error(parsed.error);
  const parts: string[] = [];
  for (const block of parsed.blocks) {
    if (block.type !== 'text') throw new Error('Inkling reads text only: it cannot open images or PDFs');
    parts.push(block.text);
  }
  if (text.trim().length > 0) parts.push(text);
  return parts.join('\n\n');
}

function stringExtra(config: SpawnConfig, key: string): string | undefined {
  const value = config.extra?.[key];
  return typeof value === 'string' ? value : undefined;
}

export class InklingProcessAdapter implements ProcessAdapter {
  readonly managedStreamingIds = new Set<string>();

  constructor(private readonly bridge: () => InklingPermissionBridge = () => DENY_ALL_BRIDGE) {}

  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    const binary = inklingBinary();
    if (!binary) throw new Error('Inkling is not installed: no `inkling` on PATH or in ~/.local/bin');
    const cwd = config.cwd ?? process.cwd();
    const resume = config.resume && !config.resume.startsWith('pending-') ? config.resume : undefined;
    const handle = new InklingProcessHandle({
      binary,
      cwd,
      resume,
      conversationId: stringExtra(config, 'sessionId') ?? '',
      bridge: this.bridge(),
      env: config.env,
    });
    await handle.start(inklingPromptWithAttachments(config.prompt, config.extra?.attachments));
    this.managedStreamingIds.add(handle.processId!);
    logger.info('inkling session started', { processId: handle.processId, cwd, resumed: Boolean(resume) });
    return handle;
  }
}

interface HandleOptions {
  binary: string;
  cwd: string;
  resume?: string;
  conversationId: string;
  bridge: InklingPermissionBridge;
  env?: Record<string, string>;
}

interface RpcError { code?: number; message?: string }

type PromptEnd = { ok: true; stopReason: string } | { ok: false; error: string };

interface TurnUsage { input_tokens: number; output_tokens: number; cache_read_tokens: number }

class InklingProcessHandle implements ProcessHandle {
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
  private ready: Promise<void> = Promise.resolve();
  private nextRpcId = 0;
  private readonly rpcWaiters = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  /** Inkling queues a prompt sent while a turn runs; the Lattice turn ends when none is left unanswered. */
  private turnOpen = false;
  private unansweredPrompts = 0;
  private turnStartedAt = 0;
  private turn: TurnUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };

  private text = '';
  private thought = '';
  private segment = 0;
  /** Message ids must stay unique across the processes one conversation runs in. */
  private readonly idPrefix = `inkling-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  private contextUsed: number | null = null;
  /** Tool calls shown without a result yet; a cancelled turn closes them so none is left spinning. */
  private readonly openTools = new Set<string>();
  private stderrTail = '';

  constructor(private readonly options: HandleOptions) {}

  get alive(): boolean {
    return this.aliveValue;
  }

  async start(prompt: string): Promise<void> {
    this.child = spawn(this.options.binary, ['acp', '--mode', 'ask'], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid;
    this.processId = `inkling-${this.child.pid ?? Date.now()}`;

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
    });
    this.child.stdin.on('error', (err) => logger.warn('inkling stdin closed', { error: String(err) }));
    this.child.on('error', (err) => {
      logger.error('inkling failed to start', { error: String(err) });
      this.emitError(`Inkling failed to start: ${String(err)}`);
      this.close(1);
    });
    this.child.on('exit', (code, signal) => {
      if (this.turnOpen) {
        logger.warn('inkling exited mid-turn', { code, signal, stderr: this.stderrTail });
        this.emitError(this.stderrTail.trim() || `Inkling exited (${signal ?? code})`);
      }
      for (const waiter of this.rpcWaiters.values()) waiter.reject(new Error('Inkling exited'));
      this.rpcWaiters.clear();
      if (this.processId) this.options.bridge.withdraw(this.processId);
      this.close(code ?? 1, signal ?? undefined);
    });

    this.ready = this.openSession();
    this.ready.catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('inkling session setup failed', { error: message, stderr: this.stderrTail });
      this.emitError(`Inkling session could not start: ${message}`);
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
    this.emitInit();
  }

  write(input: string, extra?: Record<string, unknown>): void {
    // Synchronous, so an attachment Inkling cannot read fails the send visibly.
    void this.sendPrompt(inklingPromptWithAttachments(input.replace(/\n$/, ''), extra?.attachments));
  }

  /** SIGINT cancels the running turn and leaves Inkling up for the next one; any other signal stops it. */
  signal(sig: NodeJS.Signals): void {
    if (!this.aliveValue) return;
    if (sig === 'SIGINT') {
      if (this.turnOpen && this.sessionId) this.notify('session/cancel', { sessionId: this.sessionId });
      return;
    }
    this.child.kill(sig);
  }

  private sendPrompt(text: string): Promise<PromptEnd> {
    if (!this.aliveValue) return Promise.resolve({ ok: false, error: 'Inkling is not running' });
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
    return end;
  }

  private promptAnswered(end: PromptEnd): void {
    if (this.unansweredPrompts > 0) this.unansweredPrompts -= 1;
    if (!this.turnOpen) return;
    if (!end.ok) {
      this.flush();
      this.emitAssistant({ type: 'text', text: `Inkling error: ${end.error}` }, `${this.idPrefix}-error-${this.segment++}`);
    } else if (end.stopReason !== 'end_turn' && end.stopReason !== 'cancelled') {
      this.flush();
      this.emitAssistant({ type: 'text', text: `Inkling stopped the turn: ${stopReasonText(end.stopReason)}` }, `${this.idPrefix}-stop-${this.segment++}`);
    }
    if (this.unansweredPrompts > 0) return;
    this.flush();
    this.closeOpenTools();
    if (this.processId) this.options.bridge.withdraw(this.processId);
    const ok = end.ok && end.stopReason !== 'cancelled' && end.stopReason !== 'refusal';
    this.emitResult(!ok, ok ? 'success' : 'error_during_execution');
  }

  private addUsage(usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    const n = (key: string): number => (typeof usage[key] === 'number' ? usage[key] as number : 0);
    this.turn.input_tokens += n('inputTokens');
    this.turn.output_tokens += n('outputTokens');
    this.turn.cache_read_tokens += n('cachedReadTokens');
  }

  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.aliveValue) return Promise.reject(new Error('Inkling is not running'));
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
    if (!this.aliveValue) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n');
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = parseJson(line) as Record<string, unknown>;
    } catch {
      logger.warn('inkling wrote a non-JSON line', { line: line.slice(0, 200) });
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
      void this.handlePermission(msg.id, params);
      return;
    }
    this.reply(msg.id, { error: { code: -32601, message: `Lattice does not handle ${msg.method}` } });
  }

  private async handlePermission(id: unknown, params: Record<string, unknown>): Promise<void> {
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
    const meta = ((toolCall._meta ?? {}) as Record<string, unknown>).inkling as Record<string, unknown> | undefined;
    const rawInput = (toolCall.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput : {}) as Record<string, unknown>;
    const tool = inklingToolUse(typeof meta?.tool === 'string' ? meta.tool : String(toolCall.title ?? 'tool'), rawInput, this.options.cwd);
    // Text Inkling streamed before the call belongs above the card in the chat.
    this.flush();
    let decision: InklingApproval;
    try {
      decision = await this.options.bridge.decide({
        conversationId: this.options.conversationId,
        streamingId: this.processId ?? '',
        toolName: tool.name,
        toolInput: tool.input,
        preview: typeof meta?.preview === 'string' ? meta.preview : '',
      });
    } catch (err) {
      logger.error('inkling permission bridge failed', { error: err instanceof Error ? err.message : String(err) });
      decision = { allow: false, feedback: 'Lattice could not record the approval request.' };
    }
    this.reply(id, decision.allow
      ? { result: { outcome: { outcome: 'selected', optionId: 'allow' } } }
      : { result: { outcome: { outcome: 'selected', optionId: 'deny' }, ...(decision.feedback ? { _meta: { feedback: decision.feedback } } : {}) } });
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
        this.flush();
        this.handleToolCall(update);
        return;
      case 'tool_call_update':
        this.flush();
        this.handleToolResult(update);
        return;
      case 'usage_update':
        if (typeof update.used === 'number' && update.used > 0) this.contextUsed = update.used;
        return;
      default:
        return;
    }
  }

  private toolUseId(callId: unknown): string {
    return `${this.idPrefix}-${typeof callId === 'string' ? callId : `call-${this.segment}`}`;
  }

  private handleToolCall(update: Record<string, unknown>): void {
    const meta = ((update._meta ?? {}) as Record<string, unknown>).inkling as Record<string, unknown> | undefined;
    const name = typeof meta?.tool === 'string' ? meta.tool : String(update.title ?? 'tool');
    const raw = (update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : {}) as Record<string, unknown>;
    const id = this.toolUseId(update.toolCallId);
    this.openTools.add(id);
    this.emitAssistant({ type: 'tool_use', id, ...inklingToolUse(name, raw, this.options.cwd) },
      `${this.idPrefix}-tool-${String(update.toolCallId)}-${this.segment++}`);
  }

  private handleToolResult(update: Record<string, unknown>): void {
    const status = update.status;
    if (status !== 'completed' && status !== 'failed') return;
    const rawOutput = (update.rawOutput ?? {}) as Record<string, unknown>;
    const contentText = Array.isArray(update.content)
      ? (update.content as Array<Record<string, unknown>>)
        .map((c) => ((c.content ?? {}) as Record<string, unknown>).text)
        .filter((t): t is string => typeof t === 'string')
        .join('\n')
      : '';
    const output = typeof rawOutput.output === 'string' ? rawOutput.output : contentText;
    const id = this.toolUseId(update.toolCallId);
    this.openTools.delete(id);
    this.emitToolResult(id, output, status === 'failed');
  }

  private closeOpenTools(): void {
    for (const id of this.openTools) this.emitToolResult(id, 'Interrupted', true);
    this.openTools.clear();
  }

  private flush(): void {
    if (this.thought.trim()) {
      this.emitAssistant({ type: 'thinking', thinking: this.thought.trim() }, `${this.idPrefix}-thought-${this.segment++}`);
    }
    this.thought = '';
    const text = this.text.trim();
    if (text) this.emitAssistant({ type: 'text', text }, `${this.idPrefix}-text-${this.segment++}`);
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
      model: DEFAULT_INKLING_MODEL_ID,
      permissionMode: 'inkling-bridged',
      apiKeySource: 'none',
      provider: 'inkling',
    }));
  }

  private emitAssistant(block: Record<string, unknown>, id: string): void {
    if (!this.sentInit) this.emitInit();
    this.stdout.push(JSON.stringify({
      type: 'assistant',
      session_id: this.sessionId,
      message: {
        id, type: 'message', role: 'assistant', content: [block],
        model: DEFAULT_INKLING_MODEL_ID,
        ...(this.contextUsed !== null ? {
          usage: { input_tokens: this.contextUsed, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
        } : {}),
      },
      provider: 'inkling',
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
      provider: 'inkling',
    }));
  }

  private emitError(message: string): void {
    if (!this.turnOpen) return;
    this.flush();
    this.closeOpenTools();
    this.emitAssistant({ type: 'text', text: message }, `${this.idPrefix}-error-${this.segment++}`);
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
      usage: {
        input_tokens: this.turn.input_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: this.turn.cache_read_tokens,
        output_tokens: this.turn.output_tokens,
        server_tool_use: { web_search_requests: 0 },
      },
      total_cost_usd: 0,
      provider: 'inkling',
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

function stopReasonText(reason: string): string {
  switch (reason) {
    case 'max_turn_requests': return 'it reached its step limit without a final answer';
    case 'max_tokens': return 'the reply hit the token limit';
    default: return reason;
  }
}
