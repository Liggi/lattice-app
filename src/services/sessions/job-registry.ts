/**
 * Unified Job Registry: combines core Lattice-managed/watched jobs (`job-watch.ts`)
 * with every registered plugin job provider
 * into one consistent `JobsFeedResponse` for `/api/jobs` and `Running now`.
 */

import type { LatticeJobProvider, LatticeJobRecord } from '@liggi/lattice-plugin-kit';
import { createLogger } from '@/services/infrastructure/logger.js';
import { pluginJobProviders } from '@/services/plugins/plugin-registry.js';
import { cannotRead, hasStarted, isIndeterminateJob, isStalled, jobRate, quietSince } from '@/types/job-stall.js';
import { isActiveJobState, type JobLifecycleState, type JobProjectRef, type JobProviderWarning, type JobRecord, type JobsFeedResponse } from '@/types/jobs.js';
import { ConversationService } from './conversation-service.js';
import { describeSource } from './job-count.js';
import { endedAt, type JobProgress } from './job-progress.js';
import { jobWatch } from './job-watch.js';
import { SessionInfoService } from './session-info-service.js';

const logger = createLogger('JobRegistry');

/** Show ended jobs in Running now's Recent list for 24 hours. */
const RECENT_WINDOW_MS = 24 * 60 * 60_000;

export function encodeLocalJobId(session: string, label: string): string {
  return `local:${encodeURIComponent(session)}:${encodeURIComponent(label)}`;
}

export function decodeLocalJobId(id: string): { session: string; label: string } | null {
  if (!id.startsWith('local:')) return null;
  const rest = id.slice('local:'.length);
  const sep = rest.indexOf(':');
  if (sep < 0) return null;
  try {
    return {
      session: decodeURIComponent(rest.slice(0, sep)),
      label: decodeURIComponent(rest.slice(sep + 1)),
    };
  } catch {
    return null;
  }
}

export type ProjectResolver = (sessionId: string) => JobProjectRef | null;

function defaultProjectResolver(): ProjectResolver {
  const convService = ConversationService.getInstance();
  const infoService = SessionInfoService.getInstance();
  const cache = new Map<string, JobProjectRef | null>();
  return (sessionId: string): JobProjectRef | null => {
    if (cache.has(sessionId)) return cache.get(sessionId) ?? null;
    try {
      const conv = convService.getConversation(sessionId);
      // For a worker conversation, link up to its parent coordinator project.
      const ownerId = conv?.pickedUpFrom && convService.getConversation(conv.pickedUpFrom)
        ? conv.pickedUpFrom
        : sessionId;
      const ownerConv = ownerId === sessionId ? conv : convService.getConversation(ownerId);
      const info = infoService.getSessionInfoBatch([ownerId], { includeIdentityImage: false }).get(ownerId);
      const prompt = ownerConv?.initialPrompt?.split('\n').map((line) => line.trim()).find(Boolean);
      const name = info?.custom_name?.trim() || info?.project_name?.trim() || prompt || ownerId;
      const kind: 'project' | 'session' = ownerConv?.coordinator ? 'project' : 'session';
      const ref: JobProjectRef = { id: ownerId, name: name.length > 72 ? `${name.slice(0, 71).trimEnd()}…` : name, kind };
      cache.set(sessionId, ref);
      return ref;
    } catch {
      cache.set(sessionId, null);
      return null;
    }
  };
}

