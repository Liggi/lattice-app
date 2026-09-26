/**
 * The article surface: read a learning-map node, and ask about any span of it.
 *
 * Two things live here that do not exist in the chat view. Persisted exchanges
 * are marginalia — each one's question and answer render in the flow of the
 * article, under the block containing the span it was asked about, so a reread
 * meets the questions where they were raised rather than in a comment log at
 * the bottom. And a highlight is an ask: selecting text offers a question box,
 * and the answer streams back from a real Lattice session into the card.
 *
 * Everything about selecting, matching and highlighting a span is the chat's
 * annotation machinery, reused: `AnnotationSelectionLayer` with an article
 * selection reader, `findQuoteRangeInIndex` for locating stored quotes, and the
 * `lattice-annotation` highlight registry for painting them.
 *
 * The third thing is following a question out. Hovering a bold term offers
 * "tell me more about this"; taking it writes a new node onto the map and the
 * question onto the edge that reaches it, then opens that node — empty. An
 * empty article with a `follow` edge into it is an article nobody has written
 * yet, so this page briefs a session and streams the article into the page it is
 * already on. That is the whole shape of the map: a node is somewhere you got
 * to, and an edge is the question that took you there.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, X } from 'lucide-react';
import { AnnotationSelectionLayer } from '../MessageAnnotations/AnnotationSelectionLayer';
import {
  ANNOTATION_HIGHLIGHT_NAME,
  supportsHighlightApi,
} from '../MessageAnnotations/useAnnotationHighlights';
import {
  buildNormalizedTextIndex,
  findQuoteRangeInIndex,
} from '../../utils/annotation-range';
import {
  followArticle,
  generateTooltips,
  getArticleDetail,
  getMapDetail,
  type KmArticle,
  type KmEdge,
  type KmExchange,
  type KmMap,
} from '../../services/api/km-api';
import { ArticleMarkdown } from './article/ArticleMarkdown';
import { ExchangeCard } from './article/ExchangeCard';
import { createArticleSelectionReader, resetArticleSelectionMemo } from './article/article-selection';
import { useArticleResponder } from './article/useArticleResponder';
import { WRITE_STATUS_LABEL, useArticleWriter } from './article/useArticleWriter';
import { useExchangeAnchors } from './article/useExchangeAnchors';
import { ASK_STATUS_LABEL } from './article/ask-state';
import { tintFor } from './map/node-palette';

/**
 * The node's type, in thekg.io's idiom: a small sentence-case word in the
 * type's own hue, not a bordered tag. Same hue table the map nodes use, so a
 * node reads the same on the canvas and on its page.
 */
function NodeTypeLabel({ nodeType }: { nodeType: string }): JSX.Element {
  const tint = tintFor(nodeType);
  return (
    <span data-testid="km-article-node-type" className={`text-xs font-medium ${tint.labelClass}`}>
      {tint.label}
    </span>
  );
}

/**
 * Where the article came from. Quiet and recessive — provenance is for the
 * reader who wants to interrogate a node, not part of reading it.
 */
function Provenance({
  article,
  responderConv,
}: {
  article: KmArticle;
  responderConv: string | null;
}): JSX.Element | null {
  const hasAny = article.created_from || article.created_by_conv || responderConv;
  if (!hasAny) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
      {article.created_from && <span>{article.created_from}</span>}
      {article.created_by_conv && (
        <Link
          to={`/c/${article.created_by_conv}`}
          className="text-accent underline underline-offset-2 decoration-dotted"
        >
          {article.created_by_conv}
        </Link>
      )}
      {responderConv && responderConv !== article.created_by_conv && (
        <span>
          questions go to{' '}
          <Link
            to={`/c/${responderConv}`}
            className="text-accent underline underline-offset-2 decoration-dotted"
          >
            {responderConv}
          </Link>
        </span>
      )}
    </div>
  );
}

export interface ArticlePageProps {
  /**
   * How to open another article. The workspace owns URL building (it carries
   * the `?from=` session and remembers the open article per map), so following
   * a question hands the child back to it rather than routing on its own.
   */
  onOpenArticle?: (articleId: string) => void;
}

