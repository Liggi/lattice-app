/**
 * Pure layout and reconciliation logic for the learning-map canvas.
 *
 * The stability rule this file exists to enforce: **a node that has a position
 * never moves on its own again.** A map that reshuffles when a new node arrives
 * is unreadable, so ELK is only ever allowed to place nodes that have never had
 * a position — never to revise one that already exists.
 *
 * That is why the layout runs over a *subgraph*. ELK's "interactive" mode
 * (`elk.layered.*.strategy: INTERACTIVE` plus seeded coordinates) treats
 * existing positions as a hint about ordering, not as a constraint, so it can
 * and does move seeded nodes. Instead we hand ELK only the free nodes and the
 * edges between them, then translate the whole result into empty space below
 * the already-placed bounding box. Placed nodes are then untouched by
 * construction rather than by trusting a layout option.
 *
 * No React, no elkjs, no DOM here — the whole file is testable as plain data
 * (test/unit/km-map-layout.test.ts).
 */

import type { KmArticleSummary, KmEdge, KmNodeType } from '../../../services/api/km-api';

export interface XY {
  x: number;
  y: number;
}

/**
 * Node box size, matching the rendered pane in MapNode.tsx.
 *
 * The node is auto-height (it wraps its title), so the width is exact and the
 * height is a typical-case estimate — the original's `p-4` padding, a 16px type
 * word with its 8px gap, and two 20px lines of title. It is only ever used to
 * size ELK's boxes and to keep freshly placed blocks clear of existing ones,
 * both of which want a slight over-estimate rather than an exact fit.
 */
export const NODE_WIDTH = 350;
export const NODE_HEIGHT = 150;

/**
 * Layout movement is animated, as in the original: a node eases from its old
 * position to its new one over half a second rather than snapping there.
 */
export const LAYOUT_ANIMATION_MS = 500;

/** Smoothstep, the original's easing curve. */
export function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

/** A node's position part-way through an eased move from `from` to `to`. */
export function easedPosition(from: XY, to: XY, eased: number): XY {
  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
  };
}

/** Vertical gap between the already-placed block and a freshly laid-out block. */
export const LAYOUT_GAP = 96;

export interface MapNodeData extends Record<string, unknown> {
  title: string;
  /** What the node actually reads as; falls back to the title when absent. */
  summary: string | null;
  takeaways: string[];
  nodeType: KmNodeType;
  createdFrom: string | null;
  createdByConv: string | null;
  /**
   * The node exists but its article has not been written yet — the state a
   * node is in between following a question here and the answer arriving. The
   * node has to be on the map for that whole stretch, so it says so.
   */
  pending: boolean;
}

/**
 * Structurally compatible with React Flow's `Node<MapNodeData, 'kmNode'>`, but
 * declared locally so this module stays free of the canvas library.
 */
export interface MapGraphNode {
  id: string;
  type: 'kmNode';
  position: XY;
  data: MapNodeData;
  /**
   * React Flow's selection flag. The workspace drives it from the URL so the
   * node whose article is open beside the map wears the selected halo.
   */
  selected?: boolean;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** ELK input shapes, kept local so tests never load elkjs. */
export interface LayoutGraphNode {
  id: string;
  width: number;
  height: number;
}

export interface LayoutGraphEdge {
  id: string;
  sources: string[];
  targets: string[];
}

export interface LayoutGraph {
  id: string;
  layoutOptions: Record<string, string>;
  children: LayoutGraphNode[];
  edges: LayoutGraphEdge[];
}

export const ELK_LAYERED_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '140',
  'elk.spacing.nodeNode': '96',
  'elk.layered.spacing.edgeNodeBetweenLayers': '32',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
};

/** An article carries a usable pin only when both coordinates are present. */
export function pinOf(article: Pick<KmArticleSummary, 'pinned_x' | 'pinned_y'>): XY | null {
  const { pinned_x: x, pinned_y: y } = article;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Server-side pins, keyed by article id. Articles without both pins are absent. */
export function pinnedPositions(
  articles: Pick<KmArticleSummary, 'id' | 'pinned_x' | 'pinned_y'>[],
): Record<string, XY> {
  const pins: Record<string, XY> = {};
  for (const article of articles) {
    const pin = pinOf(article);
    if (pin) pins[article.id] = pin;
  }
  return pins;
}

/** Bounding box of a set of top-left node positions, including the node box. */
export function boundsOfPositions(
  positions: XY[],
  width = NODE_WIDTH,
  height = NODE_HEIGHT,
): Bounds | null {
  if (positions.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of positions) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + width > maxX) maxX = x + width;
    if (y + height > maxY) maxY = y + height;
  }
  return { minX, minY, maxX, maxY };
}