function durationShort(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 30) / 2} hr`;
}

export function mapLocalJob(job: JobProgress, now: number, resolveProject: ProjectResolver): JobRecord {
  const ended = endedAt(job);
  const ratePerMs = jobRate(job);
  const ratePerMin = ratePerMs > 0 ? ratePerMs * 60_000 : null;
  let state: JobLifecycleState;
  let stateReason: string | null = null;
  let etaAt: number | null = null;

  if (job.finishedAt !== undefined) {
    state = 'completed';
    if (job.skipped && job.skipped > 0) {
      stateReason = `${job.skipped.toLocaleString('en-GB')} skipped`;
    }
  } else if (job.stopped !== undefined) {
    if (job.exitCode !== undefined && job.exitCode !== 0) {
      state = 'failed';
      stateReason = job.stopped;
    } else if (job.abandoned) {
      state = 'cancelled';
      stateReason = job.stopped;
    } else {
      state = 'cancelled';
      stateReason = job.stopped;
    }
  } else {
    const readErr = cannotRead(job);
    if (readErr !== null) {
      state = 'stalled';
      stateReason = `Cannot read count: ${readErr}`;
    } else if (isIndeterminateJob(job)) {
      if (isStalled(job, now)) {
        state = 'stalled';
        stateReason = `No output for ${durationShort(now - quietSince(job))}`;
      } else {
        state = 'working';
      }
    } else if (!hasStarted(job) && job.done === 0) {
      if (isStalled(job, now)) {
        state = 'stalled';
        stateReason = `No first item after ${durationShort(now - job.startedAt)}`;
      } else {
        state = 'starting';
        stateReason = null;
      }
    } else if (isStalled(job, now)) {
      state = 'stalled';
      stateReason = `No progress for ${durationShort(now - job.movedAt)}`;
    } else {
      state = 'working';
      if (ratePerMs > 0 && job.total > 0 && job.done < job.total) {
        const remainingMs = Math.max(0, (job.total - job.done) / ratePerMs - (now - job.movedAt));
        etaAt = Math.round(now + remainingMs);
      }
    }
  }

  const provenance = job.source
    ? formatProvenance(describeSource(job.source), job.totalFrom, job.command)
    : 'Legacy hand-reported count';

  return {
    id: encodeLocalJobId(job.session, job.label),
    provider: 'local',
    providerLabel: 'Local',
    label: job.label,
    state,
    stateReason,
    session: job.session,
    project: resolveProject(job.session),
    done: job.done,
    total: job.total > 0 ? job.total : null,
    unit: job.unit ?? 'items',
    ...(job.skipped !== undefined ? { skipped: job.skipped } : {}),
    ...(job.failedCount !== undefined ? { failedCount: job.failedCount } : {}),
    stage: job.stage ?? null,
    message: job.message ?? null,
    startedAt: job.startedAt,
    movedAt: job.movedAt,
    updatedAt: job.reportedAt,
    endedAt: ended ?? null,
    ratePerMin: ratePerMin !== null ? Number(ratePerMin.toFixed(2)) : null,
    etaAt,
    etaGuess: false,
    provenance,
    command: job.command ?? null,
    pid: job.pid ?? null,
    exitCode: job.exitCode ?? null,
    ...(job.logTail && job.logTail.length > 0 ? { logTail: job.logTail } : {}),
    canStop: ended === undefined && Boolean(job.managed || job.pid),
    externalUrl: null,
    detailView: null,
  };
}

function formatProvenance(source: string, totalFrom?: string, command?: string): string {
  if (source.startsWith('events')) {
    if (command) {
      const tokens = command.trim().split(/\s+/);
      const script = tokens.find((tok) => /\.(py|ts|js|mjs|sh)$/.test(tok));
      const base = script ? script.split('/').at(-1) : null;
      if (base) return `Self-reported by ${base}`;
    }
    return 'Self-reported by command';
  }
  const cap = source.charAt(0).toUpperCase() + source.slice(1);
  return totalFrom ? `${cap}; total from ${totalFrom}` : cap;
}

function stateSortRank(state: JobLifecycleState): number {
  switch (state) {
    case 'stalled': return 0;
    case 'working': return 1;
    case 'starting': return 2;
    case 'waiting': return 3;
    case 'failed': return 4;
    case 'cancelled': return 5;
    case 'completed': return 6;
  }
}

export interface CollectJobsDeps {
  localJobs?: JobProgress[];
  providers?: LatticeJobProvider[];
  resolveProject?: ProjectResolver;
  now?: number;
}

export async function collectJobsFeed(deps: CollectJobsDeps = {}): Promise<JobsFeedResponse> {
  const now = deps.now ?? Date.now();
  const resolveProject = deps.resolveProject ?? defaultProjectResolver();
  const localRaw = deps.localJobs ?? jobWatch().store.all(now);
  const localRecords: JobRecord[] = localRaw
    .filter((job) => {
      const ended = endedAt(job);
      return ended === undefined || now - ended <= RECENT_WINDOW_MS;
    })
    .map((job) => mapLocalJob(job, now, resolveProject));

  const providers = deps.providers ?? pluginJobProviders();
  const warnings: JobProviderWarning[] = [];
  const providerRecords: JobRecord[] = [];

  await Promise.all(providers.map(async (provider) => {
    try {
      const snapshot = await provider.list();
      for (const job of snapshot.jobs) {
        providerRecords.push(normalizeProviderJob(job, provider, resolveProject));
      }
      if (snapshot.warning) {
        warnings.push({ provider: provider.id, providerLabel: provider.label, message: snapshot.warning });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn('Job provider failed to list jobs', { provider: provider.id, error: msg });
      warnings.push({ provider: provider.id, providerLabel: provider.label, message: msg });
    }
  }));

  const jobs = [...localRecords, ...providerRecords].sort((a, b) => {
    const rankDiff = stateSortRank(a.state) - stateSortRank(b.state);
    if (rankDiff !== 0) return rankDiff;
    const aTime = isActiveJobState(a.state) ? a.startedAt : (a.endedAt ?? a.updatedAt);
    const bTime = isActiveJobState(b.state) ? b.startedAt : (b.endedAt ?? b.updatedAt);
    return bTime - aTime;
  });

  const active = jobs.filter((job) => isActiveJobState(job.state));
  const stalledCount = active.filter((job) => job.state === 'stalled').length;
  const failedCount = jobs.filter((job) => job.state === 'failed' && job.endedAt != null && now - job.endedAt <= RECENT_WINDOW_MS).length;

  return {
    jobs,
    activeCount: active.length,
    stalledCount,
    failedCount,
    warnings,
    readAt: now,
  };
}

function normalizeProviderJob(job: LatticeJobRecord, provider: LatticeJobProvider, resolveProject: ProjectResolver): JobRecord {
  const project = job.project ?? (job.session ? resolveProject(job.session) : null);
  return {
    ...job,
    provider: job.provider || provider.id,
    providerLabel: job.providerLabel || provider.label,
    project,
  };
}

export async function stopUnifiedJob(jobId: string, why = 'Stopped from Running now'): Promise<{ ok: true }> {
  const local = decodeLocalJobId(jobId);
  if (local) {
    jobWatch().stopJob(local.session, local.label, why);
    return { ok: true };
  }
  const providers = pluginJobProviders();
  for (const provider of providers) {
    if (jobId.startsWith(`${provider.id}:`) && provider.stop) {
      await provider.stop(jobId);
      return { ok: true };
    }
  }
  throw new Error('This job does not support stopping from Lattice.');
}
