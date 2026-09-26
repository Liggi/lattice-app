import React, { Suspense, useState } from 'react';
import { Pencil } from 'lucide-react';
import { cn } from '../../utils/cn.js';
import { detectLanguageFromPath } from '../../utils/language-detection.js';
import { formatFilePath } from '../../utils/tool-utils.js';
import { LazyCodeHighlight } from '../shared/LazyCodeHighlight.js';
import { ErrorBoundary } from '../shared/ErrorBoundary.js';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { tk, accent } from '../../tokens.js';

interface EditEntry { old_string?: string; new_string?: string }

interface EditToolProps {
  input: { file_path?: string; old_string?: string; new_string?: string; edits?: EditEntry[] };
  result: string;
  isMultiEdit?: boolean;
  workingDirectory?: string;
}

const LazyDiffViewer = React.lazy(async () => {
  const mod = await import('../shared/DiffViewer.js');
  return { default: mod.DiffViewer };
});

function DiffViewerFallback({ oldValue, newValue }: { oldValue: string; newValue: string }): React.JSX.Element {
  return (
    <pre className={cn('m-0 px-3 py-2.5 font-mono text-[13px] whitespace-pre-wrap break-words leading-relaxed', tk.codeBg, tk.text.primary)}>
      <code>{newValue || oldValue || 'No changes'}</code>
    </pre>
  );
}

function countChanges(oldStr: string, newStr: string): { added: number; removed: number } {
  return {
    added: Math.max(0, newStr.split('\n').length - oldStr.split('\n').length),
    removed: Math.max(0, oldStr.split('\n').length - newStr.split('\n').length),
  };
}

const AUTO_EXPAND_THRESHOLD = 5;

export function EditTool({ input, result, isMultiEdit = false, workingDirectory }: EditToolProps): React.JSX.Element {
  const filePath = input?.file_path || '';
  const displayPath = formatFilePath(filePath, workingDirectory);
  const language = detectLanguageFromPath(filePath);

  let totalAdded = 0;
  let totalRemoved = 0;

  if (isMultiEdit && input.edits && Array.isArray(input.edits)) {
    input.edits.forEach((edit) => {
      const c = countChanges(edit.old_string || '', edit.new_string || '');
      totalAdded += c.added;
      totalRemoved += c.removed;
    });
  } else if (input.old_string !== undefined && input.new_string !== undefined) {
    const c = countChanges(input.old_string, input.new_string);
    totalAdded = c.added;
    totalRemoved = c.removed;
  }

  const totalChangedLines = totalAdded + totalRemoved;
  const [isExpanded, setIsExpanded] = useState(() => totalChangedLines > 0 && totalChangedLines <= AUTO_EXPAND_THRESHOLD);

  const deltaText = totalAdded > 0 && totalRemoved > 0
    ? `+${totalAdded} -${totalRemoved}`
    : totalAdded > 0 ? `+${totalAdded}`
    : totalRemoved > 0 ? `-${totalRemoved}`
    : '~';

  const renderDiffContent = () => {
    const renderDiffViewer = (oldValue: string, newValue: string): React.JSX.Element => (
      <ErrorBoundary inline name="DiffViewer" fallback={<DiffViewerFallback oldValue={oldValue} newValue={newValue} />}>
        <Suspense fallback={<DiffViewerFallback oldValue={oldValue} newValue={newValue} />}>
          <LazyDiffViewer oldValue={oldValue} newValue={newValue} language={language} />
        </Suspense>
      </ErrorBoundary>
    );

    if (isMultiEdit && input.edits && Array.isArray(input.edits)) {
      return (
        <div className="flex flex-col">
          {input.edits.map((edit, index) => (
            <div key={index}>
              {index > 0 && <div className="border-t border-emerald-500/20" />}
              {renderDiffViewer(edit.old_string || '', edit.new_string || '')}
            </div>
          ))}
        </div>
      );
    }

    if (input.old_string !== undefined && input.new_string !== undefined) {
      return renderDiffViewer(input.old_string, input.new_string);
    }

    return result ? (
      <LazyCodeHighlight code={result} language={language} className="rounded-none" />
    ) : (
      <div className={`px-3 py-2 text-sm ${tk.text.muted}`}>Edit completed successfully</div>
    );
  };

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardClassName={accent.emerald.card}
      headerContent={(
        <>
          <div className="flex items-center gap-2">
            <Pencil size={14} className={`${accent.emerald.icon} flex-shrink-0`} />
            <span className={`text-xs ${tk.text.muted}`}>Edit</span>
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>{displayPath}</span>
          <span className={cn('text-[11px] tabular-nums flex-shrink-0', tk.text.faint)}>{deltaText}</span>
        </>
      )}
      content={(
        <div className={`border-t ${tk.separator}`}>{renderDiffContent()}</div>
      )}
    />
  );
}