export interface LayoutPlan {
  /** Nodes whose position is already settled. ELK never sees these. */
  fixed: Record<string, XY>;
  /** Ids handed to ELK, in graph order. */
  freeIds: string[];
  /** The ELK graph for the free subgraph. Empty children means nothing to do. */
  graph: LayoutGraph;
  needsLayout: boolean;
}

/**
 * Decide what ELK is allowed to touch.
 *
 * A node is fixed if we already have it on screen (`knownPositions`, which the
 * canvas fills from its live node state) or if the server has pinned it.
 * On-screen position wins, because a position we rendered may not have been
 * persisted yet and a poll must not be able to yank it backwards.
 */
export function planLayout(
  articles: KmArticleSummary[],
  edges: KmEdge[],
  knownPositions: Record<string, XY> = {},
  /**
   * Rendered node sizes, once React Flow has measured them. Nodes are
   * auto-height — a card with a long summary and bullets runs to ~210px against
   * a 150px estimate — so a layout built on the estimate packs rows too tightly.
   * Anything not yet measured falls back to the estimate.
   */
  measuredSizes: Record<string, { width: number; height: number }> = {},
): LayoutPlan {
  const pins = pinnedPositions(articles);
  const fixed: Record<string, XY> = {};
  const freeIds: string[] = [];

  for (const article of articles) {
    const known = knownPositions[article.id] ?? pins[article.id];
    if (known) fixed[article.id] = known;
    else freeIds.push(article.id);
  }

  const free = new Set(freeIds);
  const graph: LayoutGraph = {
    id: 'root',
    layoutOptions: ELK_LAYERED_OPTIONS,
    children: freeIds.map((id) => ({
      id,
      width: measuredSizes[id]?.width ?? NODE_WIDTH,
      height: measuredSizes[id]?.height ?? NODE_HEIGHT,
    })),
    // Only edges wholly inside the free subgraph: an edge to a fixed node cannot
    // inform a layout that is not allowed to move the fixed node anyway.
    edges: edges
      .filter((edge) => free.has(edge.from_article_id) && free.has(edge.to_article_id))
      .map((edge) => ({
        id: edge.id,
        sources: [edge.from_article_id],
        targets: [edge.to_article_id],
      })),
  };

  return { fixed, freeIds, graph, needsLayout: freeIds.length > 0 };
}

/**
 * Translate an ELK result into free space: left-aligned with the existing
 * block and below it. With nothing placed yet, normalise to the origin instead.
 *
 * Rounds to whole pixels here, at the one point where ELK output enters the
 * app, so the position a node renders at is byte-identical to the one written
 * to `pinned_x`/`pinned_y`. ELK returns fractional coordinates (a centred node
 * comes back at x=34.667); without this the node would shift by a fraction of
 * a pixel on the next reload, which is exactly the churn this file exists to
 * prevent.
 */
export function placeLaidOutBlock(
  laidOut: Record<string, XY>,
  anchor: Bounds | null,
  gap = LAYOUT_GAP,
): Record<string, XY> {
  const values = Object.values(laidOut);
  if (values.length === 0) return {};
  const block = boundsOfPositions(values);
  /* c8 ignore next */
  if (!block) return {};

  const targetX = anchor ? anchor.minX : 0;
  const targetY = anchor ? anchor.maxY + gap : 0;
  const dx = targetX - block.minX;
  const dy = targetY - block.minY;

  const placed: Record<string, XY> = {};
  for (const [id, position] of Object.entries(laidOut)) {
    placed[id] = roundPosition({ x: position.x + dx, y: position.y + dy });
  }
  return placed;
}

/**
 * Combine a plan with its ELK output. Fixed positions pass through byte-for-byte;
 * laid-out positions are translated clear of them.
 */
export function applyLayoutResult(
  plan: LayoutPlan,
  laidOut: Record<string, XY>,
  gap = LAYOUT_GAP,
): Record<string, XY> {
  const anchor = boundsOfPositions(Object.values(plan.fixed));
  return { ...plan.fixed, ...placeLaidOutBlock(laidOut, anchor, gap) };
}

/** Round to whole pixels before persisting; sub-pixel drag noise is not signal. */
export function roundPosition(position: XY): XY {
  return { x: Math.round(position.x), y: Math.round(position.y) };
}

/**
 * Which nodes owe the server a pin.
 *
 * The rule is deliberately "the article has no pin at all" rather than "its
 * position differs from its pin". Whatever position a node first renders at —
 * ELK's answer, or the parked fallback if ELK failed — is written back
 * immediately, so every node becomes pinned on its first appearance and is
 * never a candidate for layout again. Positions that change later come from
 * dragging, which persists on its own.
 */
