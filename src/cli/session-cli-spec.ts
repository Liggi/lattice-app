/**
 * Declarative spec for `lattice session ...` — the single source of truth for
 * which flags each verb accepts, what they mean, and how help reads.
 *
 * Why a spec rather than ad-hoc parsing per verb: the old parser accepted any
 * `--foo`, so `list --since 2026-01-01` exited 0 having silently ignored the
 * filter, and `--model=claude-opus-5` (the form the help text itself showed)
 * parsed as a flag literally named `model=claude-opus-5`. Both failures are
 * unrepresentable here — an unknown flag is an error, and help is rendered
 * from the same table the parser validates against, so it cannot go stale.
 */

export type FlagKind = 'boolean' | 'string' | 'int';

export interface FlagSpec {
  name: string;
  kind: FlagKind;
  /** Metavar shown in help for value-taking flags, e.g. `N`, `NAME`. */
  value?: string;
  desc: string;
  /** Accepted but not advertised in the per-verb flag list. */
  hidden?: boolean;
  aliases?: string[];
}

export interface PositionalSpec {
  name: string;
  required?: boolean;
  /** Consumes all remaining positionals, joined with a space. */
  rest?: boolean;
}

export interface VerbSpec {
  name: string;
  summary: string;
  positionals: PositionalSpec[];
  flags: FlagSpec[];
  /** Extra paragraphs printed under the flag list by `--help`. */
  notes?: string[];
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

// ---------------------------------------------------------------------------
// Shared flag groups

const JSON_FLAG: FlagSpec = {
  name: 'json',
  kind: 'boolean',
  desc: 'Emit JSON instead of text.',
};

/**
 * Event-window flags shared by transcript / inputs / tools. `--from`/`--to`
 * bound the raw event seq range; `--last` counts *rendered items* (turns, tool
 * calls) off the end of whatever that range produced.
 */
const WINDOW_FLAGS: FlagSpec[] = [
  { name: 'from', kind: 'int', value: 'SEQ', desc: 'Start at event seq SEQ (inclusive).' },
  { name: 'to', kind: 'int', value: 'SEQ', desc: 'Stop at event seq SEQ (inclusive).' },
  {
    name: 'last',
    kind: 'int',
    value: 'N',
    desc: 'Keep only the last N matching items (not a seq range).',
  },
];

const WINDOW_NOTE =
  'Precedence: --from/--to select an event range first, then --last keeps the\n' +
  '  last N items inside it. With neither, the last 50 items are shown and the\n' +
  '  count of what was dropped is reported.';

// ---------------------------------------------------------------------------
// Verbs

export const SESSION_VERBS: VerbSpec[] = [
  {
    name: 'new',
    summary: 'Create and launch a new conversation on the running server.',
    positionals: [{ name: 'prompt', rest: true }],
    flags: [
      { name: 'model', kind: 'string', value: 'ID', desc: 'Model id, e.g. claude-opus-5-5.' },
      { name: 'provider', kind: 'string', value: 'P', desc: 'claude (default) or codex.' },
      { name: 'reasoning-effort', kind: 'string', value: 'E', desc: 'Codex only: minimal | low | medium | high | xhigh. Without it the session takes the configured default.' },
      { name: 'fast', kind: 'boolean', desc: 'Codex only: run every turn on Codex\'s Fast tier (about 1.5x speed, more usage). Models Codex does not list with a Fast tier run at normal speed.' },

      { name: 'cwd', kind: 'string', value: 'DIR', desc: 'Working directory (default: $PWD, or the --from parent\'s).' },
      { name: 'from', kind: 'string', value: 'CONV', desc: 'Start as a worker picked up from this coordinator conversation.' },
      { name: 'task', kind: 'string', value: 'TEXT', desc: 'With --from: one line saying what the worker is to find out or do (shown on its card).' },
      { name: 'thread', kind: 'int', value: 'ID', desc: 'With --from: the coordinator\'s open thread this worker is being put on (the id `session state` shows).' },
      { name: 'coordinator', kind: 'boolean', desc: 'Start as a coordinator (front persona; Codex unless --provider says otherwise).' },
      { name: 'archived', kind: 'boolean', desc: 'Create it already archived, so it never appears in the sidebar. For verification fixtures.' },
      { name: 'prompt-file', kind: 'string', value: 'PATH', desc: 'Read the prompt from a file.' },
      { name: 'prompt', kind: 'string', value: 'TEXT', desc: 'Prompt text.' },
      { name: 'message', kind: 'string', value: 'TEXT', desc: 'Alias for --prompt.' },
      { name: 'workspace', kind: 'string', value: 'W', desc: 'Workspace name.' },
      { name: 'permission-mode', kind: 'string', value: 'M', desc: 'Permission mode.' },
      { name: 'host', kind: 'string', value: 'H', desc: 'Server host (default: from config).' },
      { name: 'port', kind: 'int', value: 'N', desc: 'Server port (default: from config).' },
      JSON_FLAG,
    ],
    notes: [
      'Prompt source precedence: --prompt-file, then --prompt, then --message,\n' +
        '  then the trailing positional text.',
      '--reasoning-effort reaches Codex sessions only, and is how an Astra assignment\n' +
        '  is created at the effort the work needs: `--provider codex --model gpt-6-astra\n' +
        '  --reasoning-effort xhigh`. A Claude --model is ignored by it.',

      'With --from, the new session inherits the parent\'s cwd and workspace unless\n' +
        '  --cwd/--workspace are given, gets a worker preamble ahead of the prompt, and\n' +
        '  each of its turn-end messages is delivered into the parent conversation.',
      'A fixture session made to verify something is created with --archived, not\n' +
        '  archived afterwards: a coordinator is a project in the user\'s sidebar from the\n' +
        '  moment its row exists, so archiving it after the fact still shows it to them.\n' +
        '  A session created with --from a fixture is created hidden in the same way.',
      'Needs the server running, as does send. Read commands use SQLite directly.',
    ],
  },
  {
    name: 'send',
    summary: 'Send a message to an existing session, resuming it if needed.',
    positionals: [{ name: 'conv', required: true }, { name: 'message', rest: true }],
    flags: [
      { name: 'message', kind: 'string', value: 'TEXT', desc: 'Message to send.' },
      { name: 'message-file', kind: 'string', value: 'PATH', desc: 'Read the message from a file.' },
      { name: 'model', kind: 'string', value: 'ID', desc: 'Switch the session model for this message.' },
      { name: 'from', kind: 'string', value: 'CONV', desc: 'Sender conversation. A coordinator sending to its own worker records the message in its thread.' },
      { name: 'summary', kind: 'string', value: 'TEXT', desc: 'With --from: one line, the substance of the message, for the coordinator\'s thread.' },
      { name: 'task', kind: 'string', value: 'TEXT', desc: 'With --from: a different assignment for an idle worker you are reusing. Renames its card from here on.' },
      { name: 'thread', kind: 'int', value: 'ID', desc: 'With --task: the open thread the new assignment is (the id `session state` shows). Without it the worker leaves its old thread.' },
      { name: 'passed-on', kind: 'boolean', desc: 'With --from: the message carries the user\'s decision, not the coordinator\'s own.' },
      { name: 'answers', kind: 'int', value: 'SEQ', desc: 'With --from: this message answers that question event, clearing it from the coordinator\'s pending list.' },
      { name: 'interrupt', kind: 'boolean', desc: 'Cancel the session\'s current turn first, so it stops what it is doing and reads this.' },
      { name: 'after-turn', kind: 'boolean', desc: 'Hold the message until the session\'s running turn ends, even where it would go in now.' },
      { name: 'host', kind: 'string', value: 'H', desc: 'Server host (default: from config).' },
      { name: 'port', kind: 'int', value: 'N', desc: 'Server port (default: from config).' },
      JSON_FLAG,
    ],
    notes: [
      'Uses the same send endpoint as the Lattice composer. A receipt confirms acceptance, not completion;\n' +
        '  its delivery field says "now", "after-turn" or "saved". A message to a session mid-turn is\n' +
        '  delivered into that turn, whoever sends it: "now" means the provider took it, and the session reads\n' +
        '  it at its next input point without the running tool being cancelled (Claude after the tool\n' +
        '  finishes, Codex possibly during it). --after-turn holds it for the turn to end instead, even if\n' +
        '  later messages go in first; it is rarely what you want.\n' +
        '  --interrupt cancels the running turn; use it only when the rest of that turn is not worth having.',
      'Message precedence: --message-file, then --message, then positional text. Read the reply with transcript.',
      'A coordinator answering a worker passes --from <its own id> and --summary; the summary is what\n' +
        '  the user sees in the coordinator thread, so it should carry the decision, not restate the question.\n' +
        '  Add --passed-on when the answer is the user\'s call relayed, so the thread says so instead of\n' +
        '  crediting the coordinator.',
      'Reusing a worker on something else takes --task "<one line>", sent with the brief for the new work.\n' +
        '  Its card, the roster and its attribution read the new task from then on; the dispatch and everything\n' +
        '  it reported under the old one stay in the history. A follow-up on the same task needs no --task, and\n' +
        '  passing the name it already has writes nothing. Add --thread <id> when the new work is an open thread,\n' +
        '  so the worker carries that thread; without it the worker leaves the thread it was on, and dismissing\n' +
        '  that thread no longer stops it. It is refused while the worker is in a turn unless\n' +
        '  --interrupt comes with it: start a new worker instead, or send it once this one is idle.',
      'A worker\'s question stays on the coordinator\'s pending list until an answer names it: --answers SEQ,\n' +
        '  the seq `session state` shows beside it. Without the flag the message is delivered and the question\n' +
        '  stays pending, which is deliberate — a coordinator also sends a waiting worker resource updates,\n' +
        '  corrections and pauses, and none of those is the answer.',
    ],
  },
  {
    name: 'list',
    summary: 'Recent sessions, newest activity first.',
    positionals: [],
    flags: [
      { name: 'limit', kind: 'int', value: 'N', desc: 'Rows to print (default 30).' },
      { name: 'all', kind: 'boolean', desc: 'Include archived sessions.' },
      { name: 'archived', kind: 'boolean', desc: 'Only archived sessions.' },
      { name: 'project', kind: 'string', value: 'NAME', desc: 'Only sessions whose summary project is NAME.' },
      { name: 'tag', kind: 'string', value: 'TAG', desc: 'Only sessions whose summary tags include TAG.' },
      {
        name: 'status',
        kind: 'string',
        value: 'S',
        desc: 'Only sessions in state S: running | idle | stopping | done.',
      },
      { name: 'today', kind: 'boolean', desc: 'Only sessions active since local midnight.' },
      { name: 'since', kind: 'string', value: 'DATE', desc: 'Only sessions active on/after DATE (YYYY-MM-DD or ISO).' },
      { name: 'summaries', kind: 'boolean', desc: 'Print title plus a two-line summary per session.' },
      JSON_FLAG,
    ],
    notes: [
      'Ordering and the date column are last *activity* (newest harness event),\n' +
        '  not creation time.',
      '--today/--since filter on that same activity time, so they compose with\n' +
        '  --all (archived-today still shows) and with --project/--tag.',
    ],
  },
  {
    name: 'show',
    summary: 'Session metadata, status, usage, and summary block.',
    positionals: [{ name: 'conv', required: true }],
    flags: [JSON_FLAG],
  },
  {
    name: 'search',
    summary: 'Find sessions by text in their first message, or their title, summary, notable or tags.',
    positionals: [{ name: 'query', required: true, rest: true }],
    flags: [
      { name: 'limit', kind: 'int', value: 'N', desc: 'Hits to print (default 30).' },
      { name: 'project', kind: 'string', value: 'NAME', desc: 'Restrict to one summary project.' },
      JSON_FLAG,
    ],
    notes: ['Searches every session, archived included: its first message, and its summary where one has been written. Case-insensitive substring.'],
  },
  {
    name: 'transcript',
    summary: 'User + assistant text, with event refs.',
    positionals: [{ name: 'conv', required: true }],
    flags: [
      ...WINDOW_FLAGS,
      { name: 'include-thinking', kind: 'boolean', desc: 'Include thinking blocks.' },
      {
        name: 'raw',
        kind: 'boolean',
        desc: 'One line per content event, uncoalesced (Codex streams a token per event).',
      },
      JSON_FLAG,
    ],
    notes: [
      WINDOW_NOTE,
      'Consecutive content events from the same message are joined into one turn;\n' +
        '  a joined turn shows its seq range. --raw turns that off.',
    ],
  },
  {
    name: 'inputs',
    summary: 'User messages only.',
    positionals: [{ name: 'conv', required: true }],
    flags: [...WINDOW_FLAGS, JSON_FLAG],
    notes: [WINDOW_NOTE, '--last 1 prints the most recent user turn.'],
  },
  {
    name: 'tools',
    summary: 'Tool calls, one per line.',
    positionals: [{ name: 'conv', required: true }],
    flags: [
      { name: 'name', kind: 'string', value: 'NAME', desc: 'Filter by tool name (case-insensitive substring).' },
      ...WINDOW_FLAGS,
      JSON_FLAG,
    ],
    notes: [WINDOW_NOTE, 'With --json and no --last, every tool call in the range is returned.'],
  },
  {
    name: 'event',
    summary: 'Full payload for a single event.',
    positionals: [
      { name: 'conv', required: true },
      { name: 'seq', required: true },
    ],
    flags: [JSON_FLAG],
  },
  {
    name: 'grep',
    summary: 'Search within one session.',
    positionals: [
      { name: 'conv', required: true },
      { name: 'query', required: true, rest: true },
    ],
    flags: [
      {
        name: 'role',
        kind: 'string',
        value: 'R',
        desc: 'Restrict to user | assistant | thinking | tool (repeat with commas).',
      },
      { name: 'limit', kind: 'int', value: 'N', desc: 'Hits to print (default 50).' },
      { name: 'last', kind: 'int', value: 'N', desc: 'Alias for --limit, keeping the newest hits.', hidden: true },
      JSON_FLAG,
    ],
    notes: [
      'Default searches every role, which is why tool results (Playwright dumps,\n' +
        '  file reads) dominate on some sessions — narrow with --role assistant.',
      'The total hit count is always reported, including hits past --limit.',
    ],
  },
  {
    name: 'note',
    summary: 'Coordinator only: note the project state (outcome, priority, decisions, a thread and where it has got to, what this turn is doing).',

    positionals: [{ name: 'conv', required: true }],
    flags: [
      { name: 'outcome', kind: 'string', value: 'TEXT', desc: 'What this project is trying to get to (replaces the previous outcome).' },
      { name: 'name', kind: 'string', value: 'TEXT', desc: 'With --outcome: the project\'s short name in the sidebar, for the thing being owned. A name the user typed always wins. With --open/--thread: the thread\'s short name, a few words the panel shows beside its label ("Repetition check").' },
      { name: 'decide', kind: 'string', value: 'TEXT', desc: 'A decision taken (a choice made, not a finding), one line.' },
      { name: 'by-user', kind: 'boolean', desc: 'With --decide: the decision was the user\'s, not yours.' },
      { name: 'replaces', kind: 'string', value: 'SEQS', desc: 'With --decide: the decision seqs this one supersedes; they stop binding and stay in history.' },
      { name: 'retire', kind: 'string', value: 'SEQS', desc: 'Withdraw decisions by seq with nothing in their place; needs --with "<why>".' },
      { name: 'priority', kind: 'string', value: 'TEXT', desc: 'The remaining work this project is on now; survives the turn, a compaction and a resume (--thread binds it to one).' },
      { name: 'open', kind: 'string', value: 'TEXT', desc: 'Open a thread: one line saying what piece of work it is for.' },
      { name: 'thread', kind: 'int', value: 'ID', desc: 'Update an existing thread by the id `state` shows, keeping its text and id.' },
      { name: 'summary', kind: 'string', value: 'TEXT', desc: 'With --thread: where that work has actually got to, replacing the last summary.' },

      { name: 'label', kind: 'string', value: 'TEXT', desc: 'With --open/--thread: the next step in a few words, as the user\'s panel lists it ("Publish 0.4.1?").' },
      { name: 'rank', kind: 'string', value: 'IDS', desc: 'Open thread ids in the user\'s order of priority, most important first; restate the whole order each time.' },
      { name: 'evidence', kind: 'string', value: 'TEXT', desc: 'With --open/--thread: where to look for what established that — a branch, a commit, a report seq.' },
      { name: 'owner', kind: 'string', value: 'WHO', desc: 'With --open/--thread: you | user | a worker conv id | any other name.' },
      { name: 'next', kind: 'string', value: 'TEXT', desc: 'With --open/--thread: what advances this thread now.' },

      { name: 'waiting-on', kind: 'string', value: 'K:TEXT', desc: 'With --open/--thread: worker|decision|dependency|resource, then why (a worker kind may name the conv).' },
      { name: 'ready', kind: 'boolean', desc: 'With --open/--thread: nothing is blocking it.' },
      { name: 'worker', kind: 'string', value: 'CONV', desc: 'With --open/--thread: a worker carrying this thread.' },
      { name: 'addresses', kind: 'string', value: 'REFS', desc: 'With --thread/--close: the worker report/question seqs this accounts for (or a worker conv id for its pending ones on this thread).' },
      { name: 'close', kind: 'int', value: 'ID', desc: 'Close an open thread by the id `state` shows.' },
      { name: 'park', kind: 'int', value: 'ID', desc: 'Park an open thread: kept, not worked, out of the remaining-work list; needs --with "<why>".' },
      { name: 'unpark', kind: 'int', value: 'ID', desc: 'Bring a parked thread back as it was.' },
      { name: 'with', kind: 'string', value: 'TEXT', desc: 'With --close/--park/--retire/--reconcile/--account-from-now: the evidence or reason.' },

      { name: 'account-from-now', kind: 'boolean', desc: 'Start accounting for worker results here. Once only; everything earlier becomes history to reconcile.' },
      { name: 'reconcile', kind: 'string', value: 'SEQS', desc: 'Say what happened to reports from before accounting started, by seq; needs --as and --with.' },
      { name: 'as', kind: 'string', value: 'D', desc: 'With --reconcile: handled | superseded | open (open makes it wait on you from now).' },
      { name: 'now', kind: 'string', value: 'TEXT', desc: 'What this turn is doing; cleared when the turn ends.' },
      { name: 'host', kind: 'string', value: 'H', desc: 'Server host (default: from config).' },
      { name: 'port', kind: 'int', value: 'N', desc: 'Server port (default: from config).' },
      JSON_FLAG,
    ],
    notes: [
      'Different flags in one call are fine; each becomes its own note. Each flag\n' +
        '  takes one value, so a second decision is a second call. Notes are the\n' +
        '  server\'s durable record of what you decided: they come back to you after a\n' +
        '  compaction, your workers read them to orient themselves, and they are what\n' +
        '  anything answering on your behalf reads. A worker\'s finding is not a\n' +
        '  decision; it is already in the log as its report.',
      'A thread keeps the id it was opened with. --thread updates that same thread\n' +
        '  — a new owner, the next action, what it now waits on — rather than opening a\n' +
        '  second one, so a worker dispatched with `new --thread`, the report it writes\n' +
        '  and the closure all name one piece of work.',
      'A report or question a worker sent stays listed as waiting on your disposition\n' +
        '  until a thread transition names it: --addresses on the update or the close,\n' +
        '  or `session send --answers <seq>` for a question. Reading it does not clear\n' +
        '  it and neither does --now.',
      'That accounting runs from a boundary, not from the start of the log. A project\n' +
        '  started under it is accounted from its first dispatch. One that predates it\n' +
        '  has its earlier reports listed as history with an unknown disposition: they\n' +
        '  raise no reminder, because whatever closed them was written before anything\n' +
        '  recorded which report it closed. --account-from-now draws the boundary, and\n' +
        '  --reconcile <seq> --as handled|superseded|open --with "<what happened>" is\n' +
        '  how each one gets a disposition. There is no blanket clear, and nothing is\n' +
        '  inferred from the text of a note.',
      'A decision binds until something says otherwise, by seq. --decide "<the new\n' +
        '  rule>" --replaces <seq> records the correction and takes the old one out of\n' +
        '  the active set in the same note; --retire <seq> --with "<why>" withdraws one\n' +
        '  with nothing in its place. Neither deletes anything: `state --history` still\n' +
        '  shows the original and what replaced it. This is the alternative to a reader\n' +
        '  working out from the prose of 58 decisions which of two contradictory ones\n' +
        '  still applies.',
      '--priority is the work the project is on, and unlike --now it survives the turn.\n' +
        '  A later --priority replaces it, and closing the thread it names clears it.',
      '--summary on a thread is where the work has got to; the thread\'s own text stays\n' +
        '  the outcome it is for. "Built, not integrated" belongs in the summary, with\n' +
        '  --evidence saying where to look.',
    ],
  },
  {
    name: 'state',
    summary: 'Coordinator only: print the noted project state.',
    positionals: [{ name: 'conv', required: true }],
    flags: [
      { name: 'history', kind: 'boolean', desc: 'Also print what is no longer active: retired decisions, closed threads, pre-accounting reports.' },
      { name: 'host', kind: 'string', value: 'H', desc: 'Server host (default: from config).' },
      { name: 'port', kind: 'int', value: 'N', desc: 'Server port (default: from config).' },
      JSON_FLAG,
    ],
    notes: [
      'Prints the active record by default — what is true and what still binds. That\n' +
        '  is the same text the server puts in front of a project turn, so what you read\n' +
        '  here is what the session is acting on. Nothing is deleted: --history adds the\n' +
        '  decisions that were replaced, the threads that closed, and the reports from\n' +
        '  before accounting started.',
      'Ends with what is still queued at the workers carrying its open threads,\n' +
        '  when anything is. `workers` says the same per worker.',
    ],
  },

  {
    name: 'workers',
    summary: 'The workers a coordinator has dispatched, what each is on, and where it stands.',
    positionals: [{ name: 'conv', required: true }],
    flags: [
      { name: 'host', kind: 'string', value: 'H', desc: 'Server host (default: from config).' },
      { name: 'port', kind: 'int', value: 'N', desc: 'Server port (default: from config).' },
      JSON_FLAG,
    ],
    notes: [
      'Readable by anyone, including the workers themselves: a worker picked up\n' +
        '  from this coordinator can see who else is on the project and what they are\n' +
        '  doing without the coordinator naming them. The same is true of `state`.',
      'Both list what a worker has been sent and has not read yet, with the age of\n' +
        '  the oldest. Read means a turn was handed the message, not that the worker\n' +
        '  agreed with it or finished it — but an unread one has not landed at all,\n' +
        '  so check this before sending a follow-up that assumes the first arrived.',
    ],
  },
  {
    name: 'switch',
    summary: 'Coordinator only: move it to another provider and model, keeping the conversation, record and workers.',
    positionals: [{ name: 'conv', required: true }],
    flags: [
      { name: 'provider', kind: 'string', value: 'P', desc: 'Provider to move to (claude).' },
      { name: 'model', kind: 'string', value: 'ID', desc: 'Model to move to, e.g. claude-opus-5-5.' },
      { name: 'host', kind: 'string', value: 'H', desc: 'Server host (default: from config).' },
      { name: 'port', kind: 'int', value: 'N', desc: 'Server port (default: from config).' },
      JSON_FLAG,
    ],
    notes: [
      'Only between turns: it refuses, changing nothing, while the coordinator is\n' +
        '  mid-turn, compacting, holding a background task or an unread message, or\n' +
        '  while another send holds its next turn. Messages sent during the switch\n' +
        '  wait for it and go to the new model.',
      'The new model is not given the old one\'s context — a provider cannot hand\n' +
        '  that over. Its first turn is a handover from the server\'s records: the\n' +
        '  standing preamble, the workers, the full project state and the most recent\n' +
        '  exchanges verbatim, with the commands that reach older history. It answers\n' +
        '  that turn with one line, and only then is the switch complete; if it does\n' +
        '  not, the previous provider is started again and the switch is recorded as\n' +
        '  failed.',
      'A switch the server stopped in the middle of, or one whose previous provider\n' +
        '  would not start again, is unfinished: sends are kept in the inbox, not\n' +
        '  delivered, and say so. Running switch then undoes it and starts the\n' +
        '  previous provider (exit 1, nothing switched); run it again to switch.',
      'Within one provider a model change keeps the provider\'s own transcript, so\n' +
        '  it is not done here: send the next message with `send --model`.',
    ],
  },
  {
    name: 'react',
    summary: 'React with an emoji to the user\'s latest message in your conversation, as they see it.',
    positionals: [{ name: 'conv', required: true }, { name: 'emoji', required: true }],
    flags: [
      { name: 'message', kind: 'string', value: 'ID', desc: 'React to this message (`h-<seq>`) instead of their latest one you have read.' },
      { name: 'remove', kind: 'boolean', desc: 'Take the reaction back off.' },
      { name: 'host', kind: 'string', value: 'H', desc: 'Server host (default: from config).' },
      { name: 'port', kind: 'int', value: 'N', desc: 'Server port (default: from config).' },
      JSON_FLAG,
    ],
    notes: [
      '<conv> is your own conversation: the reaction goes on the user\'s message there, under it in their thread,\n' +
        '  and nobody is sent anything. Without --message it is the latest message of theirs that a turn of yours\n' +
        '  has taken in, not one still waiting.',
      'Pass the emoji itself (👍, not :thumbsup:). Use it sparingly, as an acknowledgement — "seen", "on it",\n' +
        '  "done" — and never instead of a reply they need.',
    ],
  },
  {
    name: 'permission',
    summary: 'Decide a worker\'s permission request, or hand it to the user.',
    positionals: [{ name: 'id', required: true }, { name: 'action', required: true }],
    flags: [
      { name: 'from', kind: 'string', value: 'CONV', desc: 'Your own conversation id: the coordinator the request was sent to.' },
      { name: 'reason', kind: 'string', value: 'TEXT', desc: 'With deny: what the worker should do instead. With escalate: one plain sentence telling the user why it is theirs.' },
      { name: 'host', kind: 'string', value: 'H', desc: 'Server host (default: from config).' },
      { name: 'port', kind: 'int', value: 'N', desc: 'Server port (default: from config).' },
      JSON_FLAG,
    ],
    notes: [
      '<action> is allow, deny or escalate. <id> is the request id in the permission message you received.',
      'allow and deny answer the worker at once and the user never sees the request. escalate shows it to the\n' +
        '  user, with your reason, in your thread and the worker\'s, and notifies them; do not also ask in the thread.',
    ],
  },
  {
    name: 'compact',
    summary: 'Compact a conversation\'s context, as typing /compact in its composer does.',
    positionals: [{ name: 'conv', required: true }],
    flags: [
      { name: 'host', kind: 'string', value: 'H', desc: 'Server host (default: from config).' },
      { name: 'port', kind: 'int', value: 'N', desc: 'Server port (default: from config).' },
      JSON_FLAG,
    ],
    notes: [
      'Refused while the conversation is in a turn; nothing is stopped. Run it again once the turn has ended.',
      '`send --message /compact` does not do this: a sent message reaches the agent as text under a sender\n' +
        '  header, so send refuses it and points here.',
    ],
  },
  {
    name: 'move-worker',
    summary: 'Move a worker to another project: its card, its later reports and anything it is still owed.',
    positionals: [{ name: 'conv', required: true }],
    flags: [
      { name: 'from', kind: 'string', value: 'CONV', desc: 'The coordinator it reports to now.' },
      { name: 'to', kind: 'string', value: 'CONV', desc: 'The coordinator it is to report to.' },
      { name: 'thread', kind: 'int', value: 'SEQ', desc: 'An open thread in the new project to attach it to.' },
      { name: 'host', kind: 'string', value: 'H', desc: 'Server host (default: from config).' },
      { name: 'port', kind: 'int', value: 'N', desc: 'Server port (default: from config).' },
      JSON_FLAG,
    ],
    notes: [
      'For splitting a project. The old project\'s card goes and the new one gets a card where the worker\n' +
        '  stood; its reports and questions go to the new coordinator from now on, including the one it ends a\n' +
        '  running turn with. Reports and questions the old project had not accounted for are copied to the new\n' +
        '  one, which owes them a disposition instead. A worker in a turn is sent a message saying where it now\n' +
        '  reports; an idle one is not, because the message would start it up. The new coordinator\'s next\n' +
        '  message reaches it from there.',
      'Refused while the old coordinator has an unread report or question from the worker: let it arrive first.',
      'Moving an open thread? Use move-thread, which brings the workers carrying it.',
    ],
  },
  {
    name: 'move-thread',
    summary: 'Move an open thread, and the workers carrying it, from one project\'s record to another\'s.',
    positionals: [{ name: 'seq', required: true }],
    flags: [
      { name: 'from', kind: 'string', value: 'CONV', desc: 'The coordinator whose record has the thread.' },
      { name: 'to', kind: 'string', value: 'CONV', desc: 'The coordinator to move it to.' },
      { name: 'host', kind: 'string', value: 'H', desc: 'Server host (default: from config).' },
      { name: 'port', kind: 'int', value: 'N', desc: 'Server port (default: from config).' },
      JSON_FLAG,
    ],
    notes: [
      'The thread gets a new id in the new record (an id is the seq of its open note there). It keeps its text,\n' +
        '  where it has got to, owner, next action, wait, workers and evidence, plus a pointer back; the old\n' +
        '  record closes it with where it went. Reports on it still owed a disposition are copied across.',
      'Its workers move with it unless one also carries another open thread in the old project; that one\n' +
        '  stays, and the output says so. Decisions are not threads: restate the ones the new project needs\n' +
        '  with note --decide.',
    ],
  },
  {
    name: 'archive',
    summary: 'Mark a session archived.',
    positionals: [{ name: 'conv', required: true }],
    flags: [],
  },
  {
    name: 'unarchive',
    summary: 'Clear the archived flag.',
    positionals: [{ name: 'conv', required: true }],
    flags: [],
    notes: [
      'A session created with --archived was never meant to be seen, and its coordinator\n' +
        '  sending it work leaves it hidden. Unarchiving is how you overrule that, and how\n' +
        '  a session archived before any of this was recorded is settled: from then on it\n' +
        '  is an ordinary session, and its coordinator sending it work reveals it again.',
    ],
  },
];

export const SESSION_VERBS_BY_NAME = new Map(SESSION_VERBS.map((v) => [v.name, v]));

// ---------------------------------------------------------------------------
// Parsing

export interface ParsedCommand {
  flags: Record<string, string | number | true>;
  positional: string[];
  /** Named positionals, resolved by spec order. `rest` positionals are joined. */
  named: Record<string, string>;
  helpRequested: boolean;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Closest known flag name, when it is close enough to be worth suggesting. */
export function suggestFlag(unknown: string, known: ReadonlyArray<string>): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of known) {
    const score = levenshtein(unknown, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  const threshold = unknown.length <= 4 ? 1 : 2;
  return best !== null && bestScore <= threshold ? best : null;
}

function resolveFlag(spec: VerbSpec, key: string): FlagSpec | undefined {
  return spec.flags.find((f) => f.name === key || f.aliases?.includes(key));
}

/**
 * Strict parse against a verb spec. Throws CliUsageError on an unknown flag, a
 * missing flag value, a non-numeric int flag, or the wrong positional count —
 * the caller turns that into a message plus exit 1.
 */
export function parseVerbArgs(spec: VerbSpec, args: ReadonlyArray<string>): ParsedCommand {
  const flags: Record<string, string | number | true> = {};
  const positional: string[] = [];
  let helpRequested = false;
  const label = `lattice session ${spec.name}`;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      helpRequested = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      // A bare `-x` is never valid here; catching it beats treating it as a
      // positional and failing later with a confusing "no such conversation".
      if (arg.startsWith('-') && arg.length > 1) {
        throw new CliUsageError(`unknown flag "${arg}" for ${label}`);
      }
      positional.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;

    const flagSpec = resolveFlag(spec, key);
    if (!flagSpec) {
      const known = spec.flags.map((f) => f.name);
      const suggestion = suggestFlag(key, known);
      throw new CliUsageError(
        `unknown flag "--${key}" for ${label}` +
          (suggestion ? ` (did you mean "--${suggestion}"?)` : '') +
          `\n  run "${label} --help" for accepted flags`,
      );
    }

    if (flagSpec.kind === 'boolean') {
      if (inlineValue !== undefined && inlineValue !== 'true' && inlineValue !== '1') {
        if (inlineValue === 'false' || inlineValue === '0') continue;
        throw new CliUsageError(`--${key} is a boolean flag and takes no value`);
      }
      flags[flagSpec.name] = true;
      continue;
    }

    // One value per flag. A repeat used to keep the last value and drop the
    // rest silently (a coordinator lost two of three --decide lines that way).
    if (flagSpec.name in flags) {
      throw new CliUsageError(`--${key} given more than once for ${label}; it takes one value per call`);
    }

    let raw = inlineValue;
    if (raw === undefined) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliUsageError(`--${key} needs a value (${flagSpec.value ?? 'VALUE'})`);
      }
      raw = next;
      i += 1;
    }

