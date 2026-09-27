/**
 * Coordinator thread folding.
 *
 * A coordinator's thread is the conversation the user has with `front` plus the
 * worker blocks the server writes into its log. The coordinator's own tool
 * use is not part of that conversation: a `lattice session new` call is
 * already shown by the worker block that follows it, a `lattice session send`
 * by the answered line, and anything else it runs (reading a file, writing a
 * brief) is machinery the user may want to know happened but not to read. So
 * dispatch and send calls are dropped, and every other tool call and thinking
 * block between two pieces of conversation is folded into one quiet line that
 * opens to the ordinary rows.
 *
 * Pure: takes the render items the harness built and returns new ones. A
 * message that is all conversation keeps its identity; only a message that
 * mixes text with machinery is split, and its first text part keeps the
 * original id so annotations and jump targets still resolve.
 */

import type { RenderItem } from '../hooks/useHarnessSession';
import type { DisplayContentBlock } from '../types';

type FoldedItem = Extract<RenderItem, { kind: 'folded' }>;

/** `lattice session new …` / `lattice session send …`, however the CLI is spelled or wrapped. */
const SESSION_DISPATCH_OR_SEND = /(?:^|[\s'"`;&|(])(?:\S*\/)?lattice\s+session\s+(?:new|send)\b/;

function commandOf(block: DisplayContentBlock): string | null {
  const input = (block as { input?: Record<string, unknown> }).input;
  const command = input?.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.map(String).join(' ');
  return null;
}

/** A tool call the thread already shows in the worker's own shape. */
export function isSessionDispatchOrSend(block: DisplayContentBlock): boolean {
  if (block.type !== 'tool_use') return false;
  const command = commandOf(block);
  return command !== null && SESSION_DISPATCH_OR_SEND.test(command);
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ApplyPatch']);
const SHELL_TOOLS = new Set(['Bash', 'shell', 'exec_command']);

interface Counts { commands: number; reads: number; edits: number; other: number; thinking: number }

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What a finished fold contains. Past tense is a claim of completion, so this
 * is only ever used on a historical fold; thinking gets the neutral
 * "Reasoning" rather than "Thought it through", which read as a verdict on
 * work that was in fact still going.
 */
function summarise(counts: Counts): string {
  const parts: string[] = [];
  if (counts.commands > 0) parts.push(`ran ${plural(counts.commands, 'command')}`);
  if (counts.reads > 0) parts.push(`read ${plural(counts.reads, 'file')}`);
  if (counts.edits > 0) parts.push(`edited ${plural(counts.edits, 'file')}`);
  if (counts.other > 0) parts.push(`${plural(counts.other, 'other tool call')}`);
  if (parts.length === 0 && counts.thinking > 0) parts.push('reasoning');
  const text = parts.join(', ') || 'worked';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The detail line for a tool call: the command, the path, the pattern. */
function hintFor(block: DisplayContentBlock): string | null {
  if (block.type !== 'tool_use') return null;
  const name = (block as { name?: string }).name ?? '';
  const input = ((block as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
  if (SHELL_TOOLS.has(name)) {
    const command = commandOf(block) ?? '';
    // A login-shell wrapper (`/bin/zsh -lc '…'`) is how Codex runs everything; show the command inside it.
    const inner = command.match(/^\S*\/(?:zsh|bash|sh)\s+-l?c\s+(?:'([\s\S]*)'|"([\s\S]*)"|([\s\S]*))$/);
    const shown = (inner ? (inner[1] ?? inner[2] ?? inner[3]) : command).trim();
    return shown.split('\n')[0] || name;
  }
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
  const pattern = typeof input.pattern === 'string' ? input.pattern : typeof input.query === 'string' ? input.query : null;
  return [name, path ?? pattern].filter(Boolean).join(' ');
}

function count(items: readonly RenderItem[], counts: Counts): void {
  for (const item of items) {
    if (item.kind === 'group') {
      counts.reads += item.group.toolCalls.length;
    } else if (item.kind === 'folded') {
      count(item.items, counts);
    } else if (Array.isArray(item.message.content)) {
      for (const block of item.message.content) {
        if (block.type === 'thinking') counts.thinking += 1;
        else if (block.type === 'tool_use') {
          const name = (block as { name?: string }).name ?? '';
          if (SHELL_TOOLS.has(name)) counts.commands += 1;
          else if (READ_TOOLS.has(name)) counts.reads += 1;
          else if (EDIT_TOOLS.has(name)) counts.edits += 1;
          else counts.other += 1;
        }
      }
    }
  }
}

interface Activity { label: string; hint: string | null }

function activityFor(block: DisplayContentBlock): Activity | null {
  if (block.type === 'thinking') return { label: 'Thinking', hint: null };
  if (block.type !== 'tool_use') return null;
  const name = (block as { name?: string }).name ?? '';
  const hint = hintFor(block);
  if (SHELL_TOOLS.has(name)) return { label: 'Running a command', hint };
  if (READ_TOOLS.has(name)) return { label: 'Reading', hint };
  if (EDIT_TOOLS.has(name)) return { label: 'Editing', hint };
  return { label: 'Working', hint };
}

/** The newest thing in a fold: what to say it is doing while it still is. */
function latestActivity(items: readonly RenderItem[]): Activity | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'group') return { label: 'Reading', hint: item.group.latestHint ?? item.group.summary };
    if (item.kind === 'folded') return latestActivity(item.items);
    if (!Array.isArray(item.message.content)) continue;
    for (let b = item.message.content.length - 1; b >= 0; b--) {
      const activity = activityFor(item.message.content[b]);
      if (activity) return activity;
    }
  }
  return null;
}

function fold(items: RenderItem[]): FoldedItem {
  const counts: Counts = { commands: 0, reads: 0, edits: 0, other: 0, thinking: 0 };
  count(items, counts);
  const first = items[0];
  const firstId = first.kind === 'group' ? first.group.id : first.kind === 'folded' ? first.id : first.message.messageId || first.message.id;
  return {
    kind: 'folded',
    id: `fold-${firstId}`,
    summary: summarise(counts),
    latestHint: null,
    items,
    temporalState: 'historical',
  };
}

/** The same fold, said in the present tense, because the work is still going. */
function asActive(item: FoldedItem): FoldedItem {
  const activity = latestActivity(item.items);
  return {
    ...item,
    summary: activity?.label ?? 'Working',
    latestHint: activity?.hint ?? null,
    temporalState: 'active',
  };
}

/**
 * Something the coordinator did not write in this turn: the user's own message
 * or a worker block the server appended.
 * These land between the coordinator's tool calls without ending its turn, so
 * they must not turn work that is still running into history.
 */
function isInterruption(item: RenderItem): boolean {
  if (item.kind !== 'message') return false;
  const message = item.message;
  if (message.type === 'user') return true;
  return message.type === 'system';
}

function isBlankText(block: DisplayContentBlock): boolean {
  return block.type === 'text' && !(typeof block.text === 'string' && block.text.trim().length > 0);
}

/**
 * Fold a coordinator's render items. While `isStreaming`, the fold the
 * coordinator is still working in is marked active and says so in the present
 * tense. That fold is the last one with none of the coordinator's own
 * conversation after it — a worker report arriving mid-turn
 * is not the coordinator speaking, so it leaves the work where it is.
 */
export function foldCoordinatorMachinery(items: readonly RenderItem[], isStreaming: boolean): RenderItem[] {
  const out: RenderItem[] = [];
  let pending: RenderItem[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    out.push(fold(pending));
    pending = [];
  };

  for (const item of items) {
    if (item.kind === 'group') {
      pending.push(item);
      continue;
    }
    if (item.kind === 'folded') {
      pending.push(...item.items);
      continue;
    }
    const message = item.message;
    if (message.type !== 'assistant' || !Array.isArray(message.content) || message.content.every((block) => block.type === 'text')) {
      flush();
      out.push(item);
      continue;
    }

    // A message that is all machinery folds whole, keeping its identity.
    if (!message.content.some((block) => block.type === 'text' || isSessionDispatchOrSend(block))) {
      pending.push(item);
      continue;
    }

    // Split an assistant message into its conversation (text) and machinery
    // (thinking, tool use) parts, in order.
    const baseId = message.messageId || message.id;
    let machinery: DisplayContentBlock[] = [];
    let part = 0;
    let textParts = 0;
    const pushMachinery = () => {
      if (machinery.length === 0) return;
      const id = `${baseId}#m${part++}`;
      pending.push({ kind: 'message', message: { ...message, id, messageId: id, content: machinery } });
      machinery = [];
    };
    for (const block of message.content) {
      if (isBlankText(block)) continue;
      if (block.type === 'text') {
        pushMachinery();
        flush();
        const id = textParts === 0 ? baseId : `${baseId}#t${part++}`;
        textParts += 1;
        out.push({ kind: 'message', message: { ...message, id, messageId: id, content: [block] } });
      } else if (isSessionDispatchOrSend(block)) {
        continue;
      } else {
        machinery.push(block);
      }
    }
    pushMachinery();
  }
  flush();

  if (isStreaming) {
    for (let i = out.length - 1; i >= 0; i--) {
      const item = out[i];
      if (item.kind === 'folded') { out[i] = asActive(item); break; }
      if (!isInterruption(item)) break;
    }
  }
  return out;
}
