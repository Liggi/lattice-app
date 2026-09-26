/**
 * A single map node — a tinted pane on the canvas, one hue per node kind.
 *
 * The box, the padding, the type word and the body text role come from
 * thekg.io's article-node/question-node; the surface, radius, text tokens and
 * selected ring are the app's own vocabulary, and the hue lives in
 * node-palette.ts.
 *
 * The map API's article summaries carry no takeaways, so the source's bulleted
 * list under the body text is omitted rather than filled with invented content,
 * and the body text only takes a bottom margin when that list is present.
 *
 * A node whose article has not been written yet says so under its title. It is
 * a real node from the moment the question was followed — the map is a trail,
 * and the step exists before the article at the end of it does.
 */

import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Loader2 } from 'lucide-react';
import type { MapNodeData } from './map-layout';
import { tintFor } from './node-palette';

export type KmFlowNode = Node<MapNodeData, 'kmNode'>;

/** Edge anchors: present for routing, invisible, exactly as in the original. */
const HANDLE_CLASS = 'bg-transparent! border-0! w-4! h-4!';

export function MapNode({ data, selected }: NodeProps<KmFlowNode>): JSX.Element {
  const tint = tintFor(data.nodeType);
  const takeaways = data.takeaways ?? [];

  return (
    <div
      style={tint.surface}
      title={data.title}
      className={`
        p-4 transition-colors duration-150 cursor-pointer
        ${tint.hoverClass}
        ${selected ? tint.selectedClass : ''}
        rounded-lg ${tint.widthClass}
      `}
    >
      <div className={`text-xs font-medium mb-2 ${tint.labelClass}`}>{tint.label}</div>

      <div className={`text-fg text-sm font-medium${takeaways.length > 0 ? ' mb-3' : ''}`}>
        {data.summary ?? data.title}
      </div>

      {data.pending && (
        <div
          data-testid="km-node-pending"
          className="mt-2 flex items-center gap-1.5 text-xs text-fg-3"
        >
          <Loader2 size={11} className="animate-spin" />
          Writing…
        </div>
      )}

      {takeaways.length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-line">
          {takeaways.map((takeaway) => (
            <div key={takeaway} className="flex items-start gap-2 text-xs text-fg-2">
              <div className="mt-2 w-1.5 h-1.5 rounded-full bg-line-2 flex-shrink-0" />
              <div>{takeaway}</div>
            </div>
          ))}
        </div>
      )}

      <Handle
        type="target"
        position={Position.Top}
        className={HANDLE_CLASS}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className={HANDLE_CLASS}
        isConnectable={false}
      />
    </div>
  );
}
