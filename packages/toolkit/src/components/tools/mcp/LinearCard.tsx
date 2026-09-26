import React, { useMemo, useState } from 'react';
import { cn } from '../../../utils/cn.js';
import { tk } from '../../../tokens.js';
import { unwrapResult } from './unwrapResult.js';
import { McpResultBody, MarkdownView } from './McpResultBody.js';
import { BRANDS, actionName } from './brand.js';
import { BrandCard } from './BrandCard.js';
import {
  LinearStateIcon, LinearPriorityIcon, LinearLabel, PRIORITY_NAME,
  type LinearStateType,
} from './linear-glyphs.js';

/**
 * A Linear issue rendered the way Linear renders it.
 *
 * Everything visual here comes from the payload: `state.type` picks the status glyph,
 * `state.color` and `labels[].color` tint it. No palette is invented, so a card matches
 * whatever the workspace has configured.
 */

interface LinearCardProps {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
}

interface Issue {
  identifier?: string;
  title?: string;
  url?: string;
  stateName?: string;
  stateType?: LinearStateType;
  stateColor?: string;
  assignee?: string;
  team?: string;
  project?: string;
  priority?: number;
  labels?: Array<{ name: string; color?: string }>;
  description?: string;
}

type Parsed =
  | { kind: 'issues'; issues: Issue[] }
  | { kind: 'mutation'; verb: string; success: boolean; issue?: Issue }
  | { kind: 'comment'; body: string }
  | null;

// ── Normalising the several shapes the Linear MCP servers return ──

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Endpoints that return a bare status name instead of the state object. */
const NAME_TO_TYPE: Record<string, LinearStateType> = {
  triage: 'triage',
  backlog: 'backlog',
  todo: 'unstarted',
  unstarted: 'unstarted',
  'in progress': 'started',
  started: 'started',
  'in review': 'started',
  done: 'completed',
  completed: 'completed',
  canceled: 'canceled',
  cancelled: 'canceled',
  duplicate: 'canceled',
};

function personName(v: unknown): string | undefined {
  const r = rec(v);
  if (r) return str(r.name) ?? str(r.displayName) ?? str(r.email);
  return str(v);
}

/** Priority arrives either as a bare number or as `{value, name}`. */
function priorityOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  const r = rec(v);
  if (r && typeof r.value === 'number') return r.value;
  return undefined;
}

/** Labels arrive as `{nodes: [...]}`, a bare array, or an array of strings. */
function labelsOf(v: unknown): Array<{ name: string; color?: string }> | undefined {
  const r = rec(v);
  const arr = Array.isArray(v) ? v : Array.isArray(r?.nodes) ? (r!.nodes as unknown[]) : null;
  if (!arr) return undefined;
  const out = arr
    .map((l) => {
      if (typeof l === 'string') return { name: l };
      const lr = rec(l);
      const name = str(lr?.name);
      return name ? { name, color: str(lr?.color) } : null;
    })
    .filter(Boolean) as Array<{ name: string; color?: string }>;
  return out.length ? out : undefined;
}

function toIssue(v: unknown): Issue | null {
  const r = rec(v);
  if (!r) return null;
  if (!r.identifier && !r.title) return null;

  const state = rec(r.state);
  const statusName = str(r.status) ?? str(state?.name);
  const stateType = (str(state?.type) as LinearStateType | undefined)
    ?? (statusName ? NAME_TO_TYPE[statusName.toLowerCase()] : undefined);

  return {
    identifier: str(r.identifier),
    title: str(r.title),
    url: str(r.url),
    stateName: statusName,
    stateType: stateType ?? 'unstarted',
    stateColor: str(state?.color),
    assignee: personName(r.assignee),
    team: personName(r.team),
    project: personName(r.project),
    priority: priorityOf(r.priority),
    labels: labelsOf(r.labels),
    description: str(r.description),
  };
}

