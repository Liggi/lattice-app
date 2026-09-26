/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler */
import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
// import { cn } from "../../lib/utils";
import { Button } from '../ui/button';

interface JsonViewerProps {
  data: unknown;
  collapsed?: boolean;
  depth?: number;
}

export function JsonViewer({ data, collapsed = false, depth = 0 }: JsonViewerProps): JSX.Element {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const effectiveCollapsed = collapsed || isCollapsed;
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const renderValue = (value: unknown, _key?: string): React.ReactNode => {
    if (value === null) {
      return <span className="text-fg-3">null</span>;
    }

    if (value === undefined) {
      return <span className="text-fg-3">undefined</span>;
    }

    if (typeof value === 'boolean') {
      return <span className="text-fg">{value.toString()}</span>;
    }

    if (typeof value === 'number') {
      return <span className="text-fg">{value}</span>;
    }

    if (typeof value === 'string') {
      return <span className="text-fg">"{value}"</span>;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return <span className="text-fg-3">[]</span>;
      }

      return (
        <span className="inline-block">
          <button
            className="inline-flex items-center justify-center w-4 h-4 mr-0.5 text-fg-3 hover:text-fg transition-colors"
            onClick={() => setIsCollapsed(prev => !prev)}
            aria-label={effectiveCollapsed ? 'Expand array' : 'Collapse array'}
          >
            {effectiveCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <span className="text-fg-3">[</span>
          {effectiveCollapsed ? (
            <span className="text-fg-3 italic mx-1">...{value.length} items</span>
          ) : (
            <div className="ml-[18px]">
              {Object.entries(value).map(([arrayIndex, item]) => (
                <div key={`json-array-item-${arrayIndex}`} className="my-0.5">
                  <span className="text-fg-2 mr-1">{arrayIndex}:</span>
                  {renderValue(item)}
                  {Number(arrayIndex) < value.length - 1 && <span className="text-fg-3">,</span>}
                </div>
              ))}
            </div>
          )}
          <span className="text-fg-3">]</span>
        </span>
      );
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length === 0) {
        return <span className="text-fg-3">{'{}'}</span>;
      }

      return (
        <span className="inline-block">
          <button
            className="inline-flex items-center justify-center w-4 h-4 mr-0.5 text-fg-3 hover:text-fg transition-colors"
            onClick={() => setIsCollapsed(prev => !prev)}
            aria-label={effectiveCollapsed ? 'Expand object' : 'Collapse object'}
          >
            {effectiveCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <span className="text-fg-3">{'{'}</span>
          {effectiveCollapsed ? (
            <span className="text-fg-3 italic mx-1">...{entries.length} properties</span>
          ) : (
            <div className="ml-[18px]">
              {entries.map(([k, v], index) => (
                <div key={k} className="my-0.5">
                  <span className="text-fg-2">"{k}"</span>
                   <span className="text-fg-3 mx-1">:</span>
                  {renderValue(v, k)}
                  {index < entries.length - 1 && <span className="text-fg-3">,</span>}
                </div>
              ))}
            </div>
          )}
          <span className="text-fg-3">{'}'}</span>
        </span>
      );
    }

    return <span className="text-fg-3">{String(value)}</span>;
  };

  return (
    <div className="relative font-mono text-xs leading-relaxed p-2 bg-bg rounded-md overflow-auto">
      {depth === 0 && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-1 right-1 h-6 w-6 bg-surface-2 text-fg-3 hover:bg-line-2 hover:text-fg"
          onClick={handleCopy}
          aria-label="Copy JSON to clipboard"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </Button>
      )}
      {renderValue(data)}
    </div>
  );
}
