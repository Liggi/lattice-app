/**
 * The learning-map canvas: articles as tinted nodes, question/related links as
 * edges, positions frozen the moment a node first appears.
 *
 * Position lifecycle, which is the whole design:
 *   - a node with `pinned_x`/`pinned_y` renders exactly there and is never
 *     considered by the layout again;
 *   - a node with no pin gets one from an ELK pass over only the unpinned
 *     subgraph, translated clear of everything already on screen, and that
 *     position is written back immediately;
 *   - dragging writes back on pointer-up.
 * So the map only ever grows downward into empty space. It does not reshuffle.
 *
 * The poll is a plain 5s `getMapDetail`, paused while a drag is in flight and
 * while a previous refresh is still running.
 */

import '@xyflow/react/dist/style.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type NodeChange,
  type NodeMouseHandler,
  type OnNodeDrag,
  type ReactFlowInstance,
} from '@xyflow/react';
import { ArrowLeft, Loader2, Map as MapIcon } from 'lucide-react';
import { getMapDetail, updateArticle, type KmEdge } from '../../../services/api/km-api';
import { MapNode } from './MapNode';
import {
  LAYOUT_ANIMATION_MS,
  applyLayoutResult,
  easeInOut,
  easedPosition,
  planLayout,
  positionsNeedingPersist,
  positionsOf,
  reconcileNodes,
  roundPosition,
  type MapGraphNode,
  type XY,
} from './map-layout';
import { tintFor } from './node-palette';
import { runElkLayout } from './run-elk-layout';

const POLL_INTERVAL_MS = 5000;

/**
 * Sizes React Flow has actually measured, keyed by node id. Feeding these to
 * ELK is what keeps rows from packing tighter than the cards really are.
 */
function measuredSizesOf(
  nodes: { id: string; measured?: { width?: number; height?: number } }[],
): Record<string, { width: number; height: number }> {
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const node of nodes) {
    const { width, height } = node.measured ?? {};
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      sizes[node.id] = { width, height };
    }
  }
  return sizes;
}

/** Module-level: a fresh object here re-registers node types on every render. */
const NODE_TYPES = { kmNode: MapNode };

/**
 * The line itself is plain and neutral, no arrowhead, no dashed variant, all of
 * it from `defaultEdgeOptions` below.
 *
 * What is set per-edge is the question. An edge here records a move someone
 * made — "I asked this and it took me there" — so the question rides on the
 * line, small and quiet enough to read past. A `related` link has no question
 * and gets no label.
 */
const EDGE_LABEL_MAX = 64;

const EDGE_LABEL_STYLE = { fill: '#a8a29e', fontSize: 11 };
const EDGE_LABEL_BG_STYLE = { fill: '#1c1917', fillOpacity: 0.92 };
const EDGE_LABEL_PADDING: [number, number] = [6, 3];

function toFlowEdge(edge: KmEdge): Edge {
  const base = { id: edge.id, source: edge.from_article_id, target: edge.to_article_id };
  const label = edge.label?.trim();
  if (!label) return base;
  return {
    ...base,
    label: label.length > EDGE_LABEL_MAX ? `${label.slice(0, EDGE_LABEL_MAX - 1)}…` : label,
    labelShowBg: true,
    labelStyle: EDGE_LABEL_STYLE,
    labelBgStyle: EDGE_LABEL_BG_STYLE,
    labelBgPadding: EDGE_LABEL_PADDING,
    labelBgBorderRadius: 4,
  };
}

/** A quiet neutral line — the edge is structure, not decoration. */
const DEFAULT_EDGE_OPTIONS = {
  animated: false,
  style: { stroke: '#78716c', strokeWidth: 2 },
};

export interface MapCanvasProps {
  mapId: string;
  /**
   * Embedded in the split workspace: the shell owns the header and the article
   * pane, so the canvas drops its own chrome and opens articles on a single
   * click (there is no navigation away to guard against).
   */
  embedded?: boolean;
  /** Article currently open beside the map — rendered with the selected halo. */
  selectedArticleId?: string | null;
  /** Overrides the default navigate-to-article behaviour when embedded. */
  onOpenArticle?: (articleId: string) => void;
}

