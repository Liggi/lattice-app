import React, { useMemo, useState } from 'react';
import { parseJson } from '../../../utils/json.js';
import { GitBranch, FileCode, Lock, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '../../../utils/cn.js';
import { tk } from '../../../tokens.js';
import { BRANDS, actionName, BrandLabel } from './brand.js';
import { BrandCard, ShowMore, Avatar } from './BrandCard.js';
import { unwrapResult } from './unwrapResult.js';
import { MarkdownView } from './McpResultBody.js';
import { PrStateIcon, PR_COLOR, REVIEW_STATE, BranchChip, type PrState } from './github-glyphs.js';

/**
 * GitHub cards.
 *
 * GitHub returns real avatar URLs and a state machine (open / draft / merged / closed)
 * that the generic renderer flattened into JSON. The card leads with the state icon and
 * number the way GitHub's own list views do.
 */

interface GitHubCardProps {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

interface User {
  login: string;
  avatar?: string;
  isBot: boolean;
}

interface PR {
  url?: string;
  number?: number;
  state: PrState;
  title?: string;
  body?: string;
  base?: string;
  head?: string;
  user?: User;
  mergeable?: boolean;
  repo?: string;
  reviewers?: string[];
  createdAt?: string;
}

interface Comment {
  id: string;
  user?: User;
  body: string;
  path?: string;
  line?: number;
  createdAt?: string;
  url?: string;
  reviewState?: string;
}

interface Thread {
  id: string;
  path?: string;
  line?: number;
  resolved: boolean;
  outdated: boolean;
  comments: Comment[];
}

interface Repo {
  name: string;
  fullName?: string;
  owner?: User;
  visibility?: string;
  defaultBranch?: string;
  admin?: boolean;
}

type Parsed =
  | { kind: 'pr'; pr: PR }
  | { kind: 'prs'; prs: PR[] }
  | { kind: 'comments'; comments: Comment[]; title?: string; url?: string }
  | { kind: 'reviews'; reviews: Comment[] }
  | { kind: 'threads'; threads: Thread[] }
  | { kind: 'repos'; repos: Repo[] }
  | { kind: 'file'; content: string; path?: string }
  | { kind: 'error'; status?: number; message: string }
  | { kind: 'empty'; noun: string }
  | null;

function toUser(v: unknown): User | undefined {
  const r = rec(v);
  const login = str(r?.login) ?? str(r?.name) ?? str(v);
  if (!login) return undefined;
  return { login, avatar: str(r?.avatar_url), isBot: /\[bot\]$/.test(login) || str(r?.type) === 'Bot' };
}

/** GitHub encodes four states across three booleans plus a string. */
function prState(r: Record<string, unknown>): PrState {
  if (r.merged === true) return 'merged';
  if (r.draft === true) return 'draft';
  const s = str(r.state)?.toLowerCase();
  if (s === 'closed') return 'closed';
  return 'open';
}

function refName(v: unknown): string | undefined {
  const r = rec(v);
  return str(r?.ref) ?? str(r?.label) ?? str(v);
}

function toPR(v: unknown): PR | null {
  const r = rec(v);
  if (!r) return null;
  if (r.number === undefined && !r.title) return null;
  const url = str(r.url) ?? str(r.html_url);
  return {
    url,
    number: num(r.number),
    state: prState(r),
    title: str(r.title),
    body: str(r.body),
    base: refName(r.base),
    head: refName(r.head),
    user: toUser(r.user),
    mergeable: typeof r.mergeable === 'boolean' ? r.mergeable : undefined,
    repo: url?.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1],
    reviewers: Array.isArray(r.requested_reviewers)
      ? (r.requested_reviewers as unknown[]).map((x) => toUser(x)?.login).filter(Boolean) as string[]
      : undefined,
    createdAt: str(r.created_at),
  };
}

function toComment(v: unknown): Comment | null {
  const r = rec(v);
  if (!r) return null;
  const body = str(r.body);
  if (!body) return null;
  return {
    id: String(r.id ?? Math.random()),
    user: toUser(r.user),
    body,
    path: str(r.path),
    line: num(r.line) ?? num(r.original_line),
    createdAt: str(r.created_at),
    url: str(r.url) ?? str(r.html_url),
    reviewState: str(r.state),
  };
}

/**
 * GitHub reports failures three different ways: a REST sentence with JSON attached,
 * a GraphQL error whose message is buried in a Python-style dict, and an envelope
 * that simply says `status: failed`. All three should read as one error line.
 */
function parseError(rawText: string, envelopeFailed?: boolean): Parsed {
  const rest = rawText.match(/GitHub API error (\d+):\s*(\{.*\})/s);
  if (rest) {
    let message = rest[2];
    try { message = str((parseJson(rest[2]) as Record<string, unknown>).message) ?? message; } catch { /* keep raw */ }
    return { kind: 'error', status: Number(rest[1]), message };
  }

  // GraphQL: pull the quoted message out of the dict rather than showing the dict.
  if (/GraphQLAPIError|Error code:/i.test(rawText)) {
    const msg = rawText.match(/'message':\s*"([^"]+)"/)?.[1]
      ?? rawText.match(/'message':\s*'([^']+)'/)?.[1]
      ?? rawText.split('\n')[0];
    return { kind: 'error', message: msg.trim() };
  }

  if (envelopeFailed && rawText.trim()) {
    return { kind: 'error', message: rawText.trim().split('\n')[0].slice(0, 300) };
  }
  return null;
}

