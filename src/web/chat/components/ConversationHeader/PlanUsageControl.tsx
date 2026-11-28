import { type JSX, type MouseEvent, type PointerEvent, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Gauge } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { ModelMark } from '../Composer/ModelMark';
import { parseJson } from '../../../../utils/json.js';

interface PlanLimit { window: 'session' | 'week' | 'other'; scope: string | null; percentUsed: number; resets: string | null }
type ClaudePlan =
  | { state: 'ok'; limits: PlanLimit[]; checkedAt: number }
  | { state: 'unavailable'; reason: string; checkedAt: number };
interface SpendWindow { usd: number; countedTurns: number; uncountedTurns: number }
type GeminiBudget = SpendWindow & { limitUsd: number; days: number };
interface GeminiLimit { id: string; group: string; window: 'week' | '5h' | 'other'; percentUsed: number; resetAt: number | null }
type GeminiPlan =
  | { state: 'ok'; limits: GeminiLimit[]; checkedAt: number }
  | { state: 'unavailable'; reason: string; checkedAt: number };
/**
 * `budget` is missing from a server started on code older than the 30-day figure,
 * and `geminiPlan` from one older than the plan reading or one billing a Cloud project.
 */
interface PlanUsage {
  claude: ClaudePlan;
  gemini: { today: SpendWindow; last7Days: SpendWindow; budget?: GeminiBudget };
  geminiPlan?: GeminiPlan;
  geminiMode?: 'plan' | 'api';
}

const POLL_MS = 5 * 60_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

async function fetchPlanUsage(): Promise<PlanUsage> {
  const response = await fetch('/api/plan-usage');
  if (!response.ok) throw new Error(`plan usage ${response.status}`);
  return parseJson(await response.text()) as PlanUsage;
}

/**
 * The reset moment from the CLI's wording ("Nov 27 at 2:59am", "Nov 27 at 3am"),
 * read in the browser's time zone, or null when the wording is something else.
 */
export function parseResetTime(resets: string, now: Date = new Date()): Date | null {
  const match = /^([A-Za-z]{3})\w* (\d{1,2}) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(resets);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month < 0) return null;
  const hour = (Number(match[3]) % 12) + (match[5].toLowerCase() === 'pm' ? 12 : 0);
  const date = new Date(now.getFullYear(), month, Number(match[2]), hour, Number(match[4] ?? 0));
  if (date.getTime() < now.getTime() - WEEK_MS) date.setFullYear(date.getFullYear() + 1);
  return date;
}

/** Share of the weekly window already gone, 0–100, or null when the reset can't be read. */
function weekElapsedPercent(limit: PlanLimit, now = Date.now()): number | null {
  if (limit.window !== 'week' || !limit.resets) return null;
  const reset = parseResetTime(limit.resets);
  if (!reset) return null;
  return Math.min(100, Math.max(0, ((now - (reset.getTime() - WEEK_MS)) / WEEK_MS) * 100));
}

/** Pace counts once a tenth of the window is gone; before that a few percent used says nothing about the week. */
const PACE_FROM_PERCENT = 10;

/**
 * One rule for every limit: grey while it lasts until the reset at the pace so
 * far, amber when it would run out before the reset, rose when it is used up
 * or would run out soon: within a day for a weekly limit, half an hour for a
 * 5-hour one (`soon`, as a share of the window). Pace is judged once a tenth
 * of the window is gone.
 */
function tone(percent: number, pace?: number | null, soon = 100 / 7): { text: string; fill: string } {
  const rose = { text: 'text-rose-300', fill: 'bg-rose-400' };
  if (percent >= 100) return rose;
  if (pace != null && pace >= PACE_FROM_PERCENT && percent > pace) {
    const windowLeftAtRunOut = (pace * 100) / percent - pace;
    return windowLeftAtRunOut < soon ? rose : { text: 'text-amber-400', fill: 'bg-amber-400' };
  }
  return { text: 'text-fg', fill: 'bg-fg-2' };
}