export function MapCanvas({
  mapId,
  embedded = false,
  selectedArticleId = null,
  onOpenArticle,
}: MapCanvasProps): JSX.Element {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<MapGraphNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [mapName, setMapName] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Written synchronously alongside setNodes: the async refresh needs the
  // current node list, not the one captured when its closure was created.
  const nodesRef = useRef<MapGraphNode[]>([]);
  const draggingRef = useRef<string | null>(null);
  const refreshingRef = useRef(false);
  const unmountedRef = useRef(false);
  const instanceRef = useRef<ReactFlowInstance<MapGraphNode, Edge> | null>(null);
  const fittedRef = useRef(false);
  const animationRef = useRef<number | null>(null);

  const commitNodes = useCallback((next: MapGraphNode[]) => {
    nodesRef.current = next;
    setNodes(next);
  }, []);

  /**
   * Commit a node list, easing any node that moved from where it currently sits
   * to where it now belongs — the original's 500ms smoothstep glide, so a
   * re-laid-out map slides rather than snapping.
   *
   * `nodesRef` is set to the *final* list immediately while only the rendered
   * state is interpolated, so a poll or a position write that lands mid-glide
   * still sees the settled position and can never pin a node to a frame of the
   * animation.
   */
  const commitNodesEased = useCallback(
    (next: MapGraphNode[]) => {
      const from = positionsOf(nodesRef.current);
      const moving = next.some((node) => {
        const start = from[node.id];
        return start && (start.x !== node.position.x || start.y !== node.position.y);
      });
      if (!moving) {
        commitNodes(next);
        return;
      }

      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      nodesRef.current = next;

      const startedAt = performance.now();
      const step = (): void => {
        const t = Math.min((performance.now() - startedAt) / LAYOUT_ANIMATION_MS, 1);
        if (t >= 1) {
          animationRef.current = null;
          setNodes(next);
          return;
        }
        const eased = easeInOut(t);
        setNodes(
          next.map((node) => {
            const start = from[node.id];
            if (!start) return node;
            return { ...node, position: easedPosition(start, node.position, eased) };
          }),
        );
        animationRef.current = requestAnimationFrame(step);
      };
      animationRef.current = requestAnimationFrame(step);
    },
    [commitNodes],
  );

  const persistPosition = useCallback(async (id: string, position: XY): Promise<void> => {
    const { x, y } = roundPosition(position);
    try {
      await updateArticle(id, { pinned_x: x, pinned_y: y });
    } catch (writeError) {
      console.warn('learning map: failed to pin node', id, writeError);
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current || draggingRef.current) return;
    refreshingRef.current = true;
    try {
      const detail = await getMapDetail(mapId);
      if (unmountedRef.current) return;
      setMapName(detail.map.name);

      // Anything already on screen counts as placed, so ELK only ever sees
      // articles this client has never positioned.
      const plan = planLayout(
        detail.articles,
        detail.edges,
        positionsOf(nodesRef.current),
        measuredSizesOf(instanceRef.current?.getNodes() ?? []),
      );
      let positions = plan.fixed;
      if (plan.needsLayout) {
        try {
          positions = applyLayoutResult(plan, await runElkLayout(plan.graph));
        } catch (layoutError) {
          // Parked positions from reconcileNodes still get persisted below, so
          // a failed layout costs tidiness, not stability.
          console.warn('learning map: ELK layout failed', layoutError);
        }
      }
      if (unmountedRef.current) return;

      const { nodes: nextNodes } = reconcileNodes(nodesRef.current, detail.articles, {
        draggingNodeId: draggingRef.current,
        positions,
      });
      commitNodesEased(nextNodes);
      setEdges(detail.edges.map(toFlowEdge));
      setLoaded(true);
      setError(null);

      for (const write of positionsNeedingPersist(nextNodes, detail.articles)) {
        await persistPosition(write.id, { x: write.x, y: write.y });
      }
    } catch (loadError) {
      if (!unmountedRef.current) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      refreshingRef.current = false;
    }
  }, [mapId, commitNodesEased, persistPosition]);

  useEffect(() => {
    unmountedRef.current = false;
    fittedRef.current = false;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      unmountedRef.current = true;
      clearInterval(timer);
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    };
  }, [refresh]);

  // Opening a different article is the one moment a node may have appeared
  // since the last tick — following a question creates it and navigates in the
  // same breath. Refresh now rather than leaving it up to five seconds off the
  // map it was just added to.
  useEffect(() => {
    if (!selectedArticleId) return;
    void refresh();
  }, [selectedArticleId, refresh]);

  // Frame the map once, after the first batch of nodes has real positions.
  useEffect(() => {
    if (fittedRef.current || nodes.length === 0 || !instanceRef.current) return;
    fittedRef.current = true;
    void instanceRef.current.fitView({ padding: 0.25, maxZoom: 1, duration: 200 });
  }, [nodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange<MapGraphNode>[]) => {
      commitNodes(applyNodeChanges(changes, nodesRef.current));
    },
    [commitNodes],
  );

  const onNodeDragStart = useCallback<OnNodeDrag<MapGraphNode>>((_event, node) => {
    draggingRef.current = node.id;
  }, []);

  const onNodeDragStop = useCallback<OnNodeDrag<MapGraphNode>>(
    (_event, node) => {
      draggingRef.current = null;
      void persistPosition(node.id, node.position);
    },
    [persistPosition],
  );

  const openArticle = useCallback(
    (articleId: string) => {
      if (onOpenArticle) onOpenArticle(articleId);
      else void navigate(`/map/${encodeURIComponent(mapId)}/article/${encodeURIComponent(articleId)}`);
    },
    [onOpenArticle, navigate, mapId],
  );

  const onNodeDoubleClick = useCallback<NodeMouseHandler<MapGraphNode>>(
    (_event, node) => { openArticle(node.id); },
    [openArticle],
  );

  // Beside the article pane a single click is the natural open gesture; on the
  // standalone canvas it would fight with click-to-select, so it stays a
  // double-click there.
  const onNodeClick = useCallback<NodeMouseHandler<MapGraphNode>>(
    (_event, node) => { if (embedded) openArticle(node.id); },
    [embedded, openArticle],
  );

  const renderedNodes = useMemo(
    () => (selectedArticleId === null
      ? nodes
      : nodes.map((node) => (
        node.selected === (node.id === selectedArticleId)
          ? node
          : { ...node, selected: node.id === selectedArticleId }
      ))),
    [nodes, selectedArticleId],
  );

  return (
    <div className={`flex ${embedded ? 'h-full bg-bg-2' : 'h-dvh bg-bg'} flex-col text-fg`}>
      {embedded ? null : (
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4">
        <Link
          to="/map"
          aria-label="Back to maps"
          className="rounded-sm p-1.5 text-fg-3 no-underline hover:bg-surface-2 hover:text-fg"
        >
          <ArrowLeft size={16} />
        </Link>
        <MapIcon size={16} className="text-fg-3" />
        <h1 className="text-base font-medium text-fg">{mapName ?? 'Learning map'}</h1>
        <span className="text-xs tabular-nums text-fg-3">
          {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'} · {edges.length}{' '}
          {edges.length === 1 ? 'link' : 'links'}
        </span>
        <span className="ml-auto text-xs text-fg-3">
          Drag to pin · double-click to open
        </span>
      </header>
      )}

      {error ? (
        <p className="mx-4 mt-3 rounded-md border border-line bg-[rgb(var(--color-rose-rgb)/0.1)] px-3 py-2 text-sm text-rose-300">
          {error}
        </p>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {!loaded && !error ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-fg-2">
            <Loader2 size={15} className="animate-spin text-accent" /> Loading map
          </div>
        ) : null}

        {loaded && nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
            <p className="text-sm text-fg-2">This map has no nodes yet.</p>
            <p className="text-[13px] text-fg-3">
              A session draws here by posting to <code className="font-mono">/api/km</code>. New
              nodes appear within a few seconds.
            </p>
          </div>
        ) : null}

        {loaded && nodes.length > 0 ? (
          <ReactFlow<MapGraphNode, Edge>
            nodes={renderedNodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onNodeDoubleClick={onNodeDoubleClick}
            onNodeClick={onNodeClick}
            onInit={(instance) => {
              instanceRef.current = instance;
            }}
            colorMode="dark"
            // React Flow paints its own pane colour over the wrapper, so the
            // embedded canvas surface has to be set here, not on the parent.
            style={embedded ? { backgroundColor: '#201d1b' } : undefined}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
            minZoom={0.1}
            maxZoom={2}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            deleteKeyCode={null}
          >
            <Background color="#44403c" gap={24} size={1} />
            {/* The original canvas carries neither; beside the article pane they
                just crowd the map, so they only appear on the standalone view. */}
            {embedded ? null : <Controls showInteractive={false} position="bottom-left" />}
            {embedded ? null : (
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              maskColor="rgba(28, 25, 23, 0.72)"
              style={{
                background: 'rgba(38, 35, 34, 0.9)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: 6,
                height: 92,
                width: 148,
              }}
              nodeColor={(node) => `rgba(${tintFor(String(node.data.nodeType)).rgb}, 0.55)`}
              nodeStrokeWidth={0}
            />
            )}
          </ReactFlow>
        ) : null}
      </div>
    </div>
  );
}
