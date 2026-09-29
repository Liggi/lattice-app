import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { LazyCodeHighlight } from '../CodeHighlight';
import { DIAGRAM_CSS, DIAGRAM_EXPAND_BELOW, DIAGRAM_MARKERS, completeSvg } from '../../../../utils/diagram-style';

/** True while the message holding the diagram is still arriving. */
export const DiagramStreamingContext = createContext(false);

/**
 * Renders an agent's ```diagram fence: an inline SVG drawn inside a sandboxed
 * iframe (scripts from the agent blocked, no network, no access to the app),
 * sized to the drawing and styled by the shared diagram classes. A fence still
 * arriving shows a placeholder. Whether it is drawn or shown as source is decided
 * by completeSvg alone, the rule `lattice diagram check` applies, and never by how
 * the frame measured: a frame laid out while hidden reports no size until shown.
 */
export function DiagramBlock({ source }: { source: string }): React.JSX.Element {
  const streaming = useContext(DiagramStreamingContext);
  const svg = completeSvg(source);
  if (!svg) {
    if (streaming) return <div className="not-prose my-3 text-[12px] text-fg-3" data-diagram-pending>Drawing a diagram…</div>;
    return (
      <div className="not-prose my-3" data-diagram-source>
        <div className="mb-1 text-[12px] text-fg-3">This diagram could not be drawn. Its source:</div>
        <DiagramSource source={source} />
      </div>
    );
  }
  return <DiagramFrame svg={svg} />;
}

function DiagramFrame({ svg }: { svg: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(0);
  const [shrunk, setShrunk] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const nonce = useMemo(() => Math.random().toString(36).slice(2), []);
  const doc = useMemo(() => buildDocument(svg, nonce, false), [svg, nonce]);
  const fullDoc = useMemo(() => buildDocument(svg, nonce, true), [svg, nonce]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const d = (e.data as { latticeDiagram?: { height: number; natural: number; shown: number } })?.latticeDiagram;
      if (!d) return;
      setHeight(Math.ceil(d.height));
      setShrunk(d.natural > 0 && d.shown / d.natural < DIAGRAM_EXPAND_BELOW);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const control = 'text-[12px] font-medium text-fg-3 hover:text-fg-2 transition-colors';
  return (
    <div className="not-prose my-3" data-diagram>
      <iframe
        ref={ref}
        title="Diagram"
        sandbox="allow-scripts"
        srcDoc={doc}
        style={{ height, width: '100%', border: 0, display: 'block', colorScheme: 'dark' }}
      />
      <div className="mt-1.5 flex gap-4">
        {shrunk && (
          <button type="button" data-diagram-expand onClick={() => setExpanded(true)} className={control}>
            Open full size
          </button>
        )}
        <button type="button" data-diagram-toggle-source onClick={() => setShowSource((v) => !v)} className={control}>
          {showSource ? 'Hide source' : 'Source'}
        </button>
      </div>
      {showSource && <div className="mt-2"><DiagramSource source={svg} /></div>}
      {expanded && (
        <div
          data-diagram-full
          className="fixed inset-0 z-[100] flex flex-col bg-bg"
          onClick={(e) => { if (e.target === e.currentTarget) setExpanded(false); }}
        >
          <div className="flex justify-end px-3 py-2">
            <button type="button" onClick={() => setExpanded(false)} className="text-[13px] font-medium text-fg-2 hover:text-fg">
              Close
            </button>
          </div>
          <iframe title="Diagram, full size" sandbox="allow-scripts" srcDoc={fullDoc} className="min-h-0 flex-1" style={{ width: '100%', border: 0, colorScheme: 'dark' }} />
        </div>
      )}
    </div>
  );
}

function DiagramSource({ source }: { source: string }) {
  return <LazyCodeHighlight code={source.replace(/\n$/, '')} language="xml" className="rounded-md border border-line max-w-full box-border" />;
}

function buildDocument(svg: string, nonce: string, full: boolean): string {
  const csp = ["default-src 'none'", "style-src 'unsafe-inline'", 'img-src data:', `script-src 'nonce-${nonce}'`].join('; ');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${PAGE_CSS}${full ? FULL_CSS : ''}${DIAGRAM_CSS}</style></head><body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">${DIAGRAM_MARKERS}</svg>
<div id="d">${svg}</div>
<script nonce="${nonce}">
  const d = document.getElementById('d');
  const post = () => {
    const svg = d.querySelector(':scope > svg');
    const box = svg && svg.getBoundingClientRect();
    const vb = svg && svg.viewBox && svg.viewBox.baseVal;
    const natural = svg ? (svg.width.baseVal.value || (vb && vb.width) || 0) : 0;
    parent.postMessage({ latticeDiagram: { height: d.getBoundingClientRect().height, natural, shown: box ? box.width : 0 } }, '*');
  };
  new ResizeObserver(post).observe(d);
  document.fonts && document.fonts.ready.then(post);
</script></body></html>`;
}

const PAGE_CSS = `
html, body { margin: 0; background: transparent; color-scheme: dark; -webkit-font-smoothing: antialiased; }
#d { padding: 1px 0; }
#d > svg { display: block; max-width: 100%; height: auto; overflow: visible; }
`;

const FULL_CSS = `
html, body { height: 100%; }
#d { padding: 16px; overflow: auto; height: 100%; box-sizing: border-box; }
#d > svg { max-width: none; }
`;
