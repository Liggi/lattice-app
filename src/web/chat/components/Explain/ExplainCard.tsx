import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, CircleSlash } from 'lucide-react';
import { tk } from '@liggi/agent-ui-toolkit';
import {
  STATUS_TEXT,
  shownMark,
  type ExplainAskedData,
  type ExplainCheckedData,
  type ExplainState,
  type ExplainStatus,
} from '@/types/explain';

const ExplainsContext = createContext<{ sessionId?: string; explains: ReadonlyMap<string, ExplainState> } | null>(null);

export function ExplainsProvider({ sessionId, explains, children }: {
  sessionId?: string;
  explains: ReadonlyMap<string, ExplainState>;
  children: ReactNode;
}): JSX.Element {
  return <ExplainsContext.Provider value={{ sessionId, explains }}>{children}</ExplainsContext.Provider>;
}

/** Long enough that a check waits for a pause, short enough that the marks feel live. */
const DEBOUNCE_MS = 700;

async function post<T>(sessionId: string, explainId: string, action: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(`/api/harness/${encodeURIComponent(sessionId)}/explain/${encodeURIComponent(explainId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(json?.error ?? `HTTP ${response.status}`);
  return json as T;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

const STATUS_TONE: Record<ExplainStatus, string> = {
  'keep-going': tk.text.muted,
  'add-more': 'text-amber-700 dark:text-amber-400',
  revisit: 'text-rose-600 dark:text-rose-400',
  demonstrated: 'text-emerald-700 dark:text-emerald-400',
};

const MARK = {
  met: { glyph: '✓', word: 'Got it', tone: 'text-emerald-700 dark:text-emerald-400' },
  part: { glyph: '~', word: 'Add more', tone: 'text-amber-700 dark:text-amber-400' },
  revisit: { glyph: '!', word: 'Revisit', tone: 'text-rose-600 dark:text-rose-400' },
  none: { glyph: '–', word: '', tone: tk.text.faint },
} as const;

const QUIET_BTN = `text-[13px] ${tk.text.muted} hover:text-parchment-900 dark:hover:text-stone-200 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`;
const PRIMARY_BTN = 'px-3 py-1.5 rounded-md bg-cyan-500/10 dark:bg-cyan-400/10 text-cyan-700 dark:text-cyan-400 text-[13px] font-medium hover:bg-cyan-500/20 dark:hover:bg-cyan-400/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * An agent's explain-back (`lattice explain`): the user explains something
 * in their own words, and at each pause the card shows which of the hidden
 * ideas their draft has. An idea's name shows once the draft touches it; a
 * hint is there for any idea not yet got. A stated misconception underlines
 * the sentence that says it and turns its idea to Revisit. Done (or Stop
 * here) hands the agent the result.
 */
export function ExplainCard({ explain }: { explain: ExplainAskedData }): JSX.Element {
  const context = useContext(ExplainsContext);
  const state = context?.explains.get(explain.id);
  if (state?.finished) return <FinishedExplain state={state} />;
  return <OpenExplain explain={explain} state={state} sessionId={context?.sessionId} />;
}

function OpenExplain({ explain, state, sessionId }: { explain: ExplainAskedData; state?: ExplainState; sessionId?: string }): JSX.Element {
  const draftKey = `explain-draft:${explain.id}`;
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? state?.last?.text ?? '');
  const [checked, setChecked] = useState<ExplainCheckedData | null>(state?.last ?? null);
  const [activity, setActivity] = useState<'idle' | 'checking' | 'failed'>('idle');
  const [openHints, setOpenHints] = useState<Record<string, 'hint' | 'noted'>>({});
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const lastSent = useRef(state?.last?.text ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);

  const runCheck = useCallback(async (draft: string) => {
    if (!sessionId || !draft.trim() || draft.trim() === lastSent.current) return;
    lastSent.current = draft.trim();
    const mine = ++seq.current;
    setActivity('checking');
    try {
      const result = await post<ExplainCheckedData>(sessionId, explain.id, 'check', { text: draft });
      if (mine !== seq.current) return;
      setChecked(result);
      setActivity('idle');
    } catch {
      if (mine !== seq.current) return;
      lastSent.current = '';
      setActivity('failed');
    }
  }, [sessionId, explain.id]);

  // A draft restored from this device that was never checked is checked on load.
  useEffect(() => {
    if (text.trim() && text.trim() !== lastSent.current) void runCheck(text);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onType = (value: string) => {
    setText(value);
    localStorage.setItem(draftKey, value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void runCheck(value), DEBOUNCE_MS);
  };

  const empty = !text.trim();
  const marks = !empty && checked ? checked.marks : {};
  const flags = !empty && checked ? checked.flags : [];
  const status: ExplainStatus = empty || !checked ? 'keep-going' : checked.status;

  let marked = esc(text);
  for (const flag of flags) {
    if (flag.sentence && text.includes(flag.sentence)) marked = marked.replace(esc(flag.sentence), `<mark>${esc(flag.sentence)}</mark>`);
  }
  const nudge = flags.map((flag) => ({ flag, misconception: explain.misconceptions.find((m) => m.id === flag.id) })).find((f) => f.misconception);

  const toggleHint = (idea: string) => {
    const opening = openHints[idea] !== 'hint';
    setOpenHints((open) => ({ ...open, [idea]: opening ? 'hint' : undefined } as Record<string, 'hint' | 'noted'>));
    if (opening && sessionId) void post(sessionId, explain.id, 'hint', { idea }).catch(() => undefined);
  };
  const dispute = (idea: string) => {
    setOpenHints((open) => ({ ...open, [idea]: 'noted' }));
    if (sessionId) void post(sessionId, explain.id, 'dispute', { idea, text }).catch(() => undefined);
  };
  const finish = async () => {
    if (!sessionId) return;
    if (timer.current) clearTimeout(timer.current);
    seq.current++;
    setFinishing(true);
    setError(null);
    try {
      await post(sessionId, explain.id, 'finish', { text });
      localStorage.removeItem(draftKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFinishing(false);
    }
  };

  const textClasses = 'block w-full m-0 border-0 px-3 py-2.5 text-[15px] leading-[1.6] whitespace-pre-wrap break-words';

  return (
    <div data-testid="explain-card" className={`w-full rounded-lg border ${tk.card.border} ${tk.card.bg} px-3.5 pt-3 pb-3`}>
      <div className={`text-[10px] uppercase tracking-wider ${tk.text.muted}`}>Explain it back</div>
      <p className={`mt-1 text-[15px] leading-[1.5] font-medium ${tk.text.heading}`}>{explain.prompt}</p>

      <div className="mt-2.5 rounded-md border border-parchment-300 dark:border-white/[0.14] focus-within:border-cyan-500/60 dark:focus-within:border-cyan-400/50 transition-colors">
        <div className={`relative ${tk.surface} rounded-t-md`}>
          <div
            ref={backdrop}
            aria-hidden
            className={`${textClasses} absolute inset-0 overflow-hidden pointer-events-none text-transparent [&_mark]:text-transparent [&_mark]:bg-transparent [&_mark]:border-b-[1.5px] [&_mark]:border-rose-500 [&_mark]:bg-[linear-gradient(transparent_62%,rgba(244,63,94,0.18)_62%)]`}
            dangerouslySetInnerHTML={{ __html: `${marked}\n` }}
          />
          <textarea
            value={text}
            onChange={(e) => onType(e.target.value)}
            onScroll={(e) => { if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop; }}
            disabled={finishing}
            rows={6}
            spellCheck={false}
            aria-label="Your explanation"
            placeholder="Explain it in your own words"
            className={`${textClasses} relative z-[1] min-h-[150px] resize-y bg-transparent outline-none ${tk.text.primary}`}
          />
        </div>
        <div className={`flex items-center justify-between gap-3 border-t ${tk.separator} px-3 py-1.5 text-[12.5px]`}>
          <span data-testid="explain-status" className={`font-medium ${STATUS_TONE[status]}`}>{STATUS_TEXT[status]}</span>
          <span className={activity === 'failed' ? 'text-rose-600 dark:text-rose-400' : tk.text.faint}>
            {activity === 'checking' ? 'Checking…' : activity === 'failed' ? 'Check failed. Keep typing to retry' : 'Checks as you type'}
          </span>
        </div>
      </div>

      {nudge && (
        <div className="mt-2.5 rounded-md bg-rose-500/[0.07] dark:bg-rose-400/[0.08] px-3 py-2 text-[13.5px] leading-[1.5] text-rose-800 dark:text-rose-200">
          {nudge.flag.sentence && <span className="font-semibold">Look again at the underlined sentence. </span>}
          {nudge.misconception?.nudge}
        </div>
      )}

      <div className="mt-3">
        {explain.ideas.map((idea, n) => {
          const shown = empty ? 'none' : shownMark(explain, marks, flags, idea.id);
          const mark = MARK[shown];
          const open = openHints[idea.id];
          return (
            <div key={idea.id} className={`border-t ${tk.separator} last:border-b`}>
              <div className="flex items-center gap-2.5 py-2 text-[14px]">
                <span className={`w-4 text-center font-bold ${mark.tone}`}>{mark.glyph}</span>
                <span className={`flex-1 ${shown === 'none' ? tk.text.muted : tk.text.primary}`}>{shown === 'none' ? `Idea ${n + 1}` : idea.label}</span>
                {mark.word && <span className={`text-[12.5px] ${mark.tone}`}>{mark.word}</span>}
                {shown !== 'met' && (
                  <button type="button" onClick={() => toggleHint(idea.id)} className={`${QUIET_BTN} pl-2`} data-testid="explain-hint">
                    Hint
                  </button>
                )}
              </div>
              {open === 'hint' && shown !== 'met' && (
                <div className={`pb-2 pl-[26px] text-[13.5px] leading-[1.5] ${tk.text.secondary}`}>
                  {idea.hint}
                  {shown !== 'none' && (
                    <button type="button" onClick={() => dispute(idea.id)} className={`${QUIET_BTN} ml-2.5`}>
                      I covered this
                    </button>
                  )}
                </div>
              )}
              {open === 'noted' && (
                <div className={`pb-2 pl-[26px] text-[13.5px] ${tk.text.secondary}`}>Noted. It goes to the agent with your result.</div>
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="mt-2 text-[13px] text-rose-600 dark:text-rose-300">Not sent: {error}</p>}

      <div className="mt-3 flex items-center justify-end gap-3">
        {status !== 'demonstrated' && !empty && (
          <button type="button" onClick={() => void finish()} disabled={finishing || !sessionId} className={QUIET_BTN} data-testid="explain-stop">
            Stop here
          </button>
        )}
        <button type="button" onClick={() => void finish()} disabled={status !== 'demonstrated' || finishing || !sessionId} className={PRIMARY_BTN} data-testid="explain-done">
          Done
        </button>
      </div>
    </div>
  );
}

/** A finished card: what the user wrote, and how each idea ended, with the ideas they did not get spelled out. */
function FinishedExplain({ state }: { state: ExplainState }): JSX.Element {
  const { asked, last, finished } = state;
  const marks = last?.marks ?? {};
  const flags = last?.flags ?? [];
  return (
    <div data-testid="explain-card-finished" className={`w-full rounded-lg border ${tk.card.border} ${tk.card.bg} px-3.5 py-2.5`}>
      <div className="flex items-start gap-2 text-sm leading-[1.55]">
        {finished?.passed
          ? <CheckCircle2 size={14} className="mt-[3px] shrink-0 text-emerald-600 dark:text-emerald-400" />
          : <CircleSlash size={14} className={`mt-[3px] shrink-0 ${tk.text.muted}`} />}
        <div className="min-w-0 flex-1">
          <div className={tk.text.muted}>{asked.prompt}</div>
          {finished?.text && <div className={`mt-0.5 ${tk.text.heading} whitespace-pre-wrap break-words`}>{finished.text}</div>}
          <div className="mt-2">
            {asked.ideas.map((idea) => {
              const shown = finished?.text ? shownMark(asked, marks, flags, idea.id) : 'none';
              const mark = MARK[shown];
              return (
                <div key={idea.id} className="flex items-baseline gap-2.5 py-0.5 text-[13.5px]">
                  <span className={`w-4 shrink-0 text-center font-bold ${mark.tone}`}>{mark.glyph}</span>
                  <span className="min-w-0 flex-1">
                    <span className={tk.text.primary}>{idea.label}</span>
                    {shown !== 'met' && <span className={`block ${tk.text.secondary}`}>{idea.statement}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
