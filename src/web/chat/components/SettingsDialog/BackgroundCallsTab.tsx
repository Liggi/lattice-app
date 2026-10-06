import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { BackgroundJob, BackgroundRoute } from '@/types/config';
import { endpointHost } from '@/constants/claude-endpoint';
import { parseJson } from '../../../../utils/json.js';
import { api } from '../../services/api';
import type { AppConfig, ClaudeEndpointSetting } from '../../services/api/types';

/** The jobs Settings lists, in the order people meet them. Turn capture is dormant and left out. */
const JOBS: Array<{ job: BackgroundJob; name: string; detail: string }> = [
  { job: 'insights', name: 'Session names', detail: 'Names each session and keeps its purpose current' },
  { job: 'projectName', name: 'Project names', detail: 'The sidebar title of each project' },
  { job: 'workerActivity', name: 'Activity lines', detail: 'What each worker is doing, on its card' },
  { job: 'workerReportSummary', name: 'Report summaries', detail: 'The top of each worker report' },
  { job: 'sessionSummary', name: 'Session summaries', detail: 'A short account of each session' },
  { job: 'sessionReview', name: 'Session reviews', detail: 'When you ask for one' },
  { job: 'permissionPatterns', name: 'Permission suggestions', detail: 'Patterns offered on an approval prompt' },
];

interface PlanStatus { active: string | null; accounts: Array<{ id: string; connected: boolean; paused: string | null; verifiedModel: string | null }> }
interface BackgroundStatus { planStandIn: { since: number; lastUsedAt: number; jobs: BackgroundJob[] } | null; enabled: Partial<Record<BackgroundJob, boolean>> }

/** Which row is open: the default route, one job, or the paused-plan stand-in. */
type Editing = { kind: 'default' } | { kind: 'job'; job: BackgroundJob } | { kind: 'standIn' } | null;

