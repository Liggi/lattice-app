/**
 * Learning-map layout and reconciliation.
 *
 * The invariant under test is stability: once a node has a position, nothing
 * except a deliberate drag may move it. Everything here is plain data — no DOM,
 * no elkjs, no React Flow.
 */

import { describe, it, expect } from 'vitest';
import type {
  KmArticleSummary,
  KmEdge,
} from '../../src/web/chat/services/api/km-api';
import { runElkLayout } from '../../src/web/chat/components/LearningMap/map/run-elk-layout';
import {
  ELK_LAYERED_OPTIONS,
  LAYOUT_ANIMATION_MS,
  LAYOUT_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  applyLayoutResult,
  boundsOfPositions,
  easeInOut,
  easedPosition,
  pinOf,
  pinnedPositions,
  placeLaidOutBlock,
  planLayout,
  positionsNeedingPersist,
  positionsOf,
  reconcileNodes,
  roundPosition,
  type MapGraphNode,
  type XY,
} from '../../src/web/chat/components/LearningMap/map/map-layout';

function article(
  id: string,
  overrides: Partial<KmArticleSummary> = {},
): KmArticleSummary {
  return {
    id,
    map_id: 'map-1',
    title: `Title ${id}`,
    node_type: 'article',
    created_from: null,
    created_by_conv: null,
    has_content: true,
    pinned_x: null,
    pinned_y: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function pinned(id: string, x: number, y: number): KmArticleSummary {
  return article(id, { pinned_x: x, pinned_y: y });
}

function edge(id: string, from: string, to: string, kind: KmEdge['kind'] = 'follow'): KmEdge {
  return {
    id,
    map_id: 'map-1',
    from_article_id: from,
    to_article_id: to,
    kind,
    label: null,
    created_at: 1,
  };
}

function node(id: string, x: number, y: number, title = `Title ${id}`): MapGraphNode {
  return {
    id,
    type: 'kmNode',
    position: { x, y },
    data: {
      title, nodeType: 'article', createdFrom: null, createdByConv: null,
      summary: null, takeaways: [], pending: false,
    },
  };
}

describe('pin reading', () => {
  it('needs both coordinates to count as a pin', () => {
    expect(pinOf(pinned('a', 10, 20))).toEqual({ x: 10, y: 20 });
    expect(pinOf(article('a'))).toBeNull();
    expect(pinOf(article('a', { pinned_x: 10 }))).toBeNull();
    expect(pinOf(article('a', { pinned_y: 20 }))).toBeNull();
  });

  it('rejects non-finite pins rather than rendering a node at NaN', () => {
    expect(pinOf(article('a', { pinned_x: Number.NaN, pinned_y: 3 }))).toBeNull();
    expect(pinOf(article('a', { pinned_x: 0, pinned_y: Infinity }))).toBeNull();
  });

  it('keeps a pin at zero, which is a real position', () => {
    expect(pinOf(pinned('a', 0, 0))).toEqual({ x: 0, y: 0 });
    expect(pinnedPositions([pinned('a', 0, 0), article('b')])).toEqual({ a: { x: 0, y: 0 } });
  });
});

describe('boundsOfPositions', () => {
  it('returns null for an empty set', () => {
    expect(boundsOfPositions([])).toBeNull();
  });

  it('includes the node box, not just the top-left points', () => {
    expect(boundsOfPositions([{ x: 10, y: 20 }])).toEqual({
      minX: 10,
      minY: 20,
      maxX: 10 + NODE_WIDTH,
      maxY: 20 + NODE_HEIGHT,
    });
  });

  it('spans every point', () => {
    const bounds = boundsOfPositions([
      { x: 0, y: 0 },
      { x: 500, y: 300 },
      { x: -40, y: 100 },
    ]);
    expect(bounds).toEqual({
      minX: -40,
      minY: 0,
      maxX: 500 + NODE_WIDTH,
      maxY: 300 + NODE_HEIGHT,
    });
  });
});

describe('planLayout', () => {
  it('gives ELK nothing when every article is pinned', () => {
    const plan = planLayout([pinned('a', 0, 0), pinned('b', 300, 0)], [edge('e1', 'a', 'b')]);
    expect(plan.needsLayout).toBe(false);
    expect(plan.freeIds).toEqual([]);
    expect(plan.graph.children).toEqual([]);
    expect(plan.fixed).toEqual({ a: { x: 0, y: 0 }, b: { x: 300, y: 0 } });
  });

  it('hands ELK only the unpinned articles', () => {
    const plan = planLayout(
      [pinned('a', 0, 0), article('b'), article('c')],
      [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
    );
    expect(plan.needsLayout).toBe(true);
    expect(plan.freeIds).toEqual(['b', 'c']);
    expect(plan.graph.children.map((child) => child.id)).toEqual(['b', 'c']);
    expect(plan.graph.children[0]).toEqual({ id: 'b', width: NODE_WIDTH, height: NODE_HEIGHT });
    expect(Object.keys(plan.fixed)).toEqual(['a']);
  });

  it('drops edges that touch a fixed node, keeping only the free subgraph', () => {
    const plan = planLayout(
      [pinned('a', 0, 0), article('b'), article('c')],
      [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'a')],
    );
    expect(plan.graph.edges).toEqual([{ id: 'e2', sources: ['b'], targets: ['c'] }]);
  });

  it('treats an on-screen position as fixed even when the server has no pin', () => {
    // The window between a node first rendering and its PATCH landing: a second
    // layout pass must not get to place it a second time.
    const plan = planLayout([article('a'), article('b')], [], { a: { x: 12, y: 34 } });
    expect(plan.freeIds).toEqual(['b']);
    expect(plan.fixed).toEqual({ a: { x: 12, y: 34 } });
  });

  it('prefers the on-screen position over a stale server pin', () => {
    const plan = planLayout([pinned('a', 0, 0)], [], { a: { x: 900, y: 900 } });
    expect(plan.fixed).toEqual({ a: { x: 900, y: 900 } });
  });

  it('uses the layered algorithm', () => {
    const plan = planLayout([article('a')], []);
    expect(plan.graph.layoutOptions).toBe(ELK_LAYERED_OPTIONS);
    expect(ELK_LAYERED_OPTIONS['elk.algorithm']).toBe('layered');
  });
});

describe('placeLaidOutBlock', () => {
  it('normalises to the origin when nothing is placed yet', () => {
    const placed = placeLaidOutBlock({ a: { x: 40, y: 90 }, b: { x: 140, y: 190 } }, null);
    expect(placed).toEqual({ a: { x: 0, y: 0 }, b: { x: 100, y: 100 } });
  });

  it('drops the block below the existing bounding box, left-aligned with it', () => {
    const anchor = boundsOfPositions([{ x: 50, y: 50 }]);
    const placed = placeLaidOutBlock({ a: { x: 0, y: 0 }, b: { x: 30, y: 60 } }, anchor);
    expect(placed.a).toEqual({ x: 50, y: 50 + NODE_HEIGHT + LAYOUT_GAP });
    // Relative geometry from ELK is preserved exactly; only the block moves.
    expect(placed.b.x - placed.a.x).toBe(30);
    expect(placed.b.y - placed.a.y).toBe(60);
  });

  it('never overlaps the anchor block', () => {
    const anchor = boundsOfPositions([{ x: 0, y: 0 }]);
    const placed = placeLaidOutBlock({ a: { x: 0, y: 0 } }, anchor);
    expect(placed.a.y).toBeGreaterThan(anchor!.maxY);
  });

  it('returns nothing for an empty layout result', () => {
    expect(placeLaidOutBlock({}, null)).toEqual({});
  });

  it('rounds ELK fractions away so the shown position equals the stored one', () => {
    // ELK centres nodes and really does return coordinates like 34.667.
    const placed = placeLaidOutBlock({ a: { x: 34.666666, y: 0 }, b: { x: 0, y: 152.4 } }, null);
    expect(placed).toEqual({ a: { x: 35, y: 0 }, b: { x: 0, y: 152 } });
  });
});

describe('applyLayoutResult — pinned nodes are never moved by a layout', () => {
  it('passes fixed positions through untouched', () => {
    const plan = planLayout([pinned('a', 17, 23), article('b')], []);
    const positions = applyLayoutResult(plan, { b: { x: 0, y: 0 } });
    expect(positions.a).toEqual({ x: 17, y: 23 });
  });

  it('places the new node clear of every pinned node', () => {
    const articles = [pinned('a', 0, 0), pinned('b', 400, 200), article('c')];
    const plan = planLayout(articles, []);
    const positions = applyLayoutResult(plan, { c: { x: 0, y: 0 } });

    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 400, y: 200 });
    const pinnedBounds = boundsOfPositions([positions.a, positions.b])!;
    expect(positions.c.y).toBeGreaterThanOrEqual(pinnedBounds.maxY + LAYOUT_GAP);
  });

  it('is a no-op over an entirely pinned map, however many times it runs', () => {
    const articles = [pinned('a', 5, 5), pinned('b', 300, 90)];
    let positions = pinnedPositions(articles);
    for (let pass = 0; pass < 5; pass += 1) {
      const plan = planLayout(articles, [], positions);
      expect(plan.needsLayout).toBe(false);
      positions = applyLayoutResult(plan, {});
    }
    expect(positions).toEqual({ a: { x: 5, y: 5 }, b: { x: 300, y: 90 } });
  });
});

