/**
 * The project's pull requests and releases, each at the stage it has
 * reached, for the project panel (2026-10-09, thread 35160). Jason's status
 * questions include about 35 of the form "reviewed on ci? green?",
 * "mergeable?", "all pushed?", "did we ship it?"; each was answered by a
 * coordinator running git and gh by hand.
 *
 * Nothing new is recorded for this. It reads what exists:
 * - the project's repos, from its "Repos: <path>" decisions;
 * - which pull requests are the project's: those its record mentions by
 *   number (#1990, PR 1990, pull/1990), looked up on each repo's GitHub
 *   origin with `gh`. Open ones are listed, and merged or closed ones for a
 *   day after;
 * - whether a merged one is live: the repo's newest GitHub deployment to an
 *   environment named Production, compared with the merge commit;
 * - promotions: a pull request whose every changed line swaps one of the
 *   repo's commits for a later one (a version file per environment) moves
 *   that environment to the later commit. The work it carried is the pull
 *   requests between the two commits. Such a repo deploys every commit on
 *   its default branch, so a deployment there says nothing about any one
 *   change: a change is live in an environment once a promotion carried it,
 *   and the promotion shows as that stage on the change's row instead of as
 *   a row of its own (2026-10-11, thread 39326: "promoted it... for what?").
 *   A promotion that carried nothing the panel lists keeps a row, titled
 *   with what it carried;
 * - local branches an open thread names that are not merged into the default
 *   branch, for repos that merge locally instead of through pull requests. A
 *   branch only a decision or a closed or parked thread names was set aside on
 *   purpose, and would sit in the panel for ever as if it were stuck;
 * - for a repo whose package is on npm, the published version, and how many
 *   commits on the default branch came after the commit that set it.
 *
 * Every read is bounded and a failure leaves that item out; what could not
 * be read is returned in `unread` rather than shown as a stage.
 *
 * One read runs git, gh and npm for each repo and takes 3 to 10 seconds, so
 * the panel never waits on it once a project has been read: `ShippingWatcher`
 * keeps the last result per project on disk, answers with it straight away,
 * and re-reads in the background.
 *
 * Nothing here imports the app's path aliases, so the panel preview can load
 * it outside the server.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseJson } from '../../utils/json.js';
import type { ProjectState } from '../../types/project-state.js';

export type ShipStage =
  | 'draft' | 'checks-running' | 'checks-failing' | 'checks-passed' | 'approved'
  | 'merged' | 'merged-unchecked' | 'live' | 'closed'
  | 'branch' | 'published' | 'unpublished';

export interface ShipItem {
  key: string;
  /** The pull request's title, the branch, or the package and version. */
  title: string;
  stage: ShipStage;
  /** The stage in words: "Checks passed", "Merged, not live yet". */
  stageLabel: string;
  /** When it reached that stage, epoch ms, where known. */
  at?: number;
  href?: string;
}

export interface ProjectShipping {
  items: ShipItem[];
  /** What could not be read, in plain words, for whoever is checking the panel. */
  unread: string[];
}

/** Merged and closed pull requests stay listed this long. */
const KEEP_DONE_MS = 24 * 60 * 60_000;
/** An open pull request or branch nobody has touched in this long is left out. */
const KEEP_OPEN_MS = 7 * 24 * 60 * 60_000;
const COMMAND_TIMEOUT_MS = 20_000;