export function ArticlePage({ onOpenArticle }: ArticlePageProps = {}): JSX.Element {
  const { mapId = '', articleId = '' } = useParams<{ mapId: string; articleId: string }>();
  const navigate = useNavigate();

  const [article, setArticle] = useState<KmArticle | null>(null);
  const [map, setMap] = useState<KmMap | null>(null);
  const [edges, setEdges] = useState<KmEdge[]>([]);
  const [exchanges, setExchanges] = useState<KmExchange[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [following, setFollowing] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);

  const hostRef = useRef<HTMLElement | null>(null);
  const setHostElement = useCallback((element: HTMLDivElement | null) => {
    hostRef.current = element;
    setHost(element);
  }, []);

  // --- Load ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    void (async () => {
      try {
        const [detail, mapDetail] = await Promise.all([
          getArticleDetail(articleId),
          getMapDetail(mapId),
        ]);
        if (cancelled) return;
        setArticle(detail.article);
        setExchanges(detail.exchanges);
        setMap(mapDetail.map);
        setEdges(mapDetail.edges);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [articleId, mapId]);

  // Explain the article's bold terms. thekg.io generates these on first read
  // and caches them on the article; the server does the same, so this is a
  // cheap no-op on every visit after the first. A failure is silent — an
  // article without tooltips simply reads as plain bold text.
  const [tooltips, setTooltips] = useState<Record<string, string>>({});
  const tooltipsRequestedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!article) return;
    setTooltips(article.tooltips ?? {});
    // An article being written has no bold terms yet, and asking about none
    // would burn the one-shot guard below before the text arrives. Skipping
    // without arming it is what lets this run again once the body lands.
    if (article.content_md.trim() === '') return;
    if (tooltipsRequestedRef.current === article.id) return;
    tooltipsRequestedRef.current = article.id;

    let cancelled = false;
    void (async () => {
      try {
        const result = await generateTooltips(article.id);
        if (!cancelled) setTooltips(result.tooltips);
      } catch (tooltipError) {
        console.warn('learning map: tooltip generation failed', tooltipError);
      }
    })();
    return () => { cancelled = true; };
  }, [article]);

  // The selection reader memoizes a text index per host; a new body invalidates it.
  useEffect(() => {
    resetArticleSelectionMemo();
  }, [article?.content_md]);

  // --- Asking -------------------------------------------------------------
  const upsertExchange = useCallback((exchange: KmExchange) => {
    setExchanges((current) => {
      const index = current.findIndex((candidate) => candidate.id === exchange.id);
      if (index < 0) return [...current, exchange];
      const next = current.slice();
      next[index] = exchange;
      return next;
    });
  }, []);

  const onDefaultConv = useCallback((conversationId: string) => {
    setMap((current) => (current ? { ...current, default_conv: conversationId } : current));
  }, []);

  const responder = useArticleResponder({
    mapId,
    mapName: map?.name ?? '',
    articleId,
    articleTitle: article?.title ?? '',
    articleConv: article?.created_by_conv ?? null,
    mapDefaultConv: map?.default_conv ?? null,
    onCreated: upsertExchange,
    onAnswered: upsertExchange,
    onDefaultConv,
  });

  // --- Following a question out ------------------------------------------
  const openArticle = useCallback((nextArticleId: string) => {
    if (onOpenArticle) onOpenArticle(nextArticleId);
    else navigate(`/map/${encodeURIComponent(mapId)}/article/${encodeURIComponent(nextArticleId)}`);
  }, [onOpenArticle, navigate, mapId]);

  const writer = useArticleWriter({
    mapId,
    mapName: map?.name ?? '',
    articleId,
    articleConv: article?.created_by_conv ?? null,
    mapDefaultConv: map?.default_conv ?? null,
    onWritten: setArticle,
    onDefaultConv,
  });
  const { write: startWriting } = writer;

  /**
   * thekg.io's `handleLearnMoreRequest`, verbatim in shape: synthesise the
   * question from the concept, create the child, navigate to it. The question
   * text is the original's exactly — it is what ends up on the edge, and it is
   * the trail's own record of why this node exists.
   */
  const handleLearnMore = useCallback((concept: string) => {
    if (following || !article) return;
    setFollowing(true);
    setFollowError(null);
    // Verbatim, not lower-cased. thekg.io lower-cases here because its concepts
    // are prose ("recursion", "the bind operator") and a capital mid-sentence
    // reads wrong. Ours are as often code — `runStartupRecoverySweep` becomes
    // an unsearchable `runstartuprecoverysweep`, and that string is what the
    // edge carries and what the reader sees on the map forever.
    const question = `Tell me more about ${concept}`;
    void (async () => {
      try {
        const { article: child } = await followArticle(article.id, {
          question,
          concept,
          // The child inherits the responder, so the session that wrote this
          // article is the one asked to write the next — it already has the
          // context this question came out of.
          created_by_conv: article.created_by_conv ?? map?.default_conv ?? null,
        });
        openArticle(child.id);
      } catch (error) {
        setFollowError(
          `That question could not be followed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        setFollowing(false);
      }
    })();
  }, [following, article, map?.default_conv, openArticle]);

  /**
   * An article with no body and a `follow` edge into it is one nobody has
   * written yet: the reader is standing on the far end of a question. Brief the
   * responder with the article they came from and let it write this one.
   *
   * Derived from stored rows rather than carried through navigation, so a
   * reload part-way through picks the write back up instead of stranding an
   * empty node.
   */
  const writeRequestedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!article || !map) return;
    if (article.content_md.trim() !== '') return;
    if (writeRequestedRef.current === article.id) return;

    const followed = edges.find((edge) => (
      edge.to_article_id === article.id && edge.kind === 'follow' && edge.label
    ));
    if (!followed?.label) return;
    writeRequestedRef.current = article.id;

    let cancelled = false;
    void (async () => {
      try {
        const parent = await getArticleDetail(followed.from_article_id);
        if (cancelled) return;
        startWriting({
          question: followed.label as string,
          concept: article.title,
          parentTitle: parent.article.title,
          parentContent: parent.article.content_md,
        });
      } catch (error) {
        if (!cancelled) {
          setFollowError(
            'The article this question came from could not be read, so nothing '
            + `was asked to write this one: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();
    return () => { cancelled = true; };
  }, [article, map, edges, startWriting]);

  const readSelection = useMemo(
    () => createArticleSelectionReader(articleId, () => hostRef.current),
    [articleId],
  );

  // One band for anything non-fatal, whichever flow raised it.
  const notice = responder.notice ?? writer.notice ?? followError;
  const dismissNotice = useCallback(() => {
    responder.dismissNotice();
    writer.dismissNotice();
    setFollowError(null);
  }, [responder, writer]);

  const handleAsk = useCallback((input: {
    messageId: string;
    quote: string;
    note: string;
    quoteStart: number | null;
  }) => {
    responder.ask({ quote: input.quote, quoteStart: input.quoteStart, question: input.note });
  }, [responder]);

  // --- Marginalia ---------------------------------------------------------
  const anchors = useExchangeAnchors(host, article?.content_md ?? '', exchanges);
  const exchangeById = useMemo(
    () => new Map(exchanges.map((exchange) => [exchange.id, exchange])),
    [exchanges],
  );

  const liveFor = useCallback((exchangeId: string) => (
    responder.live && responder.live.exchangeId === exchangeId
      ? {
          status: responder.live.status,
          answer: responder.live.answer,
          error: responder.live.error,
        }
      : null
  ), [responder.live]);

  // Paint the quoted spans with the same highlight registry (and therefore the
  // same cyan tint) the chat transcript uses for annotated spans.
  useEffect(() => {
    if (!host || !supportsHighlightApi()) return;
    const index = buildNormalizedTextIndex(host);
    const ranges: Range[] = [];
    for (const exchange of exchanges) {
      const range = findQuoteRangeInIndex(index, exchange.quote, exchange.quote_start);
      if (range) ranges.push(range);
    }
    try {
      if (ranges.length === 0) CSS.highlights.delete(ANNOTATION_HIGHLIGHT_NAME);
      else CSS.highlights.set(ANNOTATION_HIGHLIGHT_NAME, new Highlight(...ranges));
    } catch {
      // Highlighting is decorative — never let it break the article.
    }
    return () => {
      try {
        CSS.highlights.delete(ANNOTATION_HIGHLIGHT_NAME);
      } catch {
        // Nothing to clean up.
      }
    };
  }, [host, exchanges, anchors]);

  // --- Render -------------------------------------------------------------
  if (loading) {
    return (
      <div className="h-full w-full overflow-y-auto bg-bg">
        <div className="mx-auto max-w-3xl px-6 py-10 text-sm text-fg-2">Loading article…</div>
      </div>
    );
  }

  if (loadError || !article) {
    return (
      <div className="h-full w-full overflow-y-auto bg-bg">
        <div className="mx-auto max-w-3xl p-8">
          <Link
            to={`/map/${mapId}`}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-2 no-underline hover:text-accent"
          >
            <ArrowLeft size={13} /> Map
          </Link>
          <div
            role="alert"
            className="mt-6 p-4 rounded-lg border border-line bg-[rgb(var(--color-rose-rgb)/0.1)] text-sm text-rose-300"
          >
            {loadError ?? 'This article could not be loaded.'}
          </div>
        </div>
      </div>
    );
  }

  const unlocated = anchors.unlocated
    .map((id) => exchangeById.get(id))
    .filter((exchange): exchange is KmExchange => exchange !== undefined);

  const creatingAsk = responder.live && responder.live.exchangeId === null
    ? responder.live
    : null;

  // While the article is being written there is no stored body to render, so
  // the page renders the text as it arrives. The moment it is saved this falls
  // back to storage — one source of truth, as with an answered exchange.
  const unwritten = article.content_md.trim() === '';
  const writing = unwritten ? writer.live : null;
  const body = writing ? writing.text : article.content_md;

  return (
    <div className="h-full w-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-3xl p-8">
        <Link
          to={`/map/${mapId}`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-2 no-underline transition-colors hover:text-accent"
        >
          <ArrowLeft size={13} />
          {map?.name ?? 'Map'}
        </Link>

        <header className="mt-4">
          <NodeTypeLabel nodeType={article.node_type} />
        </header>

        {notice && (
          <div
            data-testid="km-article-notice"
            className="mt-4 flex items-start gap-2 p-4 rounded-lg border border-line bg-[rgb(var(--color-amber-rgb)/0.1)] text-sm leading-relaxed text-amber-400"
          >
            <span className="flex-1">{notice}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={dismissNotice}
              className="text-fg-3 hover:text-fg"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {creatingAsk && (
          <div
            data-testid="km-article-ask-status"
            className={`mt-4 p-4 rounded-lg border border-line transition-colors duration-150 ${
              creatingAsk.status === 'error'
                ? 'bg-[rgb(var(--color-rose-rgb)/0.1)]'
                : 'bg-accent-soft'
            }`}
          >
            <div
              className={`text-xs font-medium mb-2 ${
                creatingAsk.status === 'error' ? 'text-rose-300' : 'text-accent'
              }`}
            >
              {ASK_STATUS_LABEL[creatingAsk.status]}
            </div>
            <div
              className={`text-sm break-words ${
                creatingAsk.status === 'error' ? 'text-rose-300' : 'text-fg'
              }`}
            >
              {creatingAsk.error ?? creatingAsk.question}
            </div>
          </div>
        )}

        {writing && (
          <div
            data-testid="km-article-write-status"
            className={`mt-4 p-4 rounded-lg border border-line transition-colors duration-150 ${
              writing.status === 'error'
                ? 'bg-[rgb(var(--color-rose-rgb)/0.1)]'
                : 'bg-accent-soft'
            }`}
          >
            <div
              className={`text-xs font-medium mb-2 ${
                writing.status === 'error' ? 'text-rose-300' : 'text-accent'
              }`}
            >
              {WRITE_STATUS_LABEL[writing.status]}
            </div>
            <div
              className={`text-sm break-words ${
                writing.status === 'error' ? 'text-rose-300' : 'text-fg'
              }`}
            >
              {writing.error ?? writing.question}
            </div>
          </div>
        )}

        <article className="mt-3">
          <ArticleMarkdown
            content={body}
            hostRef={setHostElement}
            tooltips={tooltips}
            onLearnMore={handleLearnMore}
            isCreatingArticle={following}
          />
        </article>

        {anchors.slots.map((slot) => createPortal(
          <>
            {slot.exchangeIds.map((id) => {
              const exchange = exchangeById.get(id);
              if (!exchange) return null;
              return (
                <ExchangeCard
                  key={id}
                  question={exchange.question}
                  answerMd={exchange.answer_md}
                  live={liveFor(id)}
                />
              );
            })}
          </>,
          slot.container,
          slot.exchangeIds.join(' '),
        ))}

        <footer className="mt-10 border-t border-line pt-4">
          <Provenance article={article} responderConv={responder.conversationId} />
        </footer>

        {unlocated.length > 0 && (
          <section
            data-testid="km-article-unlocated"
            className="mt-10 border-t border-line pt-5"
          >
            <h2 className="mb-2 text-sm font-medium text-fg">
              Questions whose passage has changed
            </h2>
            <p className="text-[13px] leading-relaxed text-fg-2">
              These were asked about text that is no longer in the article.
            </p>
            <div className="mt-3">
              {unlocated.map((exchange) => (
                <ExchangeCard
                  key={exchange.id}
                  question={exchange.question}
                  answerMd={exchange.answer_md}
                  quote={exchange.quote}
                  live={liveFor(exchange.id)}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      <AnnotationSelectionLayer onAdd={handleAsk} readSelection={readSelection} />
    </div>
  );
}
