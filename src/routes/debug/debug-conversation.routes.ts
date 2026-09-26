import { Router, type Request, type Response } from 'express';
import { truncateId } from '@/types/index.js';
import type { DebugRouteContext, SessionEvent } from './debug-route-utils.js';
import { buildEventSummary } from './debug-route-utils.js';
import { asyncHandler } from '@/middleware/error-handler.js';
import { parsePositiveIntQuery } from '@/utils/query-helpers.js';
import { readMessages, countMessages } from '@/harness/event-message-reader.js';

export function createDebugConversationRoutes(context: DebugRouteContext): Router {
  const router = Router();
  const {
    sessionInfoService,
    conversationService,
    logger,
    resolveConversation,
    resolveSegmentConversationLink,
  } = context;

  /**
   * GET /api/debug/conversations/:id/switch-history
   * Provider-switch forensic report for a unified conversation.
   */
  router.get('/conversations/:id/switch-history', asyncHandler(async (req: Request, res: Response) => {
        const requestedId = req.params.id;
        const eventsLimit = parsePositiveIntQuery(req.query.eventsLimit, { defaultValue: 250 }) ?? 250;
        const contextLimit = parsePositiveIntQuery(req.query.contextLimit, { defaultValue: 50 }) ?? 50;
        const allEvents = String(req.query.allEvents || '').toLowerCase() === 'true'
          || String(req.query.allEvents || '') === '1';

        const interestingTypes = [
          'provider_switch',
          'context_transfer_recorded',
          'switch_initiated',
          'session_start',
          'session_end',
          'stream_connect',
          'stream_disconnect',
          'message_start',
          'message_complete',
          'error',
          'result',
        ];

        const resolved = await resolveConversation(requestedId);
        if (!resolved.conversationId || !resolved.conversation) {
          res.status(404).json({
            error: 'Conversation not found',
            requestedId,
            hint: 'Pass a conv-* conversation id, provider session id, or 8-char prefix that exists in session-info.db.',
          });
          return;
        }

        const conversation = resolved.conversation;
        const conversationId = resolved.conversationId;
        const claudeSessionIds = conversation.segments
          .filter(s => s.provider === 'claude')
          .map(s => s.providerSessionId);
        const sessionIdsToQuery = Array.from(new Set([conversationId, ...claudeSessionIds]));

        const types = allEvents ? undefined : interestingTypes;
        const eventsBySession = Object.fromEntries(
          sessionIdsToQuery.map(sessionId => ([
            sessionId,
            sessionInfoService.getSessionEvents({
              sessionId,
              limit: eventsLimit,
              ...(types ? { types } : {}),
            }),
          ]))
        ) as Record<string, SessionEvent[]>;

        const mergedTimeline = Object.entries(eventsBySession)
          .flatMap(([sessionId, events]) => events.map(e => ({ ...e, sessionId })))
          .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

        const contextTransfers = sessionInfoService.getContextTransferHistory(conversationId, contextLimit);

        const topology = conversationService.validateTopology(conversationId);

        const traceGroups = new Map<string, SessionEvent[]>();
        for (const event of mergedTimeline) {
          if (!event.traceId) continue;
          const arr = traceGroups.get(event.traceId) || [];
          arr.push(event);
          traceGroups.set(event.traceId, arr);
        }

        const getMeta = (event: SessionEvent | undefined | null): Record<string, unknown> | null => {
          if (!event?.metadata) return null;
          return (typeof event.metadata === 'object' && event.metadata !== null)
            ? (event.metadata as Record<string, unknown>)
            : null;
        };

        const traceSummaries = Array.from(traceGroups.entries())
          .map(([traceId, events]) => {
            const counts: Record<string, number> = {};
            const providers = new Set<string>();
            for (const e of events) {
              counts[e.eventType] = (counts[e.eventType] || 0) + 1;
              if (e.provider) providers.add(e.provider);
            }

            const providerSwitchEvents = events.filter(e => e.eventType === 'provider_switch');
            const contextTransferEvents = events.filter(e => e.eventType === 'context_transfer_recorded');
            const hasError = events.some(e => e.eventType === 'error'
              || (e.eventType === 'result' && !!getMeta(e)?.isError));

            const providerSwitch = providerSwitchEvents[0] || null;
            const meta = getMeta(providerSwitch);
            const fromProvider = typeof meta?.fromProvider === 'string' ? meta.fromProvider : null;
            const toProvider = providerSwitch?.provider || null;
            const segmentId = typeof meta?.segmentId === 'string' ? meta.segmentId : null;
            const sequenceNumber = typeof meta?.sequenceNumber === 'number' ? meta.sequenceNumber : null;

            const firstAt = events[0]?.timestamp || null;
            const lastAt = events[events.length - 1]?.timestamp || null;

            return {
              traceId,
              traceIdShort: traceId.slice(0, 8),
              firstAt,
              lastAt,
              providers: Array.from(providers),
              counts,
              providerSwitch: providerSwitch ? {
                eventId: providerSwitch.id,
                at: providerSwitch.timestamp,
                fromProvider,
                toProvider,
                conversationId: typeof meta?.conversationId === 'string' ? meta.conversationId : conversationId,
                segmentId,
                sequenceNumber,
                streamingId: providerSwitch.streamingId || null,
              } : null,
              anomalies: {
                missingContextTransfer: providerSwitchEvents.length > 0 && contextTransferEvents.length === 0,
                missingProviderSwitch: providerSwitchEvents.length === 0 && contextTransferEvents.length > 0,
                multipleProviderSwitch: providerSwitchEvents.length > 1,
                hasError,
              },
            };
          })
          .sort((a, b) => String(a.firstAt || '').localeCompare(String(b.firstAt || '')));

        const providerSwitchEvents = mergedTimeline.filter(e => e.eventType === 'provider_switch');
        const segmentIds = new Set(conversation.segments.map(s => s.segmentId));
        const providerSwitchesMissingSegments = providerSwitchEvents
          .map(e => {
            const meta = getMeta(e);
            const segId = typeof meta?.segmentId === 'string' ? meta.segmentId : null;
            if (!segId) return null;
            return segmentIds.has(segId) ? null : {
              traceId: e.traceId || null,
              traceIdShort: e.traceId ? e.traceId.slice(0, 8) : null,
              segmentId: segId,
              segmentIdShort: segId.slice(0, 8),
            };
          })
          .filter(Boolean);

        logger.info('Provider switch history requested', {
          conversationId: truncateId(conversationId),
          requestedId: truncateId(requestedId),
          resolvedFrom: resolved.resolvedFrom,
          segments: conversation.segments.length,
          sessionIdsQueried: sessionIdsToQuery.length,
          timelineEvents: mergedTimeline.length,
          traceGroups: traceSummaries.length,
        });

        res.json({
          checkedAt: new Date().toISOString(),
          requestedId,
          resolution: {
            conversationId,
            conversationIdShort: truncateId(conversationId),
            resolvedFrom: resolved.resolvedFrom,
            matchedSegmentId: resolved.matchedSegmentId,
            matchedSegmentIdShort: resolved.matchedSegmentId ? truncateId(resolved.matchedSegmentId) : null,
          },
          conversation: {
            conversationId: conversation.conversationId,
            workingDirectory: conversation.workingDirectory,
            latestProvider: conversation.latestProvider,
            latestSegmentId: conversation.latestSegmentId,
            segments: conversation.segments.map(s => ({
              segmentId: s.segmentId,
              segmentIdShort: truncateId(s.segmentId),
              sequenceNumber: s.sequenceNumber,
              provider: s.provider,
              providerSessionId: s.providerSessionId,
              providerSessionIdShort: truncateId(s.providerSessionId),
              streamingId: s.streamingId || null,
              streamingIdShort: s.streamingId ? truncateId(s.streamingId) : null,
              status: s.status,
              createdAt: s.createdAt,
              endedAt: s.endedAt || null,
              model: s.model || null,
            })),
          },
          contextTransfers,
          traceIds: traceSummaries.map(t => t.traceId),
          traceSummaries,
          sessionSummaries: Object.fromEntries(
            Object.entries(eventsBySession).map(([sessionId, events]) => ([
              sessionId,
              {
                sessionId,
                sessionIdShort: truncateId(sessionId),
                summary: buildEventSummary(events),
              },
            ]))
          ),
          timeline: mergedTimeline,
          anomalies: {
            multipleActiveSegments: topology.activeSegments.length > 1,
            activeSegmentCount: topology.activeSegments.length,
            activeSegments: topology.activeSegments.map(s => ({
              segmentId: s.segmentId,
              segmentIdShort: truncateId(s.segmentId),
              provider: s.provider,
              streamingId: s.streamingId || null,
              streamingIdShort: s.streamingId ? truncateId(s.streamingId) : null,
            })),
            duplicateSequenceNumbers: topology.anomalies.some(a => a.type === 'duplicate_sequence_numbers'),
            latestSegmentMismatch: topology.anomalies.some(a => a.type === 'latest_segment_mismatch'),
            expectedLatestSegmentId: topology.expectedLatestSegmentId,
            expectedLatestSegmentIdShort: topology.expectedLatestSegmentId ? truncateId(topology.expectedLatestSegmentId) : null,
            providerSwitchesMissingSegments,
            topologyAnomalies: topology.anomalies,
          },
        });
  }));

  /**
   * GET /api/debug/conversations/:id/message-linkage
   * Forensics for message persistence/hydration issues.
   */
  router.get('/conversations/:id/message-linkage', asyncHandler(async (req: Request, res: Response) => {
        const requestedId = req.params.id;
        const resolved = await resolveConversation(requestedId);

        if (!resolved.conversationId || !resolved.conversation) {
          res.status(404).json({
            error: 'Conversation not found',
            requestedId,
            hint: 'Pass a conv-* conversation id, provider session id, or 8-char prefix that exists in session-info.db.',
          });
          return;
        }

        const conversation = resolved.conversation;
        const conversationId = resolved.conversationId;

        const storeCandidates: Array<{
          storeKey: string;
          kind: 'canonical' | 'segment';
          providerHint: string | null;
        }> = [];

        storeCandidates.push({
          storeKey: conversationId,
          kind: 'canonical',
          providerHint: null,
        });

        const seenStoreKeys = new Set<string>([conversationId]);
        for (const segment of conversation.segments) {
          if (!segment.providerSessionId || seenStoreKeys.has(segment.providerSessionId)) continue;
          seenStoreKeys.add(segment.providerSessionId);
          storeCandidates.push({
            storeKey: segment.providerSessionId,
            kind: 'segment',
            providerHint: segment.provider,
          });
        }

        const stores = await Promise.all(storeCandidates.map(async (candidate) => {
          const total = countMessages(candidate.storeKey);
          const claude = total; // All messages are claude in harness events
          const msgs = readMessages(candidate.storeKey);
          const first = msgs.length > 0 ? msgs[0] : null;
          const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;

          const roleCounts: Record<string, number> = {};
          const streamingIdBreakdown: Array<{
            streamingId: string | null;
            provider: string;
            count: number;
            firstAt: string | null;
            lastAt: string | null;
          }> = [];

          const queryError: string | null = null;
          // Derive role counts from converted messages
          for (const m of msgs) {
            roleCounts[m.role] = (roleCounts[m.role] ?? 0) + 1;
          }

          return {
            storeKey: candidate.storeKey,
            storeKeyShort: truncateId(candidate.storeKey),
            kind: candidate.kind,
            providerHint: candidate.providerHint,
            counts: {
              total,
              claude,
              user: roleCounts.user ?? null,
              assistant: roleCounts.assistant ?? null,
              system: roleCounts.system ?? null,
            },
            firstMessage: first ? {
              id: first.id,
              idShort: truncateId(first.id),
              provider: first.provider,
              role: first.role,
              timestamp: first.timestamp,
            } : null,
            lastMessage: last ? {
              id: last.id,
              idShort: truncateId(last.id),
              provider: last.provider,
              role: last.role,
              timestamp: last.timestamp,
            } : null,
            streamingIdBreakdown,
            ...(queryError ? { queryError } : {}),
          };
        }));

        const segmentSessionInfo = conversation.segments.map((segment) => {
          const linkage = resolveSegmentConversationLink(segment);
          const info = linkage.sessionInfo;
          return {
            segmentId: segment.segmentId,
            segmentIdShort: truncateId(segment.segmentId),
            provider: segment.provider,
            providerSessionId: segment.providerSessionId,
            providerSessionIdShort: truncateId(segment.providerSessionId),
            linkageSource: linkage.linkageSource,
            linkedConversationId: linkage.linkedConversationId,
            linkedConversationIdShort: linkage.linkedConversationIdShort,
            sessionInfo: info ? {
              exists: true,
              conversationId: info.conversation_id || null,
              conversationIdShort: info.conversation_id ? truncateId(info.conversation_id) : null,
              workspace: info.workspace,
              archived: info.archived,
              pinned: info.pinned,
              pausedReason: info.paused_reason ?? null,
            } : { exists: false },
          };
        });

        const segmentsMissingSessionInfo = segmentSessionInfo
          .filter((entry) => entry.linkageSource === 'none')
          .map((entry) => ({
            providerSessionId: entry.providerSessionId,
            providerSessionIdShort: entry.providerSessionIdShort,
            provider: entry.provider,
          }));

        const segmentsWrongConversationLink = segmentSessionInfo
          .filter((entry) => entry.linkedConversationId && entry.linkedConversationId !== conversationId)
          .map((entry) => ({
            providerSessionId: entry.providerSessionId,
            providerSessionIdShort: entry.providerSessionIdShort,
            provider: entry.provider,
            linkedConversationId: entry.linkedConversationId as string,
            linkedConversationIdShort: entry.linkedConversationIdShort,
          }));

        const canonical = stores.find((s) => s.kind === 'canonical') || null;
        const segmentStoresWithMessages = stores
          .filter((s) => s.kind === 'segment' && s.counts.total > 0)
          .map((s) => ({ storeKey: s.storeKey, storeKeyShort: s.storeKeyShort, providerHint: s.providerHint }));

        res.json({
          checkedAt: new Date().toISOString(),
          requestedId,
          resolution: {
            conversationId,
            conversationIdShort: truncateId(conversationId),
            resolvedFrom: resolved.resolvedFrom,
            matchedSegmentId: resolved.matchedSegmentId,
            matchedSegmentIdShort: resolved.matchedSegmentId ? truncateId(resolved.matchedSegmentId) : null,
          },
          conversation: {
            conversationId: conversation.conversationId,
            workingDirectory: conversation.workingDirectory,
            latestProvider: conversation.latestProvider,
            latestSegmentId: conversation.latestSegmentId,
            segmentCount: conversation.segments.length,
          },
          stores,
          sessionInfo: {
            conversation: (() => {
              const info = sessionInfoService.getSessionInfoSync(conversationId);
              return info ? {
                exists: true,
                archived: info.archived,
                pinned: info.pinned,
                workspace: info.workspace,
                pausedReason: info.paused_reason ?? null,
              } : { exists: false };
            })(),
            segments: segmentSessionInfo,
          },
          anomalies: {
            canonicalStoreEmpty: (canonical?.counts.total ?? 0) === 0,
            segmentStoresWithMessages,
            canonicalEmptyButSegmentsHaveMessages: (canonical?.counts.total ?? 0) === 0 && segmentStoresWithMessages.length > 0,
            segmentsMissingSessionInfo,
            segmentsWrongConversationLink,
          },
        });
  }));

  /**
   * POST /api/debug/conversations/:id/repair
   * Best-effort repair for common persistence/linkage issues.
   */
  router.post('/conversations/:id/repair', asyncHandler(async (req: Request, res: Response) => {
        const requestedId = req.params.id;
        const apply = String(req.query.apply || '').toLowerCase() === 'true'
          || String(req.query.apply || '') === '1';

        const resolved = await resolveConversation(requestedId);
        if (!resolved.conversationId || !resolved.conversation) {
          res.status(404).json({
            error: 'Conversation not found',
            requestedId,
            hint: 'Pass a conv-* conversation id, provider session id, or 8-char prefix that exists in session-info.db.',
          });
          return;
        }

        const conversation = resolved.conversation;
        const conversationId = resolved.conversationId;

        const sessionInfoUpdates: Array<{
          provider: string;
          providerSessionId: string;
          providerSessionIdShort: string;
          fromConversationId: string | null;
          fromConversationIdShort: string | null;
          toConversationId: string;
          toConversationIdShort: string;
        }> = [];

        const messageMoves: Array<{
          fromStoreKey: string;
          fromStoreKeyShort: string;
          toStoreKey: string;
          toStoreKeyShort: string;
          messageCount: number;
        }> = [];

        for (const segment of conversation.segments) {
          const info = sessionInfoService.getSessionInfoSync(segment.providerSessionId);
          if (info && info.conversation_id !== conversationId) {
            sessionInfoUpdates.push({
              provider: segment.provider,
              providerSessionId: segment.providerSessionId,
              providerSessionIdShort: truncateId(segment.providerSessionId),
              fromConversationId: info.conversation_id || null,
              fromConversationIdShort: info.conversation_id ? truncateId(info.conversation_id) : null,
              toConversationId: conversationId,
              toConversationIdShort: truncateId(conversationId),
            });
          }

          const legacyCount = segment.providerSessionId !== conversationId
            ? countMessages(segment.providerSessionId)
            : 0;
          if (legacyCount > 0) {
            messageMoves.push({
              fromStoreKey: segment.providerSessionId,
              fromStoreKeyShort: truncateId(segment.providerSessionId),
              toStoreKey: conversationId,
              toStoreKeyShort: truncateId(conversationId),
              messageCount: legacyCount,
            });
          }

        }

        const planned = {
          sessionInfoUpdates,
          messageMoves,
        };

        if (!apply) {
          res.json({
            checkedAt: new Date().toISOString(),
            requestedId,
            apply: false,
            resolution: {
              conversationId,
              conversationIdShort: truncateId(conversationId),
              resolvedFrom: resolved.resolvedFrom,
              matchedSegmentId: resolved.matchedSegmentId,
              matchedSegmentIdShort: resolved.matchedSegmentId ? truncateId(resolved.matchedSegmentId) : null,
            },
            planned,
          });
          return;
        }

        const applied = {
          sessionInfoUpdated: 0,
          messagesMoved: [] as Array<{ fromStoreKeyShort: string; movedRows: number }>,
        };

        for (const update of sessionInfoUpdates) {
          await sessionInfoService.updateSessionInfo(update.providerSessionId, {
            conversation_id: conversationId,
          });
          applied.sessionInfoUpdated += 1;
        }

        // Message moves no longer needed — harness_events uses conversationId as the canonical key.
        for (const move of messageMoves) {
          applied.messagesMoved.push({
            fromStoreKeyShort: move.fromStoreKeyShort,
            movedRows: 0,
          });
        }

        res.json({
          checkedAt: new Date().toISOString(),
          requestedId,
          apply: true,
          resolution: {
            conversationId,
            conversationIdShort: truncateId(conversationId),
            resolvedFrom: resolved.resolvedFrom,
            matchedSegmentId: resolved.matchedSegmentId,
            matchedSegmentIdShort: resolved.matchedSegmentId ? truncateId(resolved.matchedSegmentId) : null,
          },
          planned,
          applied,
        });
  }));

  /**
   * GET /api/debug/conversation-integrity
   * Scans recent conversations for common persistence/linkage anomalies.
   */
  router.get('/conversation-integrity', asyncHandler(async (req: Request, res: Response) => {
        const rawLimit = parsePositiveIntQuery(req.query.limit, { defaultValue: 50, max: 200 }) ?? 50;
        const rawOffset = parsePositiveIntQuery(req.query.offset, { defaultValue: 0, allowZero: true }) ?? 0;
        const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 50;
        const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

        const { conversations, total } = conversationService.listConversations({ limit, offset });

        const canonicalEmptyButSegmentsHaveMessages: Array<{
          conversationId: string;
          conversationIdShort: string;
          canonicalCount: number;
          segmentStoresWithMessages: Array<{
            provider: string;
            storeKey: string;
            storeKeyShort: string;
            count: number;
          }>;
        }> = [];

        const segmentsWrongConversationLink: Array<{
          conversationId: string;
          conversationIdShort: string;
          mismatches: Array<{
            provider: string;
            providerSessionId: string;
            providerSessionIdShort: string;
            linkedConversationId: string;
            linkedConversationIdShort: string;
          }>;
        }> = [];

        const segmentsMissingSessionInfo: Array<{
          conversationId: string;
          conversationIdShort: string;
          missing: Array<{
            provider: string;
            providerSessionId: string;
            providerSessionIdShort: string;
          }>;
        }> = [];

        for (const conversation of conversations) {
          const conversationId = conversation.conversationId;
          const canonicalCount = countMessages(conversationId);

          const segmentStoresWithMessages: Array<{
            provider: string;
            storeKey: string;
            storeKeyShort: string;
            count: number;
          }> = [];

          const mismatches: Array<{
            provider: string;
            providerSessionId: string;
            providerSessionIdShort: string;
            linkedConversationId: string;
            linkedConversationIdShort: string;
          }> = [];

          const missing: Array<{
            provider: string;
            providerSessionId: string;
            providerSessionIdShort: string;
          }> = [];

          for (const segment of conversation.segments) {
            const segmentStoreCount = countMessages(segment.providerSessionId);
            if (segmentStoreCount > 0) {
              segmentStoresWithMessages.push({
                provider: segment.provider,
                storeKey: segment.providerSessionId,
                storeKeyShort: truncateId(segment.providerSessionId),
                count: segmentStoreCount,
              });
            }

            const linkage = resolveSegmentConversationLink(segment);
            if (linkage.linkageSource === 'none') {
              missing.push({
                provider: segment.provider,
                providerSessionId: segment.providerSessionId,
                providerSessionIdShort: truncateId(segment.providerSessionId),
              });
              continue;
            }

            if (linkage.linkedConversationId && linkage.linkedConversationId !== conversationId) {
              mismatches.push({
                provider: segment.provider,
                providerSessionId: segment.providerSessionId,
                providerSessionIdShort: truncateId(segment.providerSessionId),
                linkedConversationId: linkage.linkedConversationId,
                linkedConversationIdShort: linkage.linkedConversationIdShort || truncateId(linkage.linkedConversationId),
              });
            }
          }

          if (canonicalCount === 0 && segmentStoresWithMessages.length > 0) {
            canonicalEmptyButSegmentsHaveMessages.push({
              conversationId,
              conversationIdShort: truncateId(conversationId),
              canonicalCount,
              segmentStoresWithMessages,
            });
          }

          if (mismatches.length > 0) {
            segmentsWrongConversationLink.push({
              conversationId,
              conversationIdShort: truncateId(conversationId),
              mismatches,
            });
          }

          if (missing.length > 0) {
            segmentsMissingSessionInfo.push({
              conversationId,
              conversationIdShort: truncateId(conversationId),
              missing,
            });
          }
        }

        res.json({
          checkedAt: new Date().toISOString(),
          paging: {
            limit,
            offset,
            totalConversations: total,
            scanned: conversations.length,
          },
          summary: {
            canonicalEmptyButSegmentsHaveMessages: canonicalEmptyButSegmentsHaveMessages.length,
            segmentsWrongConversationLink: segmentsWrongConversationLink.length,
            segmentsMissingSessionInfo: segmentsMissingSessionInfo.length,
          },
          anomalies: {
            canonicalEmptyButSegmentsHaveMessages,
            segmentsWrongConversationLink,
            segmentsMissingSessionInfo,
          },
        });
  }));

  return router;
}