function parseGitHub(json: unknown, rawText: string, envelopeFailed?: boolean): Parsed {
  const err = parseError(rawText, envelopeFailed);
  if (err) return err;

  const r = rec(json);
  if (!r) return null;

  // fetch_pr wraps the PR one level down.
  const wrapped = rec(r.pull_request);
  const single = toPR(wrapped ?? r);
  if (single && (wrapped || r.number !== undefined)) return { kind: 'pr', pr: single };

  if (Array.isArray(r.issues)) {
    const prs = (r.issues as unknown[]).map(toPR).filter(Boolean) as PR[];
    if (prs.length) return { kind: 'prs', prs };
  }

  if (Array.isArray(r.review_threads)) {
    const threads = (r.review_threads as unknown[])
      .map((t) => {
        const tr = rec(t);
        if (!tr) return null;
        return {
          id: String(tr.id ?? ''),
          path: str(tr.path),
          line: num(tr.line) ?? num(tr.original_line),
          resolved: tr.is_resolved === true,
          outdated: tr.is_outdated === true,
          comments: (Array.isArray(tr.comments) ? tr.comments : []).map(toComment).filter(Boolean) as Comment[],
        } as Thread;
      })
      .filter(Boolean) as Thread[];
    if (threads.length) return { kind: 'threads', threads };
  }

  if (Array.isArray(r.reviews)) {
    const reviews = (r.reviews as unknown[]).map(toComment).filter(Boolean) as Comment[];
    if (reviews.length) return { kind: 'reviews', reviews };
  }

  if (Array.isArray(r.comments)) {
    const comments = (r.comments as unknown[]).map(toComment).filter(Boolean) as Comment[];
    if (comments.length) return { kind: 'comments', comments, title: str(r.display_title) ?? str(r.title), url: str(r.url) };
  }

  if (Array.isArray(r.repositories)) {
    const repos = (r.repositories as unknown[])
      .map((x) => {
        const rr = rec(x);
        if (!rr) return null;
        return {
          name: str(rr.name) ?? '',
          fullName: str(rr.repository_full_name),
          owner: toUser(rr.owner),
          visibility: str(rr.visibility),
          defaultBranch: str(rr.default_branch),
          admin: rec(rr.permissions)?.admin === true,
        } as Repo;
      })
      .filter((x) => x && x.name) as Repo[];
    if (repos.length) return { kind: 'repos', repos };
  }

  const content = str(r.content);
  if (content) return { kind: 'file', content, path: str(r.path) };

  // A present-but-empty collection is a real answer — "none" — not an unparseable
  // payload. Falling through to a JSON dump made a successful search look broken.
  for (const [key, noun] of [
    ['repositories', 'repositories'],
    ['issues', 'pull requests'],
    ['comments', 'comments'],
    ['reviews', 'reviews'],
    ['review_threads', 'review threads'],
  ] as const) {
    if (Array.isArray(r[key])) return { kind: 'empty', noun };
  }

  return null;
}

// ── Rendering ──