/** The CLI's reset wording, without the time zone when it is the browser's own. */
function resetText(resets: string): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resets.replace(` (${zone})`, '');
}

function usd(value: number): string {
  if (value === 0) return '$0';
  return value >= 10 ? `$${Math.round(value).toLocaleString('en-US')}` : `$${value.toFixed(2)}`;
}

/** "Nov 27 at 2:59am" as "Thu 3am" in the browser's zone, or the CLI's wording when it can't be read. */
function shortReset(resets: string): string {
  const date = parseResetTime(resets);
  if (!date) return resetText(resets);
  const rounded = new Date(Math.round(date.getTime() / 3_600_000) * 3_600_000);
  const day = rounded.toLocaleDateString('en-GB', { weekday: 'short' });
  const hour = rounded.getHours();
  return `${day} ${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'}`;
}

/** When a limit runs out at the pace so far, or null when it lasts until the reset or it is too early to judge. */
function runOutFrom(percentUsed: number, resetAt: number, span: number, now: number): Date | null {
  const start = resetAt - span;
  if (percentUsed <= 0 || percentUsed >= 100 || ((now - start) / span) * 100 < PACE_FROM_PERCENT) return null;
  const at = start + ((now - start) * 100) / percentUsed;
  return at < resetAt ? new Date(at) : null;
}

/** When the limit runs out at the pace so far, or null when it lasts until the reset. */
function runOutAt(limit: PlanLimit, now = Date.now()): Date | null {
  const reset = limit.resets ? parseResetTime(limit.resets) : null;
  return reset ? runOutFrom(limit.percentUsed, reset.getTime(), WEEK_MS, now) : null;
}

function shortTime(date: Date): string {
  const day = date.toLocaleDateString('en-GB', { weekday: 'short' });
  const hour = date.getHours();
  return `${day} ${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'}`;
}

/** A time within the next few hours, "9:40pm", for 5-hour limits. */
function clockTime(date: Date): string {
  const hour = date.getHours();
  const minutes = date.getMinutes();
  return `${hour % 12 || 12}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}${hour < 12 ? 'am' : 'pm'}`;
}

const windowMs = (limit: GeminiLimit): number => (limit.window === '5h' ? FIVE_HOURS_MS : WEEK_MS);

/** Share of a Gemini limit's window already gone, 0–100, or null when agy gives no reset. */
function geminiElapsedPercent(limit: GeminiLimit, now = Date.now()): number | null {
  if (limit.window === 'other' || limit.resetAt == null) return null;
  const span = windowMs(limit);
  return Math.min(100, Math.max(0, ((now - (limit.resetAt - span)) / span) * 100));
}

/** The pace tone for a Gemini limit: rose within a day of running out for the week, half an hour for the 5-hour limit. */
function geminiTone(limit: GeminiLimit): { text: string; fill: string } {
  return tone(limit.percentUsed, geminiElapsedPercent(limit), limit.window === '5h' ? 10 : 100 / 7);
}

/** When a Gemini limit runs out at the pace so far, or null when it lasts until the reset. */
function geminiRunOutAt(limit: GeminiLimit, now = Date.now()): Date | null {
  return limit.resetAt == null || limit.window === 'other' ? null : runOutFrom(limit.percentUsed, limit.resetAt, windowMs(limit), now);
}

/** The Gemini Models weekly and 5-hour limits, and every other model group agy reports. */
function geminiLimits(plan: GeminiPlan | undefined): { weekly: GeminiLimit | null; fiveHour: GeminiLimit | null; others: GeminiLimit[] } {
  const limits = plan?.state === 'ok' ? plan.limits : [];
  const mainGroup = limits.find((l) => /gemini/i.test(l.group))?.group ?? limits[0]?.group;
  const main = limits.filter((l) => l.group === mainGroup);
  return {
    weekly: main.find((l) => l.window === 'week') ?? null,
    fiveHour: main.find((l) => l.window === '5h') ?? null,
    others: limits.filter((l) => l.group !== mainGroup),
  };
}