describe('reconcileNodes', () => {
  it('gives every article a position', () => {
    const { nodes, unplacedIds } = reconcileNodes([], [pinned('a', 10, 10), article('b')], {
      positions: { a: { x: 10, y: 10 }, b: { x: 10, y: 300 } },
    });
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(nodes.map((n) => n.position)).toEqual([
      { x: 10, y: 10 },
      { x: 10, y: 300 },
    ]);
    expect(unplacedIds).toEqual([]);
  });

  it('renders a pinned node exactly at its pin on first sight', () => {
    const { nodes } = reconcileNodes([], [pinned('a', -120, 480)]);
    expect(nodes[0].position).toEqual({ x: -120, y: 480 });
  });

  it('parks an article that has no position anywhere, and reports it', () => {
    const { nodes, unplacedIds } = reconcileNodes([node('a', 0, 0)], [article('a'), article('b')]);
    expect(unplacedIds).toEqual(['b']);
    const parked = nodes.find((n) => n.id === 'b')!;
    // Visible and clear of the placed block rather than stacked at the origin.
    expect(parked.position.y).toBe(NODE_HEIGHT + LAYOUT_GAP);
    expect(nodes.find((n) => n.id === 'a')!.position).toEqual({ x: 0, y: 0 });
  });

  it('parks several unplaced articles side by side instead of on top of each other', () => {
    const { nodes } = reconcileNodes([], [article('a'), article('b'), article('c')]);
    const xs = nodes.map((n) => n.position.x);
    expect(new Set(xs).size).toBe(3);
    expect(nodes.every((n) => n.position.y === nodes[0].position.y)).toBe(true);
  });

  it('a refresh never moves a node that is already on screen', () => {
    const previous = [node('a', 100, 200), node('b', 400, 200)];
    // The server disagrees about where 'a' is, and offers a layout for it too.
    const { nodes } = reconcileNodes(previous, [pinned('a', 0, 0), pinned('b', 400, 200)], {
      positions: { a: { x: 999, y: 999 } },
    });
    expect(nodes.find((n) => n.id === 'a')!.position).toEqual({ x: 100, y: 200 });
    expect(nodes.find((n) => n.id === 'b')!.position).toEqual({ x: 400, y: 200 });
  });

  it('adds new articles without disturbing existing positions', () => {
    const previous = [node('a', 100, 200)];
    const { nodes } = reconcileNodes(previous, [pinned('a', 100, 200), article('b')], {
      positions: { a: { x: 100, y: 200 }, b: { x: 100, y: 600 } },
    });
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toBe(previous[0]);
    expect(nodes[1].position).toEqual({ x: 100, y: 600 });
  });

  it('drops articles that no longer exist', () => {
    const { nodes } = reconcileNodes([node('a', 0, 0), node('b', 0, 100)], [pinned('a', 0, 0)]);
    expect(nodes.map((n) => n.id)).toEqual(['a']);
  });

  it('preserves an in-flight drag: the dragged node is passed through by identity', () => {
    const dragged = node('a', 640, 480);
    const previous = [dragged, node('b', 0, 0)];
    const { nodes } = reconcileNodes(
      previous,
      // The server still has 'a' at its pre-drag pin and a new title for it.
      [pinned('a', 0, 0), article('b', { pinned_x: 0, pinned_y: 0 })],
      { draggingNodeId: 'a', positions: { a: { x: 0, y: 0 } } },
    );
    const after = nodes.find((n) => n.id === 'a')!;
    expect(after).toBe(dragged);
    expect(after.position).toEqual({ x: 640, y: 480 });
  });

  it('does not rewrite the dragged node even when its title changed server-side', () => {
    const dragged = node('a', 50, 50, 'Old title');
    const { nodes } = reconcileNodes(
      [dragged],
      [pinned('a', 0, 0)].map((a) => ({ ...a, title: 'New title' })),
      { draggingNodeId: 'a' },
    );
    expect(nodes[0]).toBe(dragged);
    expect(nodes[0].data.title).toBe('Old title');
  });

  it('reuses node objects when nothing changed, so React Flow does not churn', () => {
    const previous = [node('a', 10, 10), node('b', 10, 200)];
    const articles = [pinned('a', 10, 10), pinned('b', 10, 200)];
    const first = reconcileNodes(previous, articles);
    expect(first.changed).toBe(false);
    expect(first.nodes[0]).toBe(previous[0]);
    expect(first.nodes[1]).toBe(previous[1]);
  });

  it('picks up a renamed or retyped article without moving it', () => {
    const previous = [node('a', 10, 10, 'Old')];
    const { nodes, changed } = reconcileNodes(previous, [
      { ...pinned('a', 999, 999), title: 'New', node_type: 'concept' },
    ]);
    expect(changed).toBe(true);
    expect(nodes[0].data.title).toBe('New');
    expect(nodes[0].data.nodeType).toBe('concept');
    expect(nodes[0].position).toEqual({ x: 10, y: 10 });
  });

  it('keeps canvas-owned flags such as selection across a data change', () => {
    const selected = { ...node('a', 10, 10, 'Old'), selected: true } as MapGraphNode & {
      selected: boolean;
    };
    const { nodes } = reconcileNodes([selected], [{ ...pinned('a', 10, 10), title: 'New' }]);
    expect((nodes[0] as MapGraphNode & { selected?: boolean }).selected).toBe(true);
  });

  it('carries provenance through to node data', () => {
    const { nodes } = reconcileNodes(
      [],
      [
        {
          ...pinned('a', 0, 0),
          created_from: 'drawn while tracing a hang',
          created_by_conv: 'conv-abc',
          node_type: 'code-structure',
        },
      ],
    );
    expect(nodes[0].data).toEqual({
      title: 'Title a',
      summary: null,
      takeaways: [],
      nodeType: 'code-structure',
      createdFrom: 'drawn while tracing a hang',
      createdByConv: 'conv-abc',
      pending: false,
    });
  });
});