    if (flagSpec.kind === 'int') {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed)) {
        throw new CliUsageError(`--${key} needs an integer, got "${raw}"`);
      }
      flags[flagSpec.name] = parsed;
    } else {
      flags[flagSpec.name] = raw;
    }
  }

  const named: Record<string, string> = {};
  if (!helpRequested) {
    let cursor = 0;
    for (const p of spec.positionals) {
      if (p.rest) {
        const rest = positional.slice(cursor).join(' ');
        cursor = positional.length;
        if (rest) named[p.name] = rest;
      } else if (cursor < positional.length) {
        named[p.name] = positional[cursor];
        cursor += 1;
      }
      if (p.required && !named[p.name]) {
        throw new CliUsageError(`${label} requires <${p.name}>\n  usage: ${usageLine(spec)}`);
      }
    }
    if (cursor < positional.length) {
      throw new CliUsageError(
        `unexpected argument "${positional[cursor]}" for ${label}\n  usage: ${usageLine(spec)}`,
      );
    }
  }

  return { flags, positional, named, helpRequested };
}

// ---------------------------------------------------------------------------
// Help rendering

function positionalText(spec: VerbSpec): string {
  return spec.positionals
    .map((p) => {
      const inner = p.rest ? `${p.name}...` : p.name;
      return p.required ? `<${inner}>` : `[${inner}]`;
    })
    .join(' ');
}