const QUIET_BTN = 'px-2.5 py-1.5 rounded-md text-[13px] text-fg-3 hover:text-fg hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-50';
const PRIMARY_BTN = 'flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent-soft text-accent text-[13px] font-medium hover:bg-accent/20 transition-colors cursor-pointer disabled:opacity-50';
const INPUT = 'w-full px-3 py-2 bg-bg border border-line-2 rounded-md text-sm font-mono text-fg placeholder:font-sans placeholder:text-fg-3 focus:outline-none focus:border-accent disabled:opacity-50';
const SELECT = 'block w-full min-w-0 rounded-md border border-line-2 bg-bg px-2 py-2 text-sm text-fg focus:outline-none focus:border-accent disabled:opacity-50';

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = parseJson(await response.text()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function routeKey(route: BackgroundRoute | null): string {
  if (!route) return '';
  return route.provider === 'endpoint' ? `endpoint:${route.endpointId ?? ''}` : route.provider;
}

/** Where a route sends calls and with which model, as two lines. */
function describe(route: BackgroundRoute, endpoints: ClaudeEndpointSetting[], planModel: string | null): { where: string; model: string | null; missing?: boolean } {
  if (route.provider === 'chatgpt-plan') return { where: 'ChatGPT plan', model: planModel };
  if (route.provider === 'anthropic-api') return { where: 'Anthropic API', model: route.model ?? null };
  const endpoint = endpoints.find((candidate) => candidate.id === route.endpointId);
  if (!endpoint) return { where: 'Removed endpoint', model: null, missing: true };
  return { where: endpointHost(endpoint.baseUrl), model: route.model || endpoint.model };
}

export function BackgroundCallsTab({ onOpenProviders }: { onOpenProviders: () => void }): JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [plan, setPlan] = useState<PlanStatus | null>(null);
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextConfig, nextPlan, nextStatus] = await Promise.all([
      api.getConfig(),
      getJson<PlanStatus>('/api/chatgpt-plan/status').catch(() => null),
      getJson<BackgroundStatus>('/api/background/status'),
    ]);
    setConfig(nextConfig); setPlan(nextPlan); setStatus(nextStatus);
  }, []);

  useEffect(() => { void refresh().catch((failure: Error) => setError(failure.message)); }, [refresh]);

  if (!config || !status) {
    return error
      ? <p className="text-xs text-rose-300">{error}</p>
      : <p className="flex items-center gap-2 text-[13px] text-fg-3"><Loader2 size={14} className="animate-spin" />Loading…</p>;
  }

  const background = config.backgroundInference ?? { provider: 'anthropic-api' as const };
  const endpoints = config.claudeEndpoints ?? [];
  const account = plan?.accounts.find((candidate) => candidate.id === plan.active);
  const planReady = !!account?.connected && !!account.verifiedModel && account.verifiedModel === background.model;
  const planModel = background.model ?? account?.verifiedModel ?? null;
  const planPaused = !!account?.paused;
  const defaultRoute: BackgroundRoute = background.provider === 'endpoint'
    ? { provider: 'endpoint', endpointId: background.endpointId }
    : { provider: background.provider };
  const standIn = background.whenPlanPaused ?? null;
  const routeOf = (job: BackgroundJob): BackgroundRoute => background.jobs?.[job] ?? defaultRoute;
  const planJobs = JOBS.filter(({ job }) => routeOf(job).provider === 'chatgpt-plan' && status.enabled[job]);

  const save = async (update: AppConfig): Promise<void> => {
    await api.updateConfig({ backgroundInference: { ...background, ...update.backgroundInference }, ...(update.generation ? { generation: update.generation } : {}) });
    await refresh();
    setEditing(null);
  };

  const formProps = { endpoints, planReady, planModel, onOpenProviders, onCancel: () => setEditing(null) };
  const standInText = standIn ? describe(standIn, endpoints, planModel) : null;

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-fg-3">
        The small model calls Lattice makes on its own. Each job can run on its own route and model.
      </p>

      {planPaused && planJobs.length > 0 && (
        <p className="flex items-start gap-2 border border-line rounded-lg bg-bg px-4 py-3 text-[13px] text-fg-2" data-testid="plan-paused-notice">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />
          <span>
            {standInText
              ? `ChatGPT plan paused at its usage limit. Its jobs run on ${standInText.model ? `${standInText.model} (${standInText.where})` : standInText.where} until it resumes.${status.planStandIn ? ` Since ${new Date(status.planStandIn.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}`
              : `ChatGPT plan paused at its usage limit, so ${listJobs(planJobs.map(({ name }) => name))} ${planJobs.length === 1 ? 'is' : 'are'} waiting. Resume it under Providers, or choose a stand-in below.`}
          </span>
        </p>
      )}

      <section className="border border-line rounded-lg bg-bg" aria-label="Background jobs">
        {editing?.kind === 'default' ? (
          <RouteForm
            {...formProps}
            title="Default route"
            initial={defaultRoute}
            allowModel={false}
            onSubmit={(route) => save({ backgroundInference: { ...background, ...(route ?? { provider: 'anthropic-api' }), model: background.model } })}
          />
        ) : (
          <RouteRow
            name="Default"
            detail="Every job without a route of its own"
            route={describe(defaultRoute, endpoints, planModel)}
            onChange={() => setEditing({ kind: 'default' })}
            strong
          />
        )}
        {JOBS.map(({ job, name, detail }) => {
          const own = background.jobs?.[job];
          const enabled = status.enabled[job] === true;
          const route = routeOf(job);
          const standingIn = planPaused && route.provider === 'chatgpt-plan' && enabled;
          if (editing?.kind === 'job' && editing.job === job) {
            return (
              <RouteForm
                key={job}
                {...formProps}
                title={name}
                initial={own ?? null}
                allowDefault
                enabled={enabled}
                allowModel
                onSubmit={(next, nextEnabled) => {
                  const jobs = { ...background.jobs };
                  if (next) jobs[job] = next; else delete jobs[job];
                  return save({ backgroundInference: { ...background, jobs }, ...(nextEnabled !== enabled ? { generation: { [job]: nextEnabled } } : {}) });
                }}
              />
            );
          }
          return (
            <RouteRow
              key={job}
              name={name}
              detail={detail}
              route={enabled ? (own ? describe(own, endpoints, planModel) : { where: 'Same as default', model: null, quiet: true }) : { where: 'Off', model: null, quiet: true }}
              note={standingIn ? (standInText ? `On ${standInText.model ?? standInText.where} while the plan is paused` : 'Waiting for the plan') : null}
              onChange={() => setEditing({ kind: 'job', job })}
            />
          );
        })}
      </section>

      <section className="border border-line rounded-lg bg-bg" aria-label="When the ChatGPT plan is paused">
        {editing?.kind === 'standIn' ? (
          <RouteForm
            {...formProps}
            title="When the ChatGPT plan is paused"
            initial={standIn}
            allowWait
            allowModel
            onSubmit={(route) => save({ backgroundInference: { ...background, whenPlanPaused: route } })}
          />
        ) : (
          <RouteRow
            name="When the ChatGPT plan is paused"
            detail="The plan pauses at its usage limit. Jobs on it wait, or run here until it resumes."
            route={standInText ?? { where: 'Wait until it resumes', model: null, quiet: true }}
            onChange={() => setEditing({ kind: 'standIn' })}
          />
        )}
      </section>

      {error && <p className="text-xs text-rose-300">{error}</p>}
    </div>
  );
}

function listJobs(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** One job: what it is on the left, where it runs on the right, and the button that opens it. */
function RouteRow({ name, detail, route, note, onChange, strong }: {
  name: string;
  detail: string;
  route: { where: string; model: string | null; quiet?: boolean; missing?: boolean };
  note?: string | null;
  onChange: () => void;
  strong?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line first:border-t-0 px-4 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <p className={`text-sm ${strong ? 'font-medium' : ''} text-fg`}>{name}</p>
        <p className="mt-0.5 text-xs text-fg-3">{detail}</p>
      </div>
      <div className="flex min-w-0 flex-1 basis-48 items-center justify-between gap-2 sm:flex-none sm:basis-auto">
        <div className="min-w-0 sm:text-right">
          <p className={`text-[13px] break-all ${route.missing ? 'text-rose-300' : route.quiet ? 'text-fg-3' : 'text-fg'}`}>{route.where}</p>
          {route.model && <p className="mt-0.5 text-xs font-mono text-fg-3 break-all">{route.model}</p>}
          {note && <p className="mt-0.5 text-xs text-fg-3">{note}</p>}
        </div>
        <button type="button" onClick={onChange} className={`${QUIET_BTN} shrink-0`}>Change</button>
      </div>
    </div>
  );
}

/** Picks a route and model in a tinted band where the row was, with a test call before saving. */
function RouteForm({ title, initial, endpoints, planReady, planModel, allowDefault, allowWait, allowModel, enabled, onOpenProviders, onCancel, onSubmit }: {
  title: string;
  initial: BackgroundRoute | null;
  endpoints: ClaudeEndpointSetting[];
  planReady: boolean;
  planModel: string | null;
  allowDefault?: boolean;
  allowWait?: boolean;
  allowModel: boolean;
  enabled?: boolean;
  onOpenProviders: () => void;
  onCancel: () => void;
  onSubmit: (route: BackgroundRoute | null, enabled: boolean) => Promise<void>;
}): JSX.Element {
  const [choice, setChoice] = useState(routeKey(initial));
  const [model, setModel] = useState(initial?.provider !== 'chatgpt-plan' ? initial?.model ?? '' : '');
  const [runs, setRuns] = useState(enabled ?? true);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const endpoint = choice.startsWith('endpoint:') ? endpoints.find((candidate) => `endpoint:${candidate.id}` === choice) ?? null : null;
  const route: BackgroundRoute | null = choice === '' ? null
    : choice === 'chatgpt-plan' ? { provider: 'chatgpt-plan' }
    : choice === 'anthropic-api' ? { provider: 'anthropic-api', ...(model.trim() ? { model: model.trim() } : {}) }
    : { provider: 'endpoint', endpointId: endpoint?.id, ...(model.trim() ? { model: model.trim() } : {}) };
  const showModel = allowModel && (choice === 'anthropic-api' || !!endpoint);

  const test = async (): Promise<void> => {
    if (!route) return;
    setBusy('test'); setResult(null);
    const started = Date.now();
    try {
      const answer = await getJson<{ model: string; text: string }>('/api/background/test', { method: 'POST', body: JSON.stringify({ route }) });
      setResult({ ok: true, text: `${answer.model} answered in ${((Date.now() - started) / 1000).toFixed(1)}s` });
    } catch (failure) {
      setResult({ ok: false, text: failure instanceof Error ? failure.message : 'The test call failed' });
    } finally { setBusy(null); }
  };

  const submit = async (): Promise<void> => {
    setBusy('save'); setResult(null);
    try { await onSubmit(route, runs); } catch (failure) {
      setResult({ ok: false, text: failure instanceof Error ? failure.message : 'Could not save' });
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-3 border-t border-line first:border-t-0 bg-surface px-4 py-4" onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="text-sm font-medium text-fg">{title}</p>
        {enabled !== undefined && (
          <div role="radiogroup" aria-label={`Whether ${title} runs`} className="inline-flex items-center gap-0.5 rounded-md border border-line p-0.5">
            {([[true, 'On'], [false, 'Off']] as const).map(([value, label]) => (
              <button key={label} type="button" role="radio" aria-checked={runs === value} onClick={() => setRuns(value)}
                className={`px-2.5 py-1 text-xs rounded transition-colors cursor-pointer ${runs === value ? 'bg-surface-2 text-fg' : 'text-fg-3 hover:text-fg'}`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-2">
        <label htmlFor="background-route" className="text-xs font-medium text-fg-2">Runs on</label>
        <select id="background-route" value={choice} onChange={(event) => { setChoice(event.target.value); setModel(''); setResult(null); }} disabled={busy !== null} className={SELECT}>
          {allowDefault && <option value="">Same as default</option>}
          {allowWait && <option value="">Wait until the plan resumes</option>}
          <option value="anthropic-api">Anthropic API</option>
          {!allowWait && <option value="chatgpt-plan" disabled={!planReady}>ChatGPT plan{planModel ? ` (${planModel})` : ''}{planReady ? '' : ', set up under Providers'}</option>}
          {endpoints.map((candidate) => (
            <option key={candidate.id} value={`endpoint:${candidate.id}`}>{endpointHost(candidate.baseUrl)}{candidate.protocol === 'openai' ? ', OpenAI API' : ', Anthropic API'}</option>
          ))}
        </select>
        {endpoints.length === 0 && (
          <p className="text-xs text-fg-3">
            To use Ollama, LM Studio, OpenRouter or another server, add it under <button type="button" onClick={onOpenProviders} className="text-accent hover:underline cursor-pointer">Providers</button>.
          </p>
        )}
      </div>
      {showModel && (
        <div className="space-y-2">
          <label htmlFor="background-model" className="text-xs font-medium text-fg-2 flex items-center gap-2">
            Model
            <span className="text-xs text-fg-3">Optional</span>
          </label>
          <input
            id="background-model"
            value={model}
            onChange={(event) => { setModel(event.target.value); setResult(null); }}
            placeholder={endpoint ? `${endpoint.model}, the endpoint’s default` : 'The model Lattice picks for this job'}
            autoComplete="off"
            spellCheck={false}
            disabled={busy !== null}
            className={INPUT}
          />
        </div>
      )}
      {result && (
        <p className={`flex items-start gap-1.5 text-xs ${result.ok ? 'text-fg-2' : 'text-rose-300'} break-words`}>
          {result.ok && <CheckCircle2 size={14} className="shrink-0 text-emerald-400" />}
          {result.text}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-1">
        {route && <button type="button" onClick={() => void test()} disabled={busy !== null} className={`${QUIET_BTN} mr-auto -ml-2.5`}>
          {busy === 'test' ? <Loader2 size={14} className="animate-spin" /> : 'Test'}
        </button>}
        <button type="button" onClick={onCancel} disabled={busy !== null} className={QUIET_BTN}>Cancel</button>
        <button type="button" onClick={() => void submit()} disabled={busy !== null || (choice.startsWith('endpoint:') && !endpoint)} className={PRIMARY_BTN}>
          {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
        </button>
      </div>
    </div>
  );
}
