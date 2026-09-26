/**
 * The map workspace: one screen, map on the left and the open article on the
 * right, with a chevron on the divider that flips which side gets two thirds.
 * This is the original learning app's `learning-interface` layout — the map
 * stays visible while you read, and clicking a node swaps the article beside
 * it rather than navigating away from the map.
 *
 * Both `/map/:mapId` and `/map/:mapId/article/:articleId` render this; the
 * article pane is empty on the first until a node is picked.
 *
 * What it remembers, per map, so switching in and out of a map returns you
 * where you were: which article was open, and which side is expanded.
 * The session you arrived from rides in `?from=conv-…` so the header can send
 * you back to that exact conversation.
 */

import { useCallback, useEffect } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react';
import { MapCanvas } from './map/MapCanvas';
import { ArticlePage } from './ArticlePage';
import { useMapView, writeMapView } from './map-view-memory';

export function MapWorkspace(): JSX.Element {
  const { mapId = '', articleId } = useParams<{ mapId: string; articleId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const fromConversation = searchParams.get('from');
  const suffix = fromConversation ? `?from=${encodeURIComponent(fromConversation)}` : '';

  const remembered = useMapView(mapId);
  const isMapExpanded = remembered.mapExpanded;

  // Landing on the bare map URL reopens the article you were last reading in
  // it. Replace, not push, so Back still leaves the map.
  useEffect(() => {
    if (articleId || !mapId || !remembered.articleId) return;
    navigate(
      `/map/${encodeURIComponent(mapId)}/article/${encodeURIComponent(remembered.articleId)}${suffix}`,
      { replace: true },
    );
  }, [articleId, mapId, remembered.articleId, suffix, navigate]);

  useEffect(() => {
    if (mapId && articleId) writeMapView(mapId, { articleId });
  }, [mapId, articleId]);

  const toggleLayout = useCallback(() => {
    writeMapView(mapId, { mapExpanded: !isMapExpanded });
  }, [mapId, isMapExpanded]);

  const openArticle = useCallback(
    (nextArticleId: string) => {
      navigate(
        `/map/${encodeURIComponent(mapId)}/article/${encodeURIComponent(nextArticleId)}${suffix}`,
      );
    },
    [navigate, mapId, suffix],
  );

  if (!mapId) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg">
        <p className="text-sm text-fg-2">No map id in the URL.</p>
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-full flex-col bg-bg">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4">
        <Link
          to="/map"
          aria-label="All maps"
          className="text-fg-3 no-underline transition-colors hover:text-fg"
        >
          <ArrowLeft size={16} />
        </Link>
        {fromConversation ? (
          <Link
            to={`/c/${fromConversation}`}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-2 no-underline transition-colors hover:text-accent"
          >
            <MessageSquare size={13} /> Back to session
          </Link>
        ) : null}
      </header>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          className={`${isMapExpanded ? 'w-2/3' : 'w-1/3'} border-r border-line bg-bg-2 transition-all duration-300`}
        >
          <div className="h-full">
            <MapCanvas
              mapId={mapId}
              embedded
              selectedArticleId={articleId ?? null}
              onOpenArticle={openArticle}
            />
          </div>
        </div>

        <div
          className={`absolute top-1/2 z-10 -translate-y-1/2 transition-all duration-300 ${
            isMapExpanded ? 'left-2/3 -ml-3' : 'left-1/3 -ml-3'
          }`}
        >
          <button
            type="button"
            onClick={toggleLayout}
            className="rounded-full border border-line bg-surface p-1.5 hover:bg-surface-2"
            aria-label={isMapExpanded ? 'Expand content' : 'Expand map'}
          >
            {isMapExpanded ? (
              <ChevronLeft size={16} className="text-fg-2" />
            ) : (
              <ChevronRight size={16} className="text-fg-2" />
            )}
          </button>
        </div>

        <div
          className={`${isMapExpanded ? 'w-1/3' : 'w-2/3'} flex min-h-0 flex-1 flex-col overflow-hidden bg-bg transition-all duration-300`}
        >
          {articleId ? (
            <ArticlePage key={articleId} onOpenArticle={openArticle} />
          ) : (
            <div className="flex h-full items-center justify-center px-8 text-center">
              <p className="text-sm leading-relaxed text-fg-2">
                Select an article on the map to read it.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