describe('positionsNeedingPersist', () => {
  it('writes back every node the server has not pinned yet', () => {
    const nodes = [node('a', 10, 10), node('b', 10.4, 299.6)];
    const writes = positionsNeedingPersist(nodes, [pinned('a', 10, 10), article('b')]);
    expect(writes).toEqual([{ id: 'b', x: 10, y: 300 }]);
  });

  it('stops asking once the server has a pin, so the poll is not a write loop', () => {
    const nodes = [node('a', 10, 10)];
    expect(positionsNeedingPersist(nodes, [pinned('a', 10, 10)])).toEqual([]);
    // Even when the pin disagrees with what is on screen — a drag PATCH still
    // in flight must not be re-sent by the poll.
    expect(positionsNeedingPersist(nodes, [pinned('a', 999, 999)])).toEqual([]);
  });
});

describe('positionsOf / roundPosition', () => {
  it('reads the current on-screen positions into a plan input', () => {
    expect(positionsOf([node('a', 1, 2), node('b', 3, 4)])).toEqual({
      a: { x: 1, y: 2 },
      b: { x: 3, y: 4 },
    });
  });

  it('rounds sub-pixel drag noise away', () => {
    expect(roundPosition({ x: 10.49, y: -3.5 })).toEqual({ x: 10, y: -3 });
  });
});

