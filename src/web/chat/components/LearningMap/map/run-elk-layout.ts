/**
 * The impure half of layout: hand a graph to elkjs and read coordinates back.
 *
 * Split out from map-layout.ts so the decision logic — what ELK is allowed to
 * touch, and where its answer lands — stays testable without loading the
 * 1.5MB ELK bundle or a worker.
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import type { LayoutGraph, XY } from './map-layout';

const elk = new ELK();

/** Lay out a graph and return top-left positions keyed by node id. */
export async function runElkLayout(graph: LayoutGraph): Promise<Record<string, XY>> {
  if (graph.children.length === 0) return {};
  const result = await elk.layout(graph);
  const positions: Record<string, XY> = {};
  for (const child of result.children ?? []) {
    if (typeof child.x === 'number' && typeof child.y === 'number') {
      positions[child.id] = { x: child.x, y: child.y };
    }
  }
  return positions;
}