function parseLinear(json: unknown): Parsed {
  const r = rec(json);
  if (!r) {
    if (Array.isArray(json)) {
      const issues = json.map(toIssue).filter(Boolean) as Issue[];
      return issues.length ? { kind: 'issues', issues } : null;
    }
    return null;
  }

  // Mutations: issueCreate / issueUpdate / issueDelete
  for (const [key, verb] of [['issueCreate', 'created'], ['issueUpdate', 'updated'], ['issueDelete', 'deleted']] as const) {
    const m = rec(r[key]);
    if (m) return { kind: 'mutation', verb, success: m.success !== false, issue: toIssue(m.issue) ?? undefined };
  }

  // Comment creation
  const comment = rec(r.comment);
  if (comment && str(comment.body)) return { kind: 'comment', body: str(comment.body)! };

  // Single issue, wrapped or bare
  const single = toIssue(r.issue) ?? toIssue(r);
  if (single) return { kind: 'issues', issues: [single] };

  // Collections
  const issuesRaw = r.issues;
  const nodes = Array.isArray(issuesRaw) ? issuesRaw : rec(issuesRaw)?.nodes;
  if (Array.isArray(nodes)) {
    const issues = nodes.map(toIssue).filter(Boolean) as Issue[];
    if (issues.length) return { kind: 'issues', issues };
  }

  return null;
}

// ── Rendering ──

function IssueRow({ issue, dense }: { issue: Issue; dense?: boolean }): React.JSX.Element {
  return (
    <div className={cn('flex items-center gap-2 px-3 min-w-0', dense ? 'py-1' : 'py-1.5')}>
      {issue.priority !== undefined && issue.priority > 0 && (
        <span title={PRIORITY_NAME[issue.priority]} className="flex-shrink-0">
          <LinearPriorityIcon value={issue.priority} />
        </span>
      )}
      <span title={issue.stateName} className="flex-shrink-0">
        <LinearStateIcon type={issue.stateType ?? 'unstarted'} color={issue.stateColor} />
      </span>
      {issue.identifier && (
        <span className={cn('text-[12px] font-mono flex-shrink-0 tabular-nums', tk.text.faint)}>{issue.identifier}</span>
      )}
      <span className={cn('text-[13px] truncate min-w-0 flex-1', tk.text.heading)}>{issue.title}</span>
      {issue.labels?.slice(0, 3).map((l) => <LinearLabel key={l.name} name={l.name} color={l.color} />)}
      {issue.stateName && (
        <span className={cn('text-[11px] flex-shrink-0 whitespace-nowrap', tk.text.muted)}>{issue.stateName}</span>
      )}
      {issue.assignee && (
        <span className={cn('text-[11px] flex-shrink-0 truncate', tk.text.faint)} style={{ maxWidth: 120 }}>
          {issue.assignee}
        </span>
      )}
    </div>
  );
}