export async function readProjectShipping(project: ProjectState, now = Date.now()): Promise<ProjectShipping> {
  const record = JSON.stringify(project);
  const openThreads = project.open.filter((thread) => !thread.parked);
  const items: ShipItem[] = [];
  const unread: string[] = [];
  const present = projectRepos(project).filter((repo) => {
    if (fs.existsSync(repo)) return true;
    unread.push(`${repo} is not on this machine`);
    return false;
  });
  // A record names a checkout and its worktrees ("WIP worktree ..."), which
  // are one repository: read each once, at the first path recorded.
  const presentSlugs = await Promise.all(present.map(githubSlug));
  const identities = await Promise.all(present.map(async (repo, index) => presentSlugs[index] ?? await gitCommonDir(repo) ?? repo));
  const first = (_: unknown, index: number) => identities.indexOf(identities[index]) === index;
  const repos = present.filter(first);
  const slugs = presentSlugs.filter(first);
  const mentions = mentionedPullRequests(record, repos, slugs);
  const viewer = slugs.some(Boolean) ? (await run('gh', ['api', 'user', '--jq', '.login']).catch(() => '')).trim() : '';
  await Promise.all(repos.map(async (repo, index) => {
    const github = slugs[index];
    let usesPullRequests = false;
    const numbers = mentions.get(repo);
    if (github && numbers?.size) {
      try {
        const found = await pullRequests(github, numbers, viewer, now);
        items.push(...found.items);
        usesPullRequests = found.usesPullRequests;
      } catch (error) {
        unread.push(`pull requests on ${github}: ${message(error)}`);
      }
    }
    // A repo the user merges through pull requests has its stage there; its
    // local branches outlive their squash merges and would read as unmerged.
    if (!usesPullRequests) try {
      items.push(...await unmergedBranches(repo, openThreads, now));
    } catch (error) {
      unread.push(`branches in ${repo}: ${message(error)}`);
    }
    try {
      items.push(...await npmRelease(repo));
    } catch (error) {
      unread.push(`npm release for ${repo}: ${message(error)}`);
    }
  }));
  items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return { items, unread };
}

export interface ShippingSnapshot extends ProjectShipping {
  /** When this was read, epoch ms. */
  readAt: number;
}

interface WatchedProject {
  snapshot: ShippingSnapshot;
  /** When the panel last asked for it; a project nobody has looked at in a day is no longer re-read. */
  askedAt: number;
}

/**
 * Keeps each project's pull requests and releases warm. `get` answers with
 * the last read at once and starts a fresh read in the background when the
 * last is over a minute old; only a project never read before waits for its
 * first. Every two minutes, projects the panel asked about in the last day
 * are re-read, so an open panel's next poll already has the new state. The
 * results are kept in one JSON file, so a restart starts warm.
 */