/** The Gemini plan reading when Lattice uses the plan, or undefined when it bills the API or the server predates the reading. */
function geminiPlanOf(data: PlanUsage): GeminiPlan | undefined {
  return data.geminiMode === 'api' ? undefined : data.geminiPlan;
}

/**
 * The same rule for the Gemini budget: rose once spent, amber when the last
 * seven days' rate would pass it over the budget period, grey otherwise.
 */
function budgetTone(gemini: PlanUsage['gemini'], b: GeminiBudget): { text: string; stroke: string; fill: string } {
  if (b.usd >= b.limitUsd) return { text: 'text-rose-300', stroke: 'stroke-rose-400', fill: 'bg-rose-400' };
  if ((gemini.last7Days.usd / 7) * b.days > b.limitUsd) return { text: 'text-amber-400', stroke: 'stroke-amber-400', fill: 'bg-amber-400' };
  return { text: 'text-fg', stroke: 'stroke-fg-2', fill: 'bg-fg-2' };
}

const RING_STROKE = { 'text-fg': 'stroke-fg-2', 'text-amber-400': 'stroke-amber-400', 'text-rose-300': 'stroke-rose-400' } as Record<string, string>;

/** Header ring sizes in CSS pixels: the outer ring, the inner ring inside it, and the logo in the middle. */
const RING = { size: 40, outer: { radius: 18.5, width: 2.5 }, inner: { radius: 13.75, width: 2.5 }, logo: 14, soloLogo: 16 };

interface Arc { percent: number; stroke: string; radius: number; width: number }

/** Circular tracks around a logo, drawn at 40px and shown at 32px on phones with the logo scaled to match, each filled clockwise from 12 o'clock with square ends. */
function Ring({ arcs, children }: { arcs: Arc[]; children: JSX.Element }): JSX.Element {
  const c = RING.size / 2;
  return (
    <span className="relative inline-flex size-8 sm:size-10 items-center justify-center">
      <svg viewBox={`0 0 ${RING.size} ${RING.size}`} className="absolute inset-0 size-full -rotate-90" aria-hidden>
        {arcs.map(({ percent, stroke, radius, width }) => {
          const length = 2 * Math.PI * radius;
          const filled = (Math.min(100, Math.max(0, percent)) / 100) * length;
          return (
            <g key={radius}>
              <circle cx={c} cy={c} r={radius} fill="none" strokeWidth={width} className="stroke-line" />
              <circle cx={c} cy={c} r={radius} fill="none" strokeWidth={width} strokeLinecap="butt" className={stroke} strokeDasharray={`${filled} ${length}`} />
            </g>
          );
        })}
      </svg>
      <span className="inline-flex scale-80 sm:scale-100">{children}</span>
    </span>
  );
}

type Verdict = { text: string; color: string; limit?: PlanLimit };
const AMBER = 'text-amber-400';
const ROSE = 'text-rose-300';

/** When the Claude plan runs out: the first limit to run out at this pace, or that it lasts. */
function claudeVerdict(main: PlanLimit | null, fable: PlanLimit | null): Verdict {
  const limits = [main, fable].filter((l): l is PlanLimit => Boolean(l));
  const name = (l: PlanLimit) => (l === main ? '' : `${l.scope} `);
  const usedUp = limits.find((l) => l.percentUsed >= 100);
  if (usedUp) return { text: `${usedUp === main ? 'Used up' : `${usedUp.scope} used up`} until ${usedUp.resets ? shortReset(usedUp.resets) : 'the reset'}`, color: ROSE, limit: usedUp };
  const first = limits.map((l) => ({ l, at: runOutAt(l) })).filter((x) => x.at).sort((a, b) => a.at!.getTime() - b.at!.getTime())[0];
  if (first) return { text: `${name(first.l) ? `${name(first.l)}runs out` : 'Runs out'} ${shortTime(first.at!)}`, color: tone(first.l.percentUsed, weekElapsedPercent(first.l)).text, limit: first.l };
  return { text: 'Lasts until the reset', color: 'text-fg' };
}

