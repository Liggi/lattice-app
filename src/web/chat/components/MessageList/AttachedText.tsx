import React, { useState } from 'react';
import { Clipboard, FileText } from 'lucide-react';
import { CollapsibleToolCard, tk } from '@liggi/agent-ui-toolkit';
import { parseSavedTextFile, parseUploadedTextFile } from '@/constants/attached-text-file';

function sizeLabel(content: string): string {
  const lines = content.replace(/\n$/, '').split('\n').length;
  if (lines > 1) return `${lines.toLocaleString()} lines`;
  const bytes = new TextEncoder().encode(content).length;
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Text the user attached or pasted, closed to one row; opening it shows the
 * full text. A file is named by its file name, a paste as "Pasted text". A
 * file too large to send inline was saved on disk and the agent given its
 * path; opening its row shows the lines the agent was shown and where the
 * full file is.
 */
export function AttachedText({ kind, label, content }: { kind: 'file' | 'paste'; label: string; content: string }): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const Icon = kind === 'file' ? FileText : Clipboard;
  const saved = kind === 'file' ? parseSavedTextFile(content) : null;
  // Sent but not yet saved by the server: only the upload id is known.
  const uploaded = kind === 'file' && !saved ? parseUploadedTextFile(content) : null;
  const preClass = `m-0 border-t ${tk.separator} max-h-96 overflow-auto ${tk.scrollbar} px-3 py-2 font-mono text-xs leading-relaxed ${tk.text.primary} whitespace-pre`;
  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      wrapperClassName={isExpanded ? 'w-full' : undefined}
      headerContent={(
        <>
          <Icon size={14} className={`${tk.text.muted} flex-shrink-0`} />
          <span className={`text-xs ${tk.text.secondary} truncate min-w-0`}>{label}</span>
          <span className={`text-xs ${tk.text.faint} flex-shrink-0 flex-1`}>
            {saved
              ? `${saved.lines.toLocaleString()} lines`
              : uploaded ? `${(uploaded.bytes / (1024 * 1024)).toFixed(1)} MB` : sizeLabel(content)}
          </span>
        </>
      )}
      content={uploaded ? (
        <p data-testid="attached-text-content" className={`m-0 border-t ${tk.separator} px-3 py-2 text-xs ${tk.text.faint}`}>
          Saving the file for the agent…
        </p>
      ) : saved ? (
        <div data-testid="attached-text-content">
          {/* At most 20 lines, so no height cap: the whole preview shows. */}
          {saved.previewLines > 0 && <pre className={preClass.replace('max-h-96 ', '')}>{saved.preview}</pre>}
          <div className={`border-t ${tk.separator} px-3 py-2 text-xs leading-relaxed`}>
            <p className={`m-0 ${tk.text.faint}`}>
              {saved.previewLines > 0
                ? `Showing the first ${saved.previewLines.toLocaleString()} of ${saved.lines.toLocaleString()} lines. `
                : ''}
              The agent was given the full file ({saved.size}) at
            </p>
            <p className={`m-0 font-mono ${tk.text.muted}`}>
              {saved.path.split('/').map((part, i) => (
                <React.Fragment key={i}>{i > 0 && <>/<wbr /></>}{part}</React.Fragment>
              ))}
            </p>
          </div>
        </div>
      ) : (
        <pre data-testid="attached-text-content" className={preClass}>
          {content}
        </pre>
      )}
    />
  );
}