describe('the full first-load path', () => {
  it('places an unpinned map, then leaves it alone forever', () => {
    const articles = [article('a'), article('b'), article('c')];
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'a', 'c')];

    // Pass 1: nothing pinned, so ELK sees the whole graph.
    const plan1 = planLayout(articles, edges);
    expect(plan1.freeIds).toEqual(['a', 'b', 'c']);
    const elkOutput: Record<string, XY> = {
      a: { x: 100, y: 0 },
      b: { x: 0, y: 150 },
      c: { x: 220, y: 150 },
    };
    const positions1 = applyLayoutResult(plan1, elkOutput);
    const { nodes: nodes1 } = reconcileNodes([], articles, { positions: positions1 });
    const writes = positionsNeedingPersist(nodes1, articles);
    expect(writes.map((w) => w.id).sort()).toEqual(['a', 'b', 'c']);

    // The server now returns what we wrote.
    const persisted = articles.map((a) => {
      const write = writes.find((w) => w.id === a.id)!;
      return { ...a, pinned_x: write.x, pinned_y: write.y };
    });

    // Pass 2..N: a new node arrives; the first three do not budge.
    let nodes = nodes1;
    const before = positionsOf(nodes);
    const grown = [...persisted, article('d')];
    const plan2 = planLayout(grown, edges, positionsOf(nodes));
    expect(plan2.freeIds).toEqual(['d']);
    const positions2 = applyLayoutResult(plan2, { d: { x: 0, y: 0 } });
    nodes = reconcileNodes(nodes, grown, { positions: positions2 }).nodes;

    for (const id of ['a', 'b', 'c']) {
      expect(positionsOf(nodes)[id]).toEqual(before[id]);
    }
    const oldBounds = boundsOfPositions(Object.values(before))!;
    expect(positionsOf(nodes).d.y).toBeGreaterThanOrEqual(oldBounds.maxY + LAYOUT_GAP);
  });
});