/** When the Gemini plan runs out: a used-up limit, the first to run out at this pace, or that it lasts. */
function geminiPlanVerdict(weekly: GeminiLimit | null, fiveHour: GeminiLimit | null): Verdict & { gemini?: GeminiLimit } {
  const when = (l: GeminiLimit, at: Date) => (l.window === '5h' ? clockTime(at) : shortTime(at));
  const usedUp = weekly && weekly.percentUsed >= 100 ? weekly : fiveHour && fiveHour.percentUsed >= 100 ? fiveHour : null;
  if (usedUp) {
    const until = usedUp.resetAt != null ? when(usedUp, new Date(usedUp.resetAt)) : 'the reset';
    return { text: `${usedUp === fiveHour ? '5-hour limit used up' : 'Used up'} until ${until}`, color: ROSE, gemini: usedUp };
  }
  const first = [weekly, fiveHour]
    .filter((l): l is GeminiLimit => Boolean(l))
    .map((l) => ({ l, at: geminiRunOutAt(l) }))
    .filter((x): x is { l: GeminiLimit; at: Date } => x.at != null)
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (first) {
    const back = first.l === fiveHour && first.l.resetAt != null ? `, back at ${clockTime(new Date(first.l.resetAt))}` : '';
    return { text: `${first.l === fiveHour ? '5-hour limit runs out' : 'Runs out'} ${when(first.l, first.at)}${back}`, color: geminiTone(first.l).text, gemini: first.l };
  }
  return { text: 'Lasts until the reset', color: 'text-fg' };
}

function geminiVerdict(gemini: PlanUsage['gemini'], b: GeminiBudget): Verdict {
  if (b.usd >= b.limitUsd) return { text: `Over ${usd(b.limitUsd)} in the last ${b.days} days`, color: ROSE };
  return { text: `On pace for ${usd((gemini.last7Days.usd / 7) * b.days)} over ${b.days} days`, color: budgetTone(gemini, b).text };
}

const BAR_FILL: Record<string, string> = { [AMBER]: 'bg-amber-400', [ROSE]: 'bg-rose-400' };

