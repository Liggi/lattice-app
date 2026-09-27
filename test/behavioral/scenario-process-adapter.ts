import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { ProcessAdapter, ProcessHandle, SpawnConfig, SteerOutcome, SteerRequest } from '@liggi/agent-ui-harness/server';

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

interface ScenarioEvent {
  type: 'system_init' | 'assistant' | 'result' | 'raw';
  delay?: number;
  content?: ContentBlock[];
  duration_ms?: number;
  event?: Record<string, unknown>;
}

interface Scenario {
  name?: string;
  events: ScenarioEvent[];
  resume_events?: ScenarioEvent[];
  on_stdin?: {
    responses?: ScenarioEvent[][];
    respond_with?: ScenarioEvent[][];
    echo?: boolean;
  };
  exit_after_main?: boolean;
  exit_code?: number;
  startup_delay?: number;
}

function loadScenario(): Scenario {
  const scenarioPath = process.env.AGENT_STUB_SCENARIO
    ? resolve(process.env.AGENT_STUB_SCENARIO)
    : resolve(process.cwd(), 'test', 'behavioral', 'scenarios', 'simple-response.json');
  return JSON.parse(readFileSync(scenarioPath, 'utf-8')) as Scenario;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let processCounter = 0;

/** Whether an emitted event is the model answering input: a thinking or text block, or the turn's result. */
function answersInput(event: Record<string, unknown>): boolean {
  if (event.type === 'result') return true;
  const content = (event.message as { content?: Array<{ type?: string }> } | undefined)?.content;
  return event.type === 'assistant' && Array.isArray(content)
    && content.some((block) => block.type === 'thinking' || block.type === 'text');
}

class ScenarioProcess implements ProcessHandle {
  alive = true;
  readonly pid: number | undefined = undefined;
  readonly processId: string;

  private readonly scenario: Scenario;
  private readonly model: string;
  private readonly sessionId: string;
  private readonly resumeSessionId: string | undefined;
  private readonly spawnCwd: string;

  private msgCounter = 0;
  private stdinMessageCount = 0;
  private stdinResponseIndex = 0;
  private mainSequenceDone = false;
  private readonly pendingStdinMessages: Array<Record<string, unknown>> = [];
  private readonly awaitingIncorporation: Array<NonNullable<SteerRequest['onStage']>> = [];

  private readonly lineBuffer: string[] = [];
  private lineResolve: ((r: IteratorResult<string>) => void) | null = null;
  private streamDone = false;

  private resolveExit!: (v: { code: number; signal?: string }) => void;
  readonly exited: Promise<{ code: number; signal?: string }>;
  private exitResolved = false;

  private sigintFired = false;

  constructor(config: SpawnConfig) {
    this.processId = `scenario-${Date.now()}-${processCounter++}`;
    this.scenario = loadScenario();

    const modelArg = (config.args ?? []).find((a) => a.startsWith('--model'));
    this.model = modelArg
      ? modelArg.replace(/^--model[=\s]?/, '') || 'claude-sonnet-4-5-20250929'
      : 'claude-sonnet-4-5-20250929';

    const rawResume = config.resume;
    this.resumeSessionId =
      rawResume && !rawResume.startsWith('pending-') ? rawResume : undefined;
    this.sessionId = this.resumeSessionId ?? `stub-session-${Date.now()}`;
    this.spawnCwd = config.cwd ?? process.cwd();

    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    void this.run();
  }

  readonly stdout: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<string>> => {
        if (this.lineBuffer.length > 0) {
          return Promise.resolve({ value: this.lineBuffer.shift()!, done: false });
        }
        if (this.streamDone) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.lineResolve = resolve;
        });
      },
    }),
  };

  private emit(event: Record<string, unknown>): void {
    if (this.streamDone) return;
    if (this.awaitingIncorporation.length > 0 && answersInput(event)) {
      for (const onStage of this.awaitingIncorporation.splice(0)) {
        onStage({ kind: 'incorporated', where: 'mid-turn', evidence: 'scenario reached an event answering it' });
      }
    }
    const line = JSON.stringify(event);
    if (this.lineResolve) {
      const resolve = this.lineResolve;
      this.lineResolve = null;
      resolve({ value: line, done: false });
    } else {
      this.lineBuffer.push(line);
    }
  }

  private endStream(): void {
    this.streamDone = true;
    if (this.lineResolve) {
      const resolve = this.lineResolve;
      this.lineResolve = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  private exit(code: number, signal?: string): void {
    if (this.exitResolved) return;
    this.exitResolved = true;
    this.alive = false;
    this.endStream();
    this.resolveExit({ code, signal });
  }

  private buildSystemInit(): Record<string, unknown> {
    return {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      cwd: this.spawnCwd,
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      mcp_servers: [],
      model: this.model,
      permissionMode: 'bypassPermissions',
    };
  }

  private buildAssistantMessage(
    content: ContentBlock[] | string,
    stopReason = 'end_turn',
  ): Record<string, unknown> {
    this.msgCounter++;
    return {
      type: 'assistant',
      session_id: this.sessionId,
      message: {
        id: `msg_stub_${this.msgCounter}`,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: Array.isArray(content) ? content : [{ type: 'text', text: content }],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: 100 + this.msgCounter * 50,
          output_tokens: 20 + this.msgCounter * 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };
  }

  private buildResult(durationMs = 1000): Record<string, unknown> {
    return {
      type: 'result',
      session_id: this.sessionId,
      subtype: 'success',
      is_error: false,
      duration_ms: durationMs,
      duration_api_ms: Math.round(durationMs * 0.85),
      num_turns: 1,
      result: '',
      usage: {
        input_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100,
        output_tokens: 80,
        server_tool_use: { web_search_requests: 0 },
      },
    };
  }

  private expandEvent(evt: ScenarioEvent): Record<string, unknown> | null {
    switch (evt.type) {
      case 'system_init':
        return this.buildSystemInit();
      case 'assistant': {
        const hasToolUse =
          Array.isArray(evt.content) && evt.content.some((b) => b.type === 'tool_use');
        return this.buildAssistantMessage(
          evt.content ?? [],
          hasToolUse ? 'tool_use' : 'end_turn',
        );
      }
      case 'result':
        return this.buildResult(evt.duration_ms ?? 1000);
      case 'raw':
        return { session_id: this.sessionId, ...(evt.event ?? {}) };
      default:
        return null;
    }
  }

  private async playSequence(events: ScenarioEvent[]): Promise<void> {
    for (const evt of events) {
      if (this.streamDone) return;
      if (evt.delay) await sleep(evt.delay);
      if (this.streamDone) return;
      const expanded = this.expandEvent(evt);
      if (expanded) this.emit(expanded);
    }
  }

  private async handleStdinMessage(msg: Record<string, unknown>): Promise<void> {
    const onStdin = this.scenario.on_stdin;
    const responses = onStdin?.responses ?? onStdin?.respond_with;
    if (responses && this.stdinResponseIndex < responses.length) {
      const responseSeq = responses[this.stdinResponseIndex];
      this.stdinResponseIndex++;
      await this.playSequence(
        Array.isArray(responseSeq) ? responseSeq : [responseSeq],
      );
    } else if (onStdin?.echo) {
      const message = (msg.message ?? {}) as { content?: unknown };
      this.emit(
        this.buildAssistantMessage(
          `Acknowledged: ${JSON.stringify(message.content ?? '').slice(0, 50)}`,
        ),
      );
      this.emit(this.buildResult(200));
    }
  }

  private async run(): Promise<void> {
    if (this.scenario.startup_delay) {
      await sleep(this.scenario.startup_delay);
    }
    if (this.streamDone) return;

    const mainEvents =
      this.resumeSessionId && this.scenario.resume_events
        ? this.scenario.resume_events
        : this.scenario.events;

    await this.playSequence(mainEvents);
    this.mainSequenceDone = true;

    for (const msg of this.pendingStdinMessages) {
      await this.handleStdinMessage(msg);
    }
    this.pendingStdinMessages.length = 0;

    if (this.scenario.exit_after_main) {
      this.exit(this.scenario.exit_code ?? 0);
    }
  }

  write(input: string): void {
    if (!this.alive) return;
    const trimmed = input.endsWith('\n') ? input.slice(0, -1) : input;
    const msg = { type: 'user', message: { role: 'user', content: trimmed } };

    if (!msg.type || !msg.message || msg.message.role !== 'user') return;

    this.stdinMessageCount++;

    if (!this.mainSequenceDone) {
      this.pendingStdinMessages.push(msg);
    } else {
      void this.handleStdinMessage(msg);
    }
  }

  /**
   * The live CLI's steering path, reduced to what a scenario can show: the
   * input is written like any other, acknowledged at once, and reported taken
   * in at the next event that answers it.
   */
  async steer(request: SteerRequest): Promise<SteerOutcome> {
    if (!this.alive) return { status: 'rejected', reason: 'Scenario process is not running' };
    request.onStage?.({ kind: 'handed-over' });
    this.write(request.input);
    request.onStage?.({ kind: 'accepted', late: false });
    if (request.onStage) this.awaitingIncorporation.push(request.onStage);
    return { status: 'accepted' };
  }

  signal(sig: NodeJS.Signals): void {
    if (!this.alive) return;
    switch (sig) {
      case 'SIGINT':
        if (this.sigintFired) return;
        this.sigintFired = true;
        void sleep(1500).then(() => {
          if (!this.alive) return;
          this.emit(this.buildResult(0));
        });
        break;
      case 'SIGTERM':
        this.exit(0);
        break;
      case 'SIGKILL':
        this.exit(1);
        break;
      default:
        break;
    }
  }
}

export class ScenarioProcessAdapter implements ProcessAdapter {
  async spawn(config: SpawnConfig): Promise<ProcessHandle> {
    return new ScenarioProcess(config);
  }
}