function IssueDetail({ issue }: { issue: Issue }): React.JSX.Element {
  return (
    <div>
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center gap-2 mb-1.5">
          {issue.identifier && (
            <span className={cn('text-[12px] font-mono tabular-nums', tk.text.faint)}>{issue.identifier}</span>
          )}
          {issue.url && (
            <a
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-cyan-700 dark:text-cyan-400 no-underline hover:underline"
            >
              open in Linear
            </a>
          )}
        </div>
        <div className={cn('text-[15px] leading-snug', tk.text.heading)}>{issue.title}</div>
      </div>

      {/* Linear's own property strip: glyph plus value, one row of chips. */}
      <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 px-3 pb-3 border-b', tk.separator)}>
        <span className="inline-flex items-center gap-1.5 text-[12px]">
          <LinearStateIcon type={issue.stateType ?? 'unstarted'} color={issue.stateColor} />
          <span className={tk.text.primary}>{issue.stateName ?? issue.stateType}</span>
        </span>
        {issue.priority !== undefined && (
          <span className="inline-flex items-center gap-1.5 text-[12px]">
            <LinearPriorityIcon value={issue.priority} />
            <span className={issue.priority > 0 ? tk.text.primary : tk.text.faint}>
              {PRIORITY_NAME[issue.priority] ?? 'No priority'}
            </span>
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 text-[12px]">
          <span className={tk.text.faint}>assignee</span>
          <span className={issue.assignee ? tk.text.primary : tk.text.faint}>{issue.assignee ?? 'Unassigned'}</span>
        </span>
        {issue.team && (
          <span className="inline-flex items-center gap-1.5 text-[12px]">
            <span className={tk.text.faint}>team</span>
            <span className={tk.text.primary}>{issue.team}</span>
          </span>
        )}
        {issue.project && (
          <span className="inline-flex items-center gap-1.5 text-[12px]">
            <span className={tk.text.faint}>project</span>
            <span className={tk.text.primary}>{issue.project}</span>
          </span>
        )}
        {issue.labels?.map((l) => <LinearLabel key={l.name} name={l.name} color={l.color} />)}
      </div>

      {issue.description && <Description text={issue.description} />}
    </div>
  );
}

const DESC_CHARS = 420;

function Description({ text }: { text: string }): React.JSX.Element {
  const [showAll, setShowAll] = useState(text.length <= DESC_CHARS);
  // Linear descriptions are markdown. Cut on a line boundary so a truncated
  // heading or list item doesn't render as a stray "#".
  const shown = useMemo(() => {
    if (showAll) return text;
    const cut = text.slice(0, DESC_CHARS);
    const lastBreak = cut.lastIndexOf('\n');
    return lastBreak > DESC_CHARS * 0.5 ? cut.slice(0, lastBreak) : cut;
  }, [text, showAll]);

  return (
    <div>
      <MarkdownView text={shown} />
      {!showAll && (
        <button
          onClick={() => setShowAll(true)}
          className={cn('w-full px-3 pb-2 text-left text-[11px]', tk.text.faint, tk.hover)}
        >
          show {(text.length - shown.length).toLocaleString()} more characters
        </button>
      )}
    </div>
  );
}

export function LinearCard({ toolName, input, result, isError }: LinearCardProps): React.JSX.Element {
  const unwrapped = useMemo(() => unwrapResult(result ?? ''), [result]);
  const parsed = useMemo(() => parseLinear(unwrapped.json), [unwrapped.json]);
  const action = actionName(toolName);
  const args = useMemo(() => {
    const a = Object.keys(input).length ? input : (unwrapped.args ?? {});
    for (const k of ['identifier', 'query', 'id', 'issueId', 'title']) {
      const v = a[k];
      if (typeof v === 'string' && v) return v.length > 60 ? v.slice(0, 59) + '…' : v;
      if (Array.isArray(v) && v.length) return v.join(', ').slice(0, 60);
    }
    return '';
  }, [input, unwrapped.args]);

  const summary = useMemo(() => {
    if (!parsed) return null;
    if (parsed.kind === 'mutation') {
      return `${parsed.issue?.identifier ?? 'issue'} ${parsed.success ? parsed.verb : `${parsed.verb} failed`}`;
    }
    if (parsed.kind === 'comment') return `comment added · ${parsed.body.length.toLocaleString()} chars`;
    if (parsed.issues.length === 1) {
      const i = parsed.issues[0];
      return [i.identifier, i.title].filter(Boolean).join(' ');
    }
    return `${parsed.issues.length} issues`;
  }, [parsed]);

  // Anything we can't recognise keeps the generic treatment rather than rendering blank.
  if (!parsed) {
    return (
      <BrandCard brand={BRANDS.linear} action={action} args={args}>
        <McpResultBody result={result} isError={isError} />
      </BrandCard>
    );
  }

  const single = parsed.kind === 'issues' && parsed.issues.length === 1 ? parsed.issues[0] : null;

  return (
    <BrandCard brand={BRANDS.linear} action={action} args={args} summary={summary ?? undefined}>
      {single && <IssueDetail issue={single} />}
      {parsed.kind === 'issues' && parsed.issues.length > 1 && (
        <div className={cn('divide-y max-h-80 overflow-y-auto', tk.separator, tk.scrollbar)}>
          {parsed.issues.map((i, n) => <IssueRow key={i.identifier ?? n} issue={i} dense />)}
        </div>
      )}
      {parsed.kind === 'mutation' && parsed.issue && <IssueRow issue={parsed.issue} />}
      {parsed.kind === 'comment' && <Description text={parsed.body} />}
    </BrandCard>
  );
}