export function usageLine(spec: VerbSpec): string {
  const parts = ['lattice session', spec.name, positionalText(spec)].filter(Boolean);
  const flagText = spec.flags
    .filter((f) => !f.hidden)
    .map((f) => (f.kind === 'boolean' ? `[--${f.name}]` : `[--${f.name} ${f.value ?? 'VALUE'}]`))
    .join(' ');
  return [parts.join(' ').trim(), flagText].filter(Boolean).join(' ');
}

export function renderVerbHelp(spec: VerbSpec): string {
  const lines: string[] = [];
  lines.push(`lattice session ${spec.name} — ${spec.summary}`);
  lines.push('');
  lines.push(`Usage:\n  ${usageLine(spec)}`);
  const visible = spec.flags.filter((f) => !f.hidden);
  if (visible.length > 0) {
    lines.push('');
    lines.push('Flags:');
    const width = Math.max(
      ...visible.map((f) => f.name.length + (f.kind === 'boolean' ? 0 : (f.value ?? 'VALUE').length + 1)),
    );
    for (const flag of visible) {
      const left = flag.kind === 'boolean' ? `--${flag.name}` : `--${flag.name} ${flag.value ?? 'VALUE'}`;
      lines.push(`  ${left.padEnd(width + 2)}  ${flag.desc}`);
    }
  }
  lines.push('');
  lines.push('  -h, --help  Show this help.');
  for (const note of spec.notes ?? []) {
    lines.push('');
    lines.push(`  ${note}`);
  }
  return lines.join('\n') + '\n';
}

export function renderSessionHelp(): string {
  const lines: string[] = [];
  lines.push('lattice session — browse and launch Lattice conversations');
  lines.push('');
  lines.push('Usage:');
  const width = Math.max(...SESSION_VERBS.map((v) => v.name.length));
  for (const spec of SESSION_VERBS) {
    lines.push(`  ${spec.name.padEnd(width)}  ${spec.summary}`);
  }
  lines.push('');
  lines.push('  lattice session <verb> --help    Flags and notes for one verb.');
  lines.push('');
  lines.push('All verbs except "new" and "send" read the session database directly and');
  lines.push('work with the server stopped.');
  return lines.join('\n') + '\n';
}

/** The `lattice session ...` block of the top-level help, generated from the spec. */
export function renderSessionUsageBlock(): string {
  return SESSION_VERBS.map((spec) => `  ${usageLine(spec)}\n${' '.repeat(6)}${spec.summary}`).join(
    '\n',
  );
}
