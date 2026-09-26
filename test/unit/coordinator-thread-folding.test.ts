import { describe, expect, it } from 'vitest';
import { foldCoordinatorMachinery, isSessionDispatchOrSend } from '../../src/web/chat/utils/coordinator-thread.js';
import type { RenderItem } from '../../src/web/chat/hooks/useHarnessSession.js';
import type { ChatMessage, DisplayContentBlock } from '../../src/web/chat/types/index.js';

const text = (t: string): DisplayContentBlock => ({ type: 'text', text: t });
const thinking = (t: string): DisplayContentBlock => ({ type: 'thinking', thinking: t });
const bash = (command: string): DisplayContentBlock => ({ type: 'tool_use', id: `tu-${command.length}`, name: 'Bash', input: { command } } as DisplayContentBlock);

function assistant(id: string, content: string | DisplayContentBlock[]): RenderItem {
  const message: ChatMessage = { id, messageId: id, type: 'assistant', content, timestamp: '2026-09-19T20:57:00.000Z', provider: 'codex' };
  return { kind: 'message', message };
}
function user(id: string, content: string): RenderItem {
  return { kind: 'message', message: { id, messageId: id, type: 'user', content, timestamp: '2026-09-19T20:56:00.000Z', provider: 'codex' } };
}
function quickAnswer(id: string, content: string): RenderItem {
  return { kind: 'message', message: { id, messageId: id, type: 'assistant', content: [text(content)], timestamp: '2026-09-19T20:56:30.000Z', provider: 'codex', responder: 'fast' } };
}
function workerBlock(id: string): RenderItem {
  return { kind: 'message', message: { id, messageId: id, type: 'system', systemSubtype: 'worker', content: '', timestamp: '2026-09-19T20:56:40.000Z', provider: 'codex' } };
}

describe('isSessionDispatchOrSend', () => {
  it('recognises the dispatch and send commands however the CLI is wrapped', () => {
    expect(isSessionDispatchOrSend(bash("/bin/zsh -lc '/Users/dev/.lattice-app/bin/lattice session new --from conv-c --task \"x\"'"))).toBe(true);
    expect(isSessionDispatchOrSend(bash('lattice session send conv-w --from conv-c --message "ok"'))).toBe(true);
    expect(isSessionDispatchOrSend(bash('lattice session transcript conv-w --last 3'))).toBe(false);
    expect(isSessionDispatchOrSend(bash('cat notes.md'))).toBe(false);
  });
});

describe('foldCoordinatorMachinery', () => {
  it('drops dispatch calls and folds the rest of a turn behind one line, keeping the text parts', () => {
    const items = [
      user('u1', 'Describe the scratch directory'),
      assistant('a1', [text("I'll ask an Opus worker.")]),
      assistant('a2', [bash('/bin/zsh -lc pwd')]),
      assistant('a3', [thinking('Reading worker brief')]),
      assistant('a4', [bash('/bin/zsh -lc "cat brief.md"')]),
      assistant('a5', [bash("/bin/zsh -lc 'lattice session new --from conv-c --task t --provider claude --model claude-opus-5'")]),
      assistant('a6', [text('Dispatched an Opus worker.')]),
    ];
    const folded = foldCoordinatorMachinery(items, false);
    expect(folded.map((i) => i.kind)).toEqual(['message', 'message', 'folded', 'message']);
    const fold = folded[2];
    if (fold.kind !== 'folded') throw new Error('expected a fold');
    expect(fold.summary).toBe('Ran 2 commands');
    expect(fold.items.map((i) => (i.kind === 'message' ? i.message.id : i.kind))).toEqual(['a2', 'a3', 'a4']);
    expect(fold.temporalState).toBe('historical');
    expect(fold.latestHint).toBeNull();
    expect(folded[1]).toBe(items[1]);
  });

  it('splits a Claude-style message that mixes text and tool use, keeping the original id on the first text part', () => {
    const items = [assistant('a1', [thinking('hm'), text('Looking.'), bash('ls'), text('Done.')])];
    const folded = foldCoordinatorMachinery(items, false);
    expect(folded.map((i) => (i.kind === 'message' ? i.message.id : i.summary))).toEqual(['Reasoning', 'a1', 'Ran 1 command', 'a1#t2']);
  });

  it('marks a trailing fold active while streaming and says what is running', () => {
    const items = [assistant('a1', [text('On it.')]), assistant('a2', [bash("/bin/zsh -lc 'lattice session transcript conv-w --last 3'")])];
    const fold = foldCoordinatorMachinery(items, true)[1];
    if (fold.kind !== 'folded') throw new Error('expected a fold');
    expect(fold.temporalState).toBe('active');
    expect(fold.summary).toBe('Running a command');
    expect(fold.latestHint).toBe('lattice session transcript conv-w --last 3');
  });

  it('says it is thinking while it is, and only calls it reasoning once the turn has moved on', () => {
    const items = [assistant('a1', [thinking('Weighing the two fixes')])];
    const live = foldCoordinatorMachinery(items, true)[0];
    if (live.kind !== 'folded') throw new Error('expected a fold');
    expect([live.summary, live.latestHint, live.temporalState]).toEqual(['Thinking', null, 'active']);

    const done = foldCoordinatorMachinery([...items, assistant('a2', [text('Here is what I found.')])], true)[0];
    if (done.kind !== 'folded') throw new Error('expected a fold');
    expect([done.summary, done.temporalState]).toEqual(['Reasoning', 'historical']);
  });

  it('keeps the current work active when a quick answer, a worker block or the user arrives mid-turn', () => {
    const working = assistant('a1', [thinking('still going')]);
    for (const interruption of [quickAnswer('q1', 'A quick answer.'), workerBlock('w1'), user('u1', 'one more thing')]) {
      const folds = foldCoordinatorMachinery([working, interruption], true).filter((i) => i.kind === 'folded');
      expect(folds.map((f) => (f.kind === 'folded' ? [f.summary, f.temporalState] : null))).toEqual([['Thinking', 'active']]);
    }
  });

  it('leaves nothing active when the coordinator has spoken since, even mid-stream', () => {
    const items = [assistant('a1', [thinking('done with this')]), assistant('a2', [text('Answer.')]), quickAnswer('q1', 'aside')];
    const folds = foldCoordinatorMachinery(items, true).filter((i) => i.kind === 'folded');
    expect(folds.map((f) => (f.kind === 'folded' ? f.temporalState : null))).toEqual(['historical']);
  });

  it('leaves a thread with no machinery untouched', () => {
    const items = [user('u1', 'hi'), assistant('a1', 'hello')];
    expect(foldCoordinatorMachinery(items, false)).toEqual(items);
  });
});