function QuietBar({ percent, color }: { percent: number; color?: string }): JSX.Element {
  return (
    <div className="h-1 w-full rounded-full bg-surface-2">
      <div className={`h-full rounded-full ${(color && BAR_FILL[color]) || 'bg-fg-3'}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

function Row({ label, percent, value, color }: { label: string; percent: number; value: string; color?: string }): JSX.Element {
  return (
    <>
      <span className="text-fg-3">{label}</span>
      <QuietBar percent={percent} color={color} />
      <span className="text-right tabular-nums text-fg-2">{value}</span>
    </>
  );
}

function Heading({ title, aside }: { title: string; aside?: string | null }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[13px] font-medium text-fg">{title}</span>
      {aside && <span className="text-[11px] text-fg-3">{aside}</span>}
    </div>
  );
}

/** A model group's name short enough for a bar label: "Claude and GPT models" as "Claude, GPT". */
const groupLabel = (group: string): string => group.replace(/\s+models$/i, '').replace(/\s+and\s+/gi, ', ');

/** The Gemini plan's weekly and 5-hour limits, and the weekly limit of any other model group once it has been used. */
function GeminiPlanSection({ plan, grid }: { plan: GeminiPlan; grid: string }): JSX.Element {
  const { weekly, fiveHour, others } = geminiLimits(plan);
  const v = geminiPlanVerdict(weekly, fiveHour);
  const usedGroups = [...new Set(others.filter((l) => l.percentUsed > 0).map((l) => l.group))]
    .map((group) => others.find((l) => l.group === group && l.window === 'week'))
    .filter((l): l is GeminiLimit => Boolean(l));
  return (
    <>
      <Heading title="Gemini plan" aside={weekly?.resetAt != null ? `Resets ${shortTime(new Date(weekly.resetAt))}` : null} />
      {plan.state !== 'ok' ? (
        <p className="text-xs text-fg-3">Couldn't read the plan: {plan.reason}</p>
      ) : (
        <>
          <p className={`text-[15px] leading-5 ${v.color}`}>{v.text}</p>
          <div className={grid}>
            {weekly && <Row label="Weekly" percent={weekly.percentUsed} value={`${weekly.percentUsed}%`} color={v.gemini === weekly ? v.color : undefined} />}
            {fiveHour && <Row label="5-hour" percent={fiveHour.percentUsed} value={`${fiveHour.percentUsed}%`} color={v.gemini === fiveHour ? v.color : undefined} />}
            {usedGroups.map((l) => <Row key={l.group} label={groupLabel(l.group)} percent={l.percentUsed} value={`${l.percentUsed}%`} />)}
          </div>
        </>
      )}
    </>
  );
}

/** The breakdown behind the rings: the answer leads, in colour only when something runs out, and so does the bar behind it. */
function Panel({ data }: { data: PlanUsage }): JSX.Element {
  const limits = data.claude.state === 'ok' ? data.claude.limits : [];
  const main = limits.find((l) => l.window === 'week' && (!l.scope || /^all models$/i.test(l.scope))) ?? limits[0] ?? null;
  const fable = limits.find((l) => l !== main && l.window === 'week') ?? null;
  const b = data.gemini.budget;
  const plan = geminiPlanOf(data);
  const cv = claudeVerdict(main, fable);
  const gv = b ? geminiVerdict(data.gemini, b) : null;
  const all = b ? b.countedTurns + b.uncountedTurns : 0;
  const missing = b && all > 0 ? Math.round((b.uncountedTurns / all) * 100) : 0;
  const grid = 'grid grid-cols-[4.5rem_1fr_3rem] items-center gap-x-3 gap-y-2 text-xs';

  return (
    <div className="px-3.5 py-3.5">
      <div className="space-y-3">
        <Heading title="Claude plan" aside={main?.resets ? `Resets ${shortReset(main.resets)}` : null} />
        {data.claude.state !== 'ok' ? (
          <p className="text-xs text-fg-3">Couldn't read the plan: {data.claude.reason}</p>
        ) : (
          <>
            <p className={`text-[15px] leading-5 ${cv.color}`}>{cv.text}</p>
            <div className={grid}>
              {main && <Row label="All models" percent={main.percentUsed} value={`${main.percentUsed}%`} color={cv.limit === main ? cv.color : undefined} />}
              {fable && <Row label={fable.scope ?? 'Other'} percent={fable.percentUsed} value={`${fable.percentUsed}%`} color={cv.limit === fable ? cv.color : undefined} />}
            </div>
          </>
        )}
      </div>
      <div className="mt-4 space-y-3 border-t border-line/60 pt-4">
        {plan ? (
          <GeminiPlanSection plan={plan} grid={grid} />
        ) : (
          <>
            <Heading title="Gemini API" aside={b ? `${usd(b.limitUsd)} over ${b.days} days` : null} />
            {!b || !gv ? (
              <p className="text-xs text-fg-3">The 30-day figure needs a server restart</p>
            ) : (
              <>
                <p className={`text-[15px] leading-5 ${gv.color}`}>{gv.text}</p>
                <div className={grid}><Row label="Spent" percent={(b.usd / b.limitUsd) * 100} value={usd(b.usd)} color={gv.color} /></div>
                <p className="text-[11px] leading-4 text-fg-3">Estimated{missing > 0 ? `, ${missing}% of turns not counted` : ''}</p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The ringed Claude and Google logos, and a spoken summary of what they show. */
function usageRings(data: PlanUsage): { rings: JSX.Element; label: string } {
  const limits = data.claude.state === 'ok' ? data.claude.limits : [];
  const main = limits.find((l) => l.window === 'week' && (!l.scope || /^all models$/i.test(l.scope))) ?? limits[0] ?? null;
  const fable = limits.find((l) => l !== main && l.window === 'week') ?? null;
  const strokeFor = (l: PlanLimit) => RING_STROKE[tone(l.percentUsed, weekElapsedPercent(l)).text] ?? 'stroke-fg-3';
  const claudeArcs: Arc[] = [
    ...(main ? [{ percent: main.percentUsed, stroke: strokeFor(main), ...RING.outer }] : []),
    ...(fable ? [{ percent: fable.percentUsed, stroke: strokeFor(fable), ...RING.inner }] : []),
  ];
  const budget = data.gemini.budget;
  const geminiStroke = budget ? budgetTone(data.gemini, budget).stroke : 'stroke-fg-3';
  const plan = geminiPlanOf(data);
  const { weekly, fiveHour } = geminiLimits(plan);
  const geminiArcs: Arc[] = [
    ...(weekly ? [{ percent: weekly.percentUsed, stroke: RING_STROKE[geminiTone(weekly).text] ?? 'stroke-fg-3', ...RING.outer }] : []),
    ...(fiveHour ? [{ percent: fiveHour.percentUsed, stroke: RING_STROKE[geminiTone(fiveHour).text] ?? 'stroke-fg-3', ...(weekly ? RING.inner : RING.outer) }] : []),
  ];
  const geminiLabel = plan
    ? (geminiArcs.length > 0
      ? [weekly ? `Gemini weekly ${weekly.percentUsed}% used` : null, fiveHour ? `5-hour ${fiveHour.percentUsed}% used` : null].filter(Boolean).join(', ')
      : 'Gemini plan unreadable')
    : budget ? `Gemini ${usd(budget.usd)} of ${usd(budget.limitUsd)} estimated` : 'Gemini 30-day figure unavailable';
  const label = [
    main ? `Claude all models ${main.percentUsed}% used` : 'Claude plan unreadable',
    fable ? `${fable.scope} ${fable.percentUsed}% used` : null,
    geminiLabel,
  ].filter(Boolean).join(', ');
  const rings = (
    <>
      {main ? (
        <Ring arcs={claudeArcs}><span className={fable ? 'text-fg-3' : 'text-fg-2'}><ModelMark kind="claude" size={fable ? RING.logo : RING.soloLogo} /></span></Ring>
      ) : (
        <span className="relative">
          <Ring arcs={[{ percent: 0, stroke: 'stroke-fg-3', ...RING.outer }]}><span className="text-fg-2 opacity-50"><ModelMark kind="claude" size={RING.soloLogo} /></span></Ring>
          <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-bg p-px"><AlertTriangle size={10} className="text-rose-300" aria-hidden /></span>
        </span>
      )}
      {!plan ? (
        <Ring arcs={[{ percent: budget ? (budget.usd / budget.limitUsd) * 100 : 0, stroke: geminiStroke, ...RING.outer }]}>
          <span className={budget ? 'text-fg-2' : 'text-fg-2 opacity-50'}><ModelMark kind="antigravity" size={RING.soloLogo - 1} /></span>
        </Ring>
      ) : geminiArcs.length > 0 ? (
        <Ring arcs={geminiArcs}>
          <span className={geminiArcs.length > 1 ? 'text-fg-3' : 'text-fg-2'}><ModelMark kind="antigravity" size={(geminiArcs.length > 1 ? RING.logo : RING.soloLogo) - 1} /></span>
        </Ring>
      ) : (
        <span className="relative">
          <Ring arcs={[{ percent: 0, stroke: 'stroke-fg-3', ...RING.outer }]}><span className="text-fg-2 opacity-50"><ModelMark kind="antigravity" size={RING.soloLogo - 1} /></span></Ring>
          <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-bg p-px"><AlertTriangle size={10} className="text-rose-300" aria-hidden /></span>
        </span>
      )}
    </>
  );

  return { rings, label };
}

/** Phone menu row: the rings beside "Usage"; tapping the row shows the figures inline beneath it. */
export function PlanUsageMenuRow({ open, onToggle, className }: { open: boolean; onToggle: () => void; className: string }): JSX.Element | null {
  const { data } = useQuery({ queryKey: ['plan-usage'], queryFn: fetchPlanUsage, refetchInterval: POLL_MS, staleTime: POLL_MS });
  if (!data) return null;
  const { rings, label } = usageRings(data);
  return (
    <>
      <button type="button" data-testid="plan-usage" aria-expanded={open} aria-label={`Usage: ${label}`} onClick={onToggle} className={`${className} justify-between`}>
        <span className="flex items-center gap-3"><Gauge size={16} />Usage</span>
        <span className="flex items-center gap-2">{rings}<ChevronDown size={14} className={`text-fg-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden /></span>
      </button>
      {open && <div className="-mx-0.5"><Panel data={data} /></div>}
    </>
  );
}

/** The strongest tone the usage rings show, for a phone menu icon that stands in for them: rose, amber, or null while all are grey. */
export function usePlanUsageAlert(): 'rose' | 'amber' | null {
  const { data } = useQuery({ queryKey: ['plan-usage'], queryFn: fetchPlanUsage, refetchInterval: POLL_MS, staleTime: POLL_MS });
  return data ? planUsageAlert(data) : null;
}

/** The strongest tone across the Claude plan's weekly limits and the Gemini plan (or API budget). */
export function planUsageAlert(data: PlanUsage): 'rose' | 'amber' | null {
  const tones = (data.claude.state === 'ok' ? data.claude.limits.filter((l) => l.window === 'week') : []).map((l) => tone(l.percentUsed, weekElapsedPercent(l)).text);
  const plan = geminiPlanOf(data);
  if (plan) {
    const { weekly, fiveHour } = geminiLimits(plan);
    for (const l of [weekly, fiveHour]) if (l) tones.push(geminiTone(l).text);
  } else if (data.gemini.budget) tones.push(budgetTone(data.gemini, data.gemini.budget).text);
  return tones.includes('text-rose-300') ? 'rose' : tones.includes('text-amber-400') ? 'amber' : null;
}

/**
 * Header control: will the Claude and Gemini plans run out before they reset?
 * Hover or tap for each plan limit.
 */
export function PlanUsageControl({ align = 'end' }: { align?: 'start' | 'end' }): JSX.Element | null {
  const { data } = useQuery({ queryKey: ['plan-usage'], queryFn: fetchPlanUsage, refetchInterval: POLL_MS, staleTime: POLL_MS });
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!data) return null;

  const hoverOpen = () => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true); };
  const hoverClose = () => { if (!pinned.current) closeTimer.current = setTimeout(() => setOpen(false), 150); };
  const mouseOnly = (handler: () => void) => (event: PointerEvent) => { if (event.pointerType === 'mouse') handler(); };
  const onOpenChange = (next: boolean) => { if (!next) pinned.current = false; setOpen(next); };
  const onTriggerClick = (event: MouseEvent) => {
    if (open && !pinned.current) { event.preventDefault(); pinned.current = true; return; }
    pinned.current = !open;
  };

  const { rings: trigger, label } = usageRings(data);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="plan-usage"
          aria-label={label}
          onClick={onTriggerClick}
          onPointerEnter={mouseOnly(hoverOpen)}
          onPointerLeave={mouseOnly(hoverClose)}
          className="flex items-center gap-3 sm:gap-1.5 h-11 px-0.5 rounded-md cursor-pointer touch-manipulation"
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={6}
        onPointerEnter={mouseOnly(hoverOpen)}
        onPointerLeave={mouseOnly(hoverClose)}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-72 max-w-[calc(100vw-24px)] p-0 shadow-none z-[100] overflow-hidden"
      >
        <Panel data={data} />
      </PopoverContent>
    </Popover>
  );
}