const PREVIEW = 5;
const BODY_CHARS = 600;

function UserLine({ user, when }: { user?: User; when?: string }): React.JSX.Element | null {
  if (!user) return null;
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <Avatar name={user.login} url={user.avatar} size={16} />
      <span className={cn('text-[12px] truncate', tk.text.secondary)}>{user.login.replace(/\[bot\]$/, '')}</span>
      {user.isBot && <BrandLabel label="bot" color="#8B949E" />}
      {when && <span className={cn('text-[11px]', tk.text.faint)}>{when.slice(0, 10)}</span>}
    </span>
  );
}

function Body({ text }: { text: string }): React.JSX.Element {
  const [showAll, setShowAll] = useState(text.length <= BODY_CHARS);
  const shown = useMemo(() => {
    if (showAll) return text;
    const cut = text.slice(0, BODY_CHARS);
    const br = cut.lastIndexOf('\n');
    return br > BODY_CHARS * 0.5 ? cut.slice(0, br) : cut;
  }, [text, showAll]);

  return (
    <div>
      <MarkdownView text={shown} />
      {!showAll && (
        <ShowMore hidden={text.length - shown.length} unit="characters" onClick={() => setShowAll(true)} />
      )}
    </div>
  );
}

function PrHeader({ pr }: { pr: PR }): React.JSX.Element {
  return (
    <div className="px-3 pt-3 pb-2">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <PrStateIcon state={pr.state} />
        <span className="text-[11px] font-medium capitalize" style={{ color: PR_COLOR[pr.state] }}>
          {pr.state}
        </span>
        {pr.number !== undefined && (
          <span className={cn('text-[12px] font-mono tabular-nums', tk.text.faint)}>#{pr.number}</span>
        )}
        {pr.repo && <span className={cn('text-[11px]', tk.text.faint)}>{pr.repo}</span>}
        {pr.url && (
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] no-underline hover:underline"
            style={{ color: '#58A6FF' }}
          >
            open on GitHub
          </a>
        )}
      </div>
      {pr.title && <div className={cn('text-[15px] leading-snug mb-2', tk.text.heading)}>{pr.title}</div>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <UserLine user={pr.user} when={pr.createdAt} />
        {pr.head && pr.base && (
          <span className="inline-flex items-center gap-1.5">
            <GitBranch size={12} className={tk.text.faint} />
            <BranchChip name={pr.head} />
            <span className={cn('text-[11px]', tk.text.faint)}>→</span>
            <BranchChip name={pr.base} />
          </span>
        )}
        {pr.mergeable !== undefined && (
          <span className="inline-flex items-center gap-1 text-[11px]">
            {pr.mergeable ? (
              <CheckCircle2 size={12} className="text-emerald-500" />
            ) : (
              <XCircle size={12} className="text-amber-500" />
            )}
            <span className={tk.text.muted}>{pr.mergeable ? 'mergeable' : 'conflicts'}</span>
          </span>
        )}
        {pr.reviewers?.length ? (
          <span className={cn('text-[11px]', tk.text.faint)}>reviewers: {pr.reviewers.join(', ')}</span>
        ) : null}
      </div>
    </div>
  );
}

function PrRow({ pr }: { pr: PR }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 min-w-0">
      <PrStateIcon state={pr.state} />
      {pr.number !== undefined && (
        <span className={cn('text-[12px] font-mono tabular-nums flex-shrink-0', tk.text.faint)}>#{pr.number}</span>
      )}
      <span className={cn('text-[13px] truncate min-w-0 flex-1', tk.text.heading)}>{pr.title}</span>
      {pr.user && <Avatar name={pr.user.login} url={pr.user.avatar} size={16} />}
    </div>
  );
}

function CommentRow({ c }: { c: Comment }): React.JSX.Element {
  const rs = c.reviewState ? REVIEW_STATE[c.reviewState] : undefined;
  return (
    <div className="px-3 py-2 min-w-0">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <UserLine user={c.user} when={c.createdAt} />
        {rs && <BrandLabel label={rs.label} color={rs.color} />}
        {c.path && (
          <span className={cn('text-[11px] font-mono', tk.text.faint)}>
            {c.path}
            {c.line ? `:${c.line}` : ''}
          </span>
        )}
      </div>
      <Body text={c.body} />
    </div>
  );
}