export function positionsNeedingPersist(
  nodes: MapGraphNode[],
  articles: Pick<KmArticleSummary, 'id' | 'pinned_x' | 'pinned_y'>[],
): { id: string; x: number; y: number }[] {
  const unpinned = new Set(
    articles.filter((article) => pinOf(article) === null).map((article) => article.id),
  );
  return nodes
    .filter((node) => unpinned.has(node.id))
    .map((node) => ({ id: node.id, ...roundPosition(node.position) }));
}

export interface ReconcileOptions {
  /** The node currently under the pointer. Its data and position are frozen. */
  draggingNodeId?: string | null;
  /** Freshly computed layout positions, for articles not yet on screen. */
  positions?: Record<string, XY>;
}

export interface ReconcileResult {
  nodes: MapGraphNode[];
  /** Articles that arrived with no position anywhere — a layout pass is owed. */
  unplacedIds: string[];
  /** True when the node list changed in a way React needs to see. */
  changed: boolean;
}

function sameData(a: MapNodeData, b: MapNodeData): boolean {
  return (
    a.title === b.title &&
    a.nodeType === b.nodeType &&
    a.createdFrom === b.createdFrom &&
    a.createdByConv === b.createdByConv &&
    a.pending === b.pending
  );
}

/**
 * Fold a freshly polled article list into the nodes already on screen.
 *
 * Position precedence:
 *   1. the position already on screen — always, including mid-drag;
 *   2. a freshly computed layout position from `options.positions`;
 *   3. the server pin, for an article we have never rendered;
 *   4. nothing: the node is parked below the existing block and reported as
 *      unplaced, so a node is never invisible even if ELK failed.
 *
 * On-screen beats server-pin deliberately. This client is the only thing that
 * moves nodes interactively, and it writes back what it shows, so a poll that
 * races an unfinished PATCH must not be able to snap a node backwards. The cost
 * is that a position changed by someone else server-side only appears on reload.
 *
 * Node objects are reused unchanged wherever nothing about them differs, so
 * React Flow does not re-render a node just because a poll ticked.
 */
export function reconcileNodes(
  previous: MapGraphNode[],
  articles: KmArticleSummary[],
  options: ReconcileOptions = {},
): ReconcileResult {
  const draggingNodeId = options.draggingNodeId ?? null;
  const laidOut = options.positions ?? {};
  const byId = new Map(previous.map((node) => [node.id, node]));
  const pins = pinnedPositions(articles);

  const settled: XY[] = [];
  for (const article of articles) {
    const position = byId.get(article.id)?.position ?? laidOut[article.id] ?? pins[article.id];
    if (position) settled.push(position);
  }
  const anchor = boundsOfPositions(settled);
  let parkX = anchor ? anchor.minX : 0;
  const parkY = anchor ? anchor.maxY + LAYOUT_GAP : 0;

  const nodes: MapGraphNode[] = [];
  const unplacedIds: string[] = [];
  let changed = previous.length !== articles.length;

  for (const article of articles) {
    const existing = byId.get(article.id);

    if (existing && article.id === draggingNodeId) {
      // Mid-drag: React Flow owns this node's position and we own nothing about
      // it until the pointer comes up. Pass the exact object through.
      nodes.push(existing);
      continue;
    }

    const data: MapNodeData = {
      title: article.title,
      summary: article.summary ?? null,
      takeaways: article.takeaways ?? [],
      nodeType: article.node_type,
      createdFrom: article.created_from,
      createdByConv: article.created_by_conv,
      pending: article.has_content === false,
    };

    let position = existing?.position ?? laidOut[article.id] ?? pins[article.id];
    if (!position) {
      position = { x: parkX, y: parkY };
      parkX += NODE_WIDTH + 40;
      unplacedIds.push(article.id);
    }

    if (existing && existing.position === position && sameData(existing.data, data)) {
      nodes.push(existing);
      continue;
    }

    changed = true;
    // Spread the old node so canvas-owned flags the library hangs on it
    // (selected, measured, dragging) survive a title or type change.
    nodes.push({ ...existing, id: article.id, type: 'kmNode', position, data });
  }

  return { nodes, unplacedIds, changed };
}

/** Current on-screen positions, in the shape `planLayout` wants. */
export function positionsOf(nodes: MapGraphNode[]): Record<string, XY> {
  const positions: Record<string, XY> = {};
  for (const node of nodes) positions[node.id] = node.position;
  return positions;
}