export class ShippingWatcher {
  private readonly projects = new Map<string, WatchedProject>();
  private readonly reading = new Map<string, Promise<ShippingSnapshot>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly file: string,
    private readonly readProject: (conversationId: string) => ProjectState | Promise<ProjectState>,
    private readonly freshMs = 60_000,
  ) {
    try {
      const saved = parseJson(fs.readFileSync(file, 'utf-8')) as Record<string, WatchedProject>;
      for (const [id, watched] of Object.entries(saved)) this.projects.set(id, watched);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async get(conversationId: string, now = Date.now()): Promise<ShippingSnapshot> {
    const watched = this.projects.get(conversationId);
    if (!watched) return this.refresh(conversationId, now);
    watched.askedAt = now;
    if (now - watched.snapshot.readAt > this.freshMs) void this.refresh(conversationId, now).catch(() => {});
    return watched.snapshot;
  }

  /** Re-reads the projects asked about in the last day, now and every `everyMs`. */
  start(everyMs = 2 * 60_000): void {
    if (this.timer) return;
    const sweep = () => {
      const now = Date.now();
      for (const [id, watched] of this.projects) {
        if (now - watched.askedAt > KEEP_DONE_MS) this.projects.delete(id);
        else if (now - watched.snapshot.readAt > this.freshMs) void this.refresh(id, now).catch(() => {});
      }
    };
    sweep();
    this.timer = setInterval(sweep, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private refresh(conversationId: string, now: number): Promise<ShippingSnapshot> {
    const inFlight = this.reading.get(conversationId);
    if (inFlight) return inFlight;
    const read = (async () => {
      const shipping = await readProjectShipping(await this.readProject(conversationId));
      const snapshot = { ...shipping, readAt: Date.now() };
      this.projects.set(conversationId, { snapshot, askedAt: this.projects.get(conversationId)?.askedAt ?? now });
      this.save();
      return snapshot;
    })().finally(() => this.reading.delete(conversationId));
    this.reading.set(conversationId, read);
    return read;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(this.projects), null, 2));
    fs.renameSync(temp, this.file);
  }
}

/** Absolute paths named by the project's "Repos:" decisions, in the order recorded. */
export function projectRepos(project: ProjectState): string[] {
  const repos: string[] = [];
  for (const decision of project.decisions) {
    const text = decision.text;
    if (!/^Repos:/i.test(text)) continue;
    for (const match of text.matchAll(/(?:^|[\s(])(~?\/[^\s,()]+)/g)) {
      const repo = match[1].replace(/^~(?=\/)/, process.env.HOME ?? '~').replace(/[.;:]+$/, '');
      if (!repos.includes(repo)) repos.push(repo);
    }
  }
  return repos;
}

/**
 * Pull request numbers the record mentions, by repo. A number belongs to the
 * repo named just before it ("web-app #1562") or in its URL; a bare
 * number is looked up in every recorded repo, so two repos with the user's
 * own pull request under the same number both show it.
 */
function mentionedPullRequests(record: string, repos: string[], slugs: Array<string | null>): Map<string, Set<number>> {
  const byRepo = new Map<string, Set<number>>();
  const names = repos.map((repo, index) => ({ repo, name: slugs[index]?.split('/')[1] ?? path.basename(repo) }))
    .sort((a, b) => b.name.length - a.name.length);
  for (const match of record.matchAll(/(?:#|\bPR ?#?|\/pull\/)(\d{1,6})\b/gi)) {
    const before = record.slice(Math.max(0, match.index - 60), match.index);
    const named = names.find(({ name }) => before.includes(name))?.repo;
    for (const repo of named ? [named] : repos) {
      if (!byRepo.has(repo)) byRepo.set(repo, new Set());
      byRepo.get(repo)!.add(Number(match[1]));
    }
  }
  return byRepo;
}

type GhPull = {
  number: number;
  title: string;
  author: { login: string };
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  reviewDecision: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  url: string;
  mergeCommit: { oid: string } | null;
  statusCheckRollup: Array<{ conclusion?: string | null; status?: string; state?: string }>;
  additions: number;
  deletions: number;
  changedFiles: number;
};

async function pullRequests(github: string, numbers: Set<number>, viewer: string, now: number): Promise<{ items: ShipItem[]; usesPullRequests: boolean }> {
  const fields = 'author,number,title,state,isDraft,reviewDecision,mergedAt,closedAt,updatedAt,url,mergeCommit,statusCheckRollup,additions,deletions,changedFiles';
  const pulls = parseJson(await run('gh', ['pr', 'list', '--repo', github, '--state', 'all', '--limit', '100', '--json', fields])) as GhPull[];
  // Only the user's own: the record also mentions bots' and colleagues' pull requests.
  const ours = pulls.filter((pull) => numbers.has(pull.number) && (!viewer || pull.author.login === viewer));
  const recent = ours.filter((pull) => {
    if (pull.state === 'OPEN') return now - Date.parse(pull.updatedAt) < KEEP_OPEN_MS;
    const ended = Date.parse(pull.mergedAt ?? pull.closedAt ?? pull.updatedAt);
    return now - ended < KEEP_DONE_MS;
  });
  const promotions = await readPromotions(github, pulls, now);
  const promotionNumbers = new Set(promotions.map((promotion) => promotion.pull.number));
  const work = recent.filter((pull) => !promotionNumbers.has(pull.number));
  const workNumbers = new Set(work.map((pull) => pull.number));
  const live = promotions.length === 0 && work.some((pull) => pull.state === 'MERGED') ? await productionDeploy(github) : null;
  const items: ShipItem[] = [];
  for (const promotion of promotions) {
    if (!numbers.has(promotion.pull.number) || (viewer && promotion.pull.author.login !== viewer)) continue;
    if (promotion.carried.some((carried) => workNumbers.has(carried.number))) continue;
    const pull = promotion.pull;
    const title = carriedTitle(promotion);
    const base = { key: `${github}#${pull.number}`, title, href: pull.url };
    if (pull.state === 'MERGED') items.push({ ...base, stage: 'live', stageLabel: 'Live', at: Date.parse(pull.mergedAt ?? pull.updatedAt) });
    else items.push({ ...base, ...openStage(pull) });
  }
  for (const pull of work) {
    const base = { key: `${github}#${pull.number}`, title: pull.title, href: pull.url };
    if (pull.state === 'MERGED' && promotions.length > 0) {
      items.push({ ...base, ...promotedStage(pull, promotions) });
      continue;
    }
    if (pull.state === 'CLOSED') {
      items.push({ ...base, stage: 'closed', stageLabel: 'Closed without merging', at: Date.parse(pull.closedAt ?? pull.updatedAt) });
      continue;
    }
    if (pull.state === 'MERGED') {
      const mergedAt = Date.parse(pull.mergedAt ?? pull.updatedAt);
      const isLive = live && pull.mergeCommit ? await contains(github, live.sha, pull.mergeCommit.oid) : null;
      if (isLive) items.push({ ...base, stage: 'live', stageLabel: 'Live', at: live!.at });
      else if (isLive === false) items.push({ ...base, stage: 'merged', stageLabel: 'Merged, not live yet', at: mergedAt });
      // No production deploy to compare with, so whether it is live is unknown.
      else items.push({ ...base, stage: 'merged-unchecked', stageLabel: 'Merged, no deploy to check', at: mergedAt });
      continue;
    }
    items.push({ ...base, ...openStage(pull) });
  }
  return { items, usesPullRequests: pulls.some((pull) => pull.author.login === viewer) };
}

function openStage(pull: GhPull): Pick<ShipItem, 'stage' | 'stageLabel' | 'at'> {
  const checks = checkState(pull.statusCheckRollup);
  const approved = pull.reviewDecision === 'APPROVED';
  const at = Date.parse(pull.updatedAt);
  if (pull.isDraft) return { stage: 'draft', stageLabel: 'Draft', at };
  if (checks === 'failing') return { stage: 'checks-failing', stageLabel: 'Checks failing', at };
  if (checks === 'running') return { stage: 'checks-running', stageLabel: approved ? 'Approved, checks running' : 'Checks running', at };
  if (approved) return { stage: 'approved', stageLabel: 'Approved, checks passed', at };
  return { stage: 'checks-passed', stageLabel: 'Checks passed, not reviewed', at };
}

interface Promotion {
  pull: GhPull;
  /** The environments it moves, as named by the repo's deployments or the version file's folder. */
  environments: string[];
  /** The pull requests between the old and new commit, oldest first; other promotions left out. */
  carried: Array<{ number: number; title: string }>;
}

/**
 * The repo's promotions merged in the last day or still open. A candidate
 * removes as many lines as it adds, in a few files (cheap to tell from the
 * list); its patch then has to swap whole commit ids and nothing else.
 */
async function readPromotions(github: string, pulls: GhPull[], now: number): Promise<Promotion[]> {
  const shaped = (pull: GhPull) => pull.state !== 'CLOSED' && pull.additions > 0 && pull.additions === pull.deletions && pull.changedFiles <= 10;
  const candidates = pulls.filter((pull) => shaped(pull)
    && (pull.state === 'OPEN' ? now - Date.parse(pull.updatedAt) < KEEP_OPEN_MS : now - Date.parse(pull.mergedAt ?? pull.updatedAt) < KEEP_DONE_MS));
  if (candidates.length === 0) return [];
  const swaps = new Map<number, Array<{ file: string; from: string; to: string }>>();
  await Promise.all(candidates.map(async (pull) => {
    const found = await commitSwaps(github, pull.number).catch(() => null);
    if (found) swaps.set(pull.number, found);
  }));
  if (swaps.size === 0) return [];
  // An older promotion inside a range is not work it carried.
  const older = new Map<number, Promise<boolean>>();
  const isPromotion = (number: number): Promise<boolean> => {
    if (swaps.has(number)) return Promise.resolve(true);
    const pull = pulls.find((candidate) => candidate.number === number);
    if (!pull || !shaped(pull)) return Promise.resolve(false);
    if (!older.has(number)) older.set(number, commitSwaps(github, number).then(Boolean, () => false));
    return older.get(number)!;
  };
  const environments = await deploymentEnvironments(github).catch(() => [] as string[]);
  const titles = new Map(pulls.map((pull) => [pull.number, pull.title]));
  const promotions: Promotion[] = [];
  for (const pull of candidates) {
    const found = swaps.get(pull.number);
    if (!found) continue;
    const ranges = new Map<string, { from: string; to: string }>();
    for (const swap of found) ranges.set(`${swap.from}..${swap.to}`, swap);
    const carried: Promotion['carried'] = [];
    try {
      for (const range of ranges.values()) {
        for (const number of await pullsBetween(github, range.from, range.to)) {
          if (!carried.some((seen) => seen.number === number) && !await isPromotion(number)) carried.push({ number, title: titles.get(number) ?? `#${number}` });
        }
      }
    } catch {
      continue;
    }
    const named = [...new Set(found.map((swap) => environmentOf(swap.file, environments)))];
    promotions.push({ pull, environments: named, carried });
  }
  return promotions;
}

/** Each changed line pair in the pull request that swaps one 40-character commit id for another, or null when any change is something else. */
async function commitSwaps(github: string, number: number): Promise<Array<{ file: string; from: string; to: string }> | null> {
  const files = parseJson(await run('gh', ['api', `repos/${github}/pulls/${number}/files`])) as Array<{ filename: string; patch?: string }>;
  const swaps: Array<{ file: string; from: string; to: string }> = [];
  for (const file of files) {
    const lines = (file.patch ?? '').split('\n');
    const removed = lines.filter((line) => line.startsWith('-')).map((line) => line.slice(1));
    const added = lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1));
    if (removed.length === 0 || removed.length !== added.length) return null;
    for (const [index, before] of removed.entries()) {
      const after = added[index];
      const from = before.match(COMMIT_ID)?.[0];
      const to = after.match(COMMIT_ID)?.[0];
      if (!from || !to || from === to || before.replace(COMMIT_ID_ALL, '') !== after.replace(COMMIT_ID_ALL, '')) return null;
      swaps.push({ file: file.filename, from, to });
    }
  }
  return swaps.length > 0 ? swaps : null;
}

const COMMIT_ID = /\b[0-9a-f]{40}\b/;
const COMMIT_ID_ALL = /\b[0-9a-f]{40}\b/g;

/** The pull requests merged between two commits, from GitHub's squash and merge subjects ("Title (#119)", "Merge pull request #119"). */
async function pullsBetween(github: string, from: string, to: string): Promise<number[]> {
  const subjects = (await run('gh', ['api', `repos/${github}/compare/${from}...${to}`, '--jq', '.commits[].commit.message | split("\\n")[0]'])).split('\n');
  const numbers: number[] = [];
  for (const subject of subjects) {
    const number = subject.match(/\(#(\d+)\)\s*$/)?.[1] ?? subject.match(/^Merge pull request #(\d+)/)?.[1];
    if (number) numbers.push(Number(number));
  }
  return numbers;
}

async function deploymentEnvironments(github: string): Promise<string[]> {
  const out = await run('gh', ['api', `repos/${github}/deployments?per_page=100`, '--jq', '[.[].environment] | unique | .[]']);
  return out.split('\n').filter(Boolean);
}

/** The deployment environment a version file belongs to: a folder or file named after one, else its folder. */
function environmentOf(file: string, environments: string[]): string {
  const parts = file.split('/');
  const named = environments.find((environment) => parts.some((part) => part.toLowerCase() === environment.toLowerCase()));
  return (named ?? parts.at(-2) ?? file).toLowerCase();
}

const isProduction = (environment: string) => /^prod/i.test(environment);

/** Production first, then staging, then the rest: the furthest a change has got. */
function furthest(environments: string[]): string | undefined {
  const rank = (environment: string) => (isProduction(environment) ? 0 : /stag/i.test(environment) ? 1 : 2);
  return [...environments].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Where a merged change has got in a repo that promotes: the furthest
 * environment a merged promotion carried it to, and the promotion still open
 * that carries it on, if any.
 */
function promotedStage(pull: GhPull, promotions: Promotion[]): Pick<ShipItem, 'stage' | 'stageLabel' | 'at'> {
  const carrying = promotions.filter((promotion) => promotion.carried.some((carried) => carried.number === pull.number));
  const merged = carrying.filter((promotion) => promotion.pull.state === 'MERGED');
  const reached = furthest(merged.flatMap((promotion) => promotion.environments));
  const reachedAt = Math.max(Date.parse(pull.mergedAt ?? pull.updatedAt), ...merged.filter((promotion) => reached && promotion.environments.includes(reached)).map((promotion) => Date.parse(promotion.pull.mergedAt ?? promotion.pull.updatedAt)));
  if (reached && isProduction(reached)) return { stage: 'live', stageLabel: `Live in ${reached}`, at: reachedAt };
  const where = reached ? `In ${reached}, not in production yet` : 'Merged, not promoted yet';
  const next = carrying.find((promotion) => promotion.pull.state === 'OPEN');
  if (!next) return { stage: 'merged', stageLabel: where, at: reachedAt };
  const to = furthest(next.environments) ?? 'the next environment';
  const checks = openStage(next.pull);
  if (checks.stage === 'checks-failing') return { stage: 'checks-failing', stageLabel: `${where}; promotion to ${to} failing checks`, at: checks.at };
  return { stage: 'merged', stageLabel: `${where}; promotion to ${to} open`, at: checks.at };
}

/** "Production: Match the canary gates' signpost, and 3 more", for a promotion carrying nothing the panel lists. */
function carriedTitle(promotion: Promotion): string {
  const where = promotion.environments.map((environment) => environment.charAt(0).toUpperCase() + environment.slice(1)).join(' and ');
  // The newest is usually what the promotion was for.
  const newest = promotion.carried.at(-1);
  const rest = promotion.carried.length - 1;
  if (!newest || !where) return promotion.pull.title;
  return rest === 0 ? `${where}: ${newest.title}` : `${where}: ${newest.title}, and ${rest} more`;
}

function checkState(rollup: GhPull['statusCheckRollup']): 'failing' | 'running' | 'passed' {
  let running = false;
  for (const check of rollup) {
    const outcome = (check.conclusion ?? check.state ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(outcome)) return 'failing';
    if (!outcome || ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(outcome) || (check.status && check.status !== 'COMPLETED')) running = true;
  }
  return running ? 'running' : 'passed';
}

async function productionDeploy(github: string): Promise<{ sha: string; at: number } | null> {
  const out = await run('gh', ['api', `repos/${github}/deployments?per_page=30`, '--jq', '[.[] | select(.environment | test("production"; "i"))][0] | [.sha, .created_at] | @tsv']);
  const [sha, at] = out.trim().split('\t');
  return sha ? { sha, at: Date.parse(at) } : null;
}

async function contains(github: string, deployed: string, merge: string): Promise<boolean | null> {
  try {
    const status = (await run('gh', ['api', `repos/${github}/compare/${merge}...${deployed}`, '--jq', '.status'])).trim();
    return status === 'ahead' || status === 'identical';
  } catch {
    return null;
  }
}

async function githubSlug(repo: string): Promise<string | null> {
  try {
    const url = (await run('git', ['-C', repo, 'remote', 'get-url', 'origin'])).trim();
    return url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function gitCommonDir(repo: string): Promise<string | null> {
  try {
    return (await run('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() || null;
  } catch {
    return null;
  }
}

async function defaultBranch(repo: string): Promise<string> {
  try {
    return (await run('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '');
  } catch {
    return 'main';
  }
}

/**
 * Local branches an open thread names that are not merged into the default
 * branch, with a commit in the last week. Each is titled with the name of the
 * thread that names it, which is written for the user; a branch name such as
 * `slice1-hold` is the agent's filing (2026-10-11, thread 38425).
 */
async function unmergedBranches(repo: string, openThreads: ProjectState['open'], now: number): Promise<ShipItem[]> {
  if (!fs.existsSync(path.join(repo, '.git'))) return [];
  const main = await defaultBranch(repo);
  const out = await run('git', ['-C', repo, 'branch', '--no-merged', main, '--format=%(refname:short)\t%(committerdate:unix)\t%(contents:subject)']);
  const threads = openThreads.map((thread) => ({ thread, json: JSON.stringify(thread) }));
  const items: ShipItem[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [branch, at, subject] = line.split('\t');
    if (branch === main || now - Number(at) * 1000 > KEEP_OPEN_MS) continue;
    const names = new RegExp(`(^|[^\\w/-])${escape(branch)}([^\\w/-]|$)`);
    const thread = threads.find(({ json }) => names.test(json))?.thread;
    if (!thread) continue;
    // A branch with no history in common with the default one (a squashed
    // release branch) is not work waiting to merge.
    if (!await run('git', ['-C', repo, 'merge-base', main, branch]).then(() => true, () => false)) continue;
    items.push({ key: `${repo}@${branch}`, title: (thread.name ?? firstLine(thread.text) ?? subject?.trim()) || branchTitle(branch), stage: 'branch', stageLabel: 'Branch, not merged', at: Number(at) * 1000 });
  }
  return items;
}

/** The published version of the repo's package, and what has landed since. */
async function npmRelease(repo: string): Promise<ShipItem[]> {
  const manifest = path.join(repo, 'package.json');
  if (!fs.existsSync(manifest)) return [];
  const pkg = parseJson(fs.readFileSync(manifest, 'utf-8')) as { name?: string; private?: boolean };
  if (!pkg.name || pkg.private) return [];
  let published: { version: string; time: Record<string, string> };
  try {
    published = parseJson(await run('npm', ['view', pkg.name, 'version', 'time', '--json'])) as typeof published;
  } catch {
    return [];
  }
  const items: ShipItem[] = [{
    key: `${pkg.name}@${published.version}`,
    title: `${pkg.name} ${published.version}`,
    stage: 'published',
    stageLabel: 'Published',
    at: Date.parse(published.time[published.version]),
  }];
  const main = await defaultBranch(repo);
  const setter = (await run('git', ['-C', repo, 'log', '-1', '--format=%H', `-S"version": "${published.version}"`, main, '--', 'package.json'])).trim();
  if (setter) {
    const since = (await run('git', ['-C', repo, 'log', '--format=%ct', `${setter}..${main}`])).split('\n').filter(Boolean);
    if (since.length > 0) {
      items.push({
        key: `${pkg.name}@${main}`,
        title: since.length === 1 ? `1 change on ${main} since ${published.version}` : `${since.length} changes on ${main} since ${published.version}`,
        stage: 'unpublished',
        stageLabel: 'Not published',
        at: Number(since[0]) * 1000,
      });
    }
  }
  return items;
}

function branchTitle(branch: string): string {
  const words = branch.replace(/^[^/]+\/(?=.*\/)/, '').replace(/^(feature|fix)\//, '').replace(/[-_/]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function firstLine(text: string): string | undefined {
  return text.split('\n').map((line) => line.trim()).find(Boolean);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