function argsOf(input: Record<string, unknown>, recovered?: Record<string, unknown>): string {
  const a = Object.keys(input).length ? input : (recovered ?? {});
  const parts: string[] = [];
  const repo = str(a.repository_full_name) ?? str(a.repo_full_name) ?? str(a.repo);
  if (repo) parts.push(repo);
  const n = a.pr_number ?? a.number ?? a.issue_number;
  if (n !== undefined) parts.push(`#${n}`);
  const q = str(a.query) ?? str(a.path);
  if (q) parts.push(q);
  const s = parts.join(' ');
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

export function GitHubCard({ toolName, input, result, isError }: GitHubCardProps): React.JSX.Element {
  const unwrapped = useMemo(() => unwrapResult(result ?? ''), [result]);
  const parsed = useMemo(
    () => parseGitHub(unwrapped.json, unwrapped.text, unwrapped.isError || isError),
    [unwrapped.json, unwrapped.text, unwrapped.isError, isError],
  );
  const [showAll, setShowAll] = useState(false);

  const brand = BRANDS.github;
  const action = actionName(toolName).replace(/^github[ .]?/, '');
  const args = argsOf(input, unwrapped.args);

  if (!parsed) {
    return (
      <BrandCard brand={brand} action={action} args={args}>
        <pre
          className={cn(
            'm-0 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words max-h-80 overflow-auto',
            tk.codeBg, tk.text.primary, tk.scrollbar,
          )}
        >
          {unwrapped.text || '(no content)'}
        </pre>
      </BrandCard>
    );
  }

  if (parsed.kind === 'error') {
    return (
      <BrandCard brand={brand} action={action} args={args} summary={`${parsed.status ?? ''} ${parsed.message}`.trim()}>
        <div className="px-3 py-2 text-[12px] text-red-600 dark:text-red-400/80">
          {parsed.status ? `${parsed.status} · ` : ''}
          {parsed.message}
        </div>
      </BrandCard>
    );
  }

  if (parsed.kind === 'empty') {
    return (
      <BrandCard brand={brand} action={action} args={args} summary={`no ${parsed.noun}`}>
        <div className={cn('px-3 py-2 text-[12px]', tk.text.faint)}>No {parsed.noun} matched.</div>
      </BrandCard>
    );
  }

  if (parsed.kind === 'pr') {
    const { pr } = parsed;
    const summary = [pr.number !== undefined ? `#${pr.number}` : '', pr.title, pr.state]
      .filter(Boolean)
      .join(' · ');
    return (
      <BrandCard brand={brand} action={action} args={args} summary={summary}>
        <PrHeader pr={pr} />
        {pr.body && (
          <div className={`border-t ${tk.separator}`}>
            <Body text={pr.body} />
          </div>
        )}
      </BrandCard>
    );
  }

  if (parsed.kind === 'prs') {
    const shown = showAll ? parsed.prs : parsed.prs.slice(0, PREVIEW * 2);
    const byState = parsed.prs.reduce<Record<string, number>>((acc, p) => {
      acc[p.state] = (acc[p.state] ?? 0) + 1;
      return acc;
    }, {});
    const summary = `${parsed.prs.length} PRs · ` + Object.entries(byState).map(([s, n]) => `${n} ${s}`).join(', ');
    return (
      <BrandCard brand={brand} action={action} args={args} summary={summary}>
        <div className={cn('divide-y max-h-80 overflow-y-auto', tk.separator, tk.scrollbar)}>
          {shown.map((p, i) => <PrRow key={p.number ?? i} pr={p} />)}
        </div>
        {!showAll && parsed.prs.length > PREVIEW * 2 && (
          <ShowMore hidden={parsed.prs.length - PREVIEW * 2} unit="pull requests" onClick={() => setShowAll(true)} />
        )}
      </BrandCard>
    );
  }

  if (parsed.kind === 'comments' || parsed.kind === 'reviews') {
    const items = parsed.kind === 'comments' ? parsed.comments : parsed.reviews;
    const shown = showAll ? items : items.slice(0, PREVIEW);
    const people = [...new Set(items.map((c) => c.user?.login).filter(Boolean))];
    const noun = parsed.kind === 'comments' ? 'comment' : 'review';
    const summary = `${items.length} ${noun}${items.length === 1 ? '' : 's'}${people.length ? ` · ${people.slice(0, 3).join(', ')}` : ''}`;
    return (
      <BrandCard brand={brand} action={action} args={args} summary={summary}>
        <div className={cn('divide-y', tk.separator)}>
          {shown.map((c) => <CommentRow key={c.id} c={c} />)}
        </div>
        {!showAll && items.length > PREVIEW && (
          <ShowMore hidden={items.length - PREVIEW} unit={`${noun}s`} onClick={() => setShowAll(true)} />
        )}
      </BrandCard>
    );
  }

  if (parsed.kind === 'threads') {
    const open = parsed.threads.filter((t) => !t.resolved).length;
    const shown = showAll ? parsed.threads : parsed.threads.slice(0, PREVIEW);
    return (
      <BrandCard
        brand={brand}
        action={action}
        args={args}
        summary={`${parsed.threads.length} thread${parsed.threads.length === 1 ? '' : 's'} · ${open} unresolved`}
       
      >
        <div className={cn('divide-y', tk.separator)}>
          {shown.map((t) => (
            <div key={t.id}>
              <div className="flex items-center gap-2 px-3 pt-2 flex-wrap">
                <FileCode size={12} className={tk.text.faint} />
                <span className={cn('text-[11px] font-mono', tk.text.faint)}>
                  {t.path}
                  {t.line ? `:${t.line}` : ''}
                </span>
                <BrandLabel
                  label={t.resolved ? 'resolved' : 'unresolved'}
                  color={t.resolved ? '#3FB950' : '#D29922'}
                />
                {t.outdated && <BrandLabel label="outdated" color="#8B949E" />}
              </div>
              {t.comments.map((c) => <CommentRow key={c.id} c={c} />)}
            </div>
          ))}
        </div>
        {!showAll && parsed.threads.length > PREVIEW && (
          <ShowMore hidden={parsed.threads.length - PREVIEW} unit="threads" onClick={() => setShowAll(true)} />
        )}
      </BrandCard>
    );
  }

  if (parsed.kind === 'repos') {
    const shown = showAll ? parsed.repos : parsed.repos.slice(0, PREVIEW * 2);
    return (
      <BrandCard
        brand={brand}
        action={action}
        args={args}
        summary={`${parsed.repos.length} repositor${parsed.repos.length === 1 ? 'y' : 'ies'}`}
       
      >
        <div className={cn('divide-y max-h-80 overflow-y-auto', tk.separator, tk.scrollbar)}>
          {shown.map((r) => (
            <div key={r.fullName ?? r.name} className="flex items-center gap-2 px-3 py-1.5 min-w-0">
              {r.owner && <Avatar name={r.owner.login} url={r.owner.avatar} size={16} />}
              <span className={cn('text-[13px] truncate min-w-0 flex-1', tk.text.heading)}>{r.fullName ?? r.name}</span>
              {r.visibility === 'private' && <Lock size={11} className={tk.text.faint} />}
              {r.defaultBranch && <BranchChip name={r.defaultBranch} />}
              {r.admin && <BrandLabel label="admin" color="#8B949E" />}
            </div>
          ))}
        </div>
        {!showAll && parsed.repos.length > PREVIEW * 2 && (
          <ShowMore hidden={parsed.repos.length - PREVIEW * 2} unit="repositories" onClick={() => setShowAll(true)} />
        )}
      </BrandCard>
    );
  }

  // A fetched file.
  return (
    <BrandCard
      brand={brand}
      action={action}
      args={args}
      summary={`${parsed.path ?? 'file'} · ${parsed.content.length.toLocaleString()} chars`}
    >
      <pre
        className={cn(
          'm-0 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words max-h-80 overflow-auto',
          tk.codeBg, tk.text.primary, tk.scrollbar,
        )}
      >
        {parsed.content.slice(0, 4000)}
      </pre>
      {parsed.content.length > 4000 && (
        <div className={cn('px-3 py-1.5 text-[11px] border-t', tk.separator, tk.text.faint)}>
          showing 4,000 of {parsed.content.length.toLocaleString()} characters
        </div>
      )}
    </BrandCard>
  );
}