/**
 * The same path with the real elkjs layered engine rather than a hand-written
 * layout result — this is what catches a bad option key or a shape elkjs
 * silently ignores. Still DOM-free; elkjs runs fine in Node.
 */
describe('real elkjs through the real pipeline', () => {
  it('lays out a fresh map, then grows it without moving anything', async () => {
    const articles = [article('a'), article('b'), article('c'), article('d')];
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'a', 'c'), edge('e3', 'b', 'd')];

    const plan1 = planLayout(articles, edges, {});
    expect(plan1.needsLayout).toBe(true);
    const positions1 = applyLayoutResult(plan1, await runElkLayout(plan1.graph));
    const first = reconcileNodes([], articles, { positions: positions1 });
    expect(first.unplacedIds).toEqual([]);

    // A real layered layout: four nodes on three distinct rows, none overlapping.
    const before = positionsOf(first.nodes);
    expect(new Set(Object.values(before).map((p) => p.y)).size).toBe(3);
    for (const [idA, a] of Object.entries(before)) {
      for (const [idB, b] of Object.entries(before)) {
        if (idA >= idB) continue;
        expect(Math.abs(a.x - b.x) >= NODE_WIDTH || Math.abs(a.y - b.y) >= NODE_HEIGHT).toBe(true);
      }
    }

    const writes = positionsNeedingPersist(first.nodes, articles);
    expect(writes).toHaveLength(4);
    // What ELK produced is exactly what gets stored — no rounding drift.
    for (const write of writes) {
      expect(before[write.id]).toEqual({ x: write.x, y: write.y });
    }
    const persisted = articles.map((a) => {
      const write = writes.find((w) => w.id === a.id)!;
      return { ...a, pinned_x: write.x, pinned_y: write.y };
    });

    // Two new nodes arrive, one of them linked to an existing node.
    const grown = [...persisted, article('x'), article('y')];
    const grownEdges = [...edges, edge('e4', 'd', 'x'), edge('e5', 'x', 'y')];
    const plan2 = planLayout(grown, grownEdges, positionsOf(first.nodes));
    expect(plan2.freeIds).toEqual(['x', 'y']);
    // The d→x edge crosses into fixed territory and is excluded.
    expect(plan2.graph.edges.map((g) => g.id)).toEqual(['e5']);

    const positions2 = applyLayoutResult(plan2, await runElkLayout(plan2.graph));
    const second = reconcileNodes(first.nodes, grown, { positions: positions2 });
    const after = positionsOf(second.nodes);

    for (const id of ['a', 'b', 'c', 'd']) expect(after[id]).toEqual(before[id]);
    const oldBounds = boundsOfPositions(Object.values(before))!;
    expect(after.x.y).toBeGreaterThanOrEqual(oldBounds.maxY + LAYOUT_GAP);
    expect(after.y.y).toBeGreaterThanOrEqual(oldBounds.maxY + LAYOUT_GAP);
    expect(positionsNeedingPersist(second.nodes, grown).map((w) => w.id)).toEqual(['x', 'y']);
  });

  it('never calls elkjs for a fully pinned map', async () => {
    const articles = [pinned('a', 3, 4), pinned('b', 500, 900)];
    const plan = planLayout(articles, [], {});
    expect(plan.needsLayout).toBe(false);
    expect(await runElkLayout(plan.graph)).toEqual({});
    expect(applyLayoutResult(plan, {})).toEqual({ a: { x: 3, y: 4 }, b: { x: 500, y: 900 } });
  });
});

describe('node box sizing', () => {
  it('sizes every ELK child as one pane, whatever the node type', () => {
    expect(NODE_WIDTH).toBe(350);
    const plan = planLayout([article('q', { node_type: 'concept' }), article('a')], []);
    expect(plan.graph.children).toEqual([
      { id: 'q', width: NODE_WIDTH, height: NODE_HEIGHT },
      { id: 'a', width: NODE_WIDTH, height: NODE_HEIGHT },
    ]);
  });
});

describe('layout move easing', () => {
  it('is smoothstep, pinned at both ends', () => {
    expect(LAYOUT_ANIMATION_MS).toBe(500);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 10);
    // Eased, not linear: the curve sits below the diagonal in the first half.
    expect(easeInOut(0.25)).toBeLessThan(0.25);
    expect(easeInOut(0.75)).toBeGreaterThan(0.75);
  });

  it('interpolates a node between its old and new position', () => {
    const from = { x: 100, y: 200 };
    const to = { x: 300, y: 0 };
    expect(easedPosition(from, to, 0)).toEqual(from);
    expect(easedPosition(from, to, 1)).toEqual(to);
    expect(easedPosition(from, to, 0.5)).toEqual({ x: 200, y: 100 });
  });
});
