import React, { useState, useMemo } from 'react';
import { FileText, ImageIcon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { countLines, formatFilePath } from '../../utils/tool-utils.js';
import { detectLanguageFromPath } from '../../utils/language-detection.js';
import { unwrapContentBlocks, findImageBlock, imageBlockToDataUrl } from '../../utils/content-blocks.js';
import { LazyCodeHighlight } from '../shared/LazyCodeHighlight.js';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { tk, accent, PROSE_CLASSES } from '../../tokens.js';

interface ReadToolProps {
  input: { file_path?: string; offset?: number; limit?: number };
  result: string;
  workingDirectory?: string;
}

function cleanFileContent(content: string): string {
  let cleaned = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  cleaned = cleaned.replace(/^\s*\d+→/gm, '');
  return cleaned.trimEnd();
}

const AUTO_EXPAND_THRESHOLD = 5;

export function ReadTool({ input, result, workingDirectory }: ReadToolProps): React.JSX.Element {
  const filePath = input?.file_path || '';
  const displayPath = formatFilePath(filePath, workingDirectory);

  // Check if the result contains image content blocks (e.g., reading a PNG file)
  const imageDataUrl = useMemo(() => {
    if (!result) return null;
    const unwrapped = unwrapContentBlocks(result);
    if (!unwrapped) return null;
    const imageBlock = findImageBlock(unwrapped);
    return imageBlock ? imageBlockToDataUrl(imageBlock) : null;
  }, [result]);

  const cleanedContent = result ? cleanFileContent(result) : '';
  const lineCount = countLines(cleanedContent);
  const [isExpanded, setIsExpanded] = useState(() => lineCount > 0 && lineCount <= AUTO_EXPAND_THRESHOLD);
  const language = detectLanguageFromPath(filePath);

  if (!result) return <div />;

  if (imageDataUrl) {
    return (
      <CollapsibleToolCard
        isExpanded={true}
        onExpandedChange={() => {}}
        cardClassName={accent.blue.card}
        headerContent={(
          <>
            <div className="flex items-center gap-2">
              <ImageIcon size={14} className={`${accent.blue.icon} flex-shrink-0`} />
              <span className={`text-xs ${tk.text.muted}`}>Read</span>
            </div>
            <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>
              {displayPath}
            </span>
          </>
        )}
        content={(
          <div className={`border-t ${tk.separator} px-3 py-2`}>
            <img
              src={imageDataUrl}
              alt={displayPath}
              className="rounded border border-stone-200 dark:border-stone-800/40 max-w-full max-h-96 object-contain"
            />
          </div>
        )}
      />
    );
  }

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardClassName={accent.blue.card}
      headerContent={(
        <>
          <div className="flex items-center gap-2">
            <FileText size={14} className={`${accent.blue.icon} flex-shrink-0`} />
            <span className={`text-xs ${tk.text.muted}`}>Read</span>
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>
            {displayPath}
          </span>
        </>
      )}
      content={cleanedContent ? (
        <div className={`border-t ${tk.separator}`}>
          {language === 'markdown' ? (
            <div className={`px-3 py-2.5 max-h-96 overflow-y-auto ${tk.scrollbar} ${PROSE_CLASSES}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleanedContent}</ReactMarkdown>
            </div>
          ) : (
            <LazyCodeHighlight code={cleanedContent} language={language} showLineNumbers className="rounded-none" />
          )}
        </div>
      ) : undefined}
    />
  );
}
