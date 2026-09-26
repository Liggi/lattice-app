import React from 'react';
import ReactMarkdown from 'react-markdown';
import { extractDomain } from '../../utils/tool-utils.js';
import { PROSE_CLASSES, PROSE_CLASSES_SM } from '../../tokens.js';
import { tk } from '../../tokens.js';

interface SearchLink {
  title: string;
  url: string;
}

function parseSearchLinks(result: string): SearchLink[] {
  const linksMatch = result.match(/Links:\s*(\[[\s\S]*?\])/);
  if (!linksMatch) return [];
  try {
    const parsed = JSON.parse(linksMatch[1]);
    if (Array.isArray(parsed)) return parsed.filter((l: SearchLink) => l.title && l.url);
  } catch { /* not valid JSON */ }
  return [];
}

function getSearchSnippet(result: string): string {
  const linksEnd = result.indexOf(']\n');
  if (linksEnd === -1) return '';
  return result.slice(linksEnd + 2).trim();
}

function SearchLinks({ links }: { links: SearchLink[] }): React.JSX.Element {
  return (
    <div className="px-3 py-2 space-y-1.5">
      {links.map((link, i) => (
        <a
          key={i}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-start gap-2 group"
          style={{ textDecoration: 'none' }}
        >
          <img
            src={`https://www.google.com/s2/favicons?domain=${extractDomain(link.url)}&sz=32`}
            alt=""
            width={12}
            height={12}
            className="w-3 h-3 rounded-sm mt-0.5 flex-shrink-0"
          />
          <div className="min-w-0">
            <div className={`text-[13px] ${tk.text.primary} group-hover:text-cyan-700 dark:group-hover:text-cyan-400 truncate`}>
              {link.title}
            </div>
            <div className={`text-[13px] ${tk.text.faint} truncate`}>
              {extractDomain(link.url)}
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}

export function SearchResultContent({ result, compact }: { result: string; compact?: boolean }): React.JSX.Element {
  const links = parseSearchLinks(result);
  const snippet = getSearchSnippet(result);
  const proseClasses = compact ? PROSE_CLASSES_SM : PROSE_CLASSES;

  if (links.length === 0) {
    return (
      <div className={`px-3 py-2.5 ${proseClasses}`}>
        <ReactMarkdown>{result}</ReactMarkdown>
      </div>
    );
  }

  return (
    <div className={tk.codeBg}>
      <SearchLinks links={links} />
      {snippet && (
        <div className={`border-t ${tk.separator} px-3 py-2.5 ${proseClasses}`}>
          <ReactMarkdown>{snippet}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

export function FetchResultContent({ result, url, compact }: { result: string; url?: string; compact?: boolean }): React.JSX.Element {
  const proseClasses = compact ? PROSE_CLASSES_SM : PROSE_CLASSES;

  return (
    <div className={tk.codeBg}>
      {url && (
        <div className={`px-3 py-2 border-b ${tk.separator}`}>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[13px] transition-all
              bg-stone-100 text-stone-500 hover:bg-stone-200 hover:text-stone-700
              dark:bg-stone-800/50 dark:text-stone-400 dark:hover:bg-stone-700/50 dark:hover:text-stone-300`}
            style={{ textDecoration: 'none' }}
          >
            <img
              src={`https://www.google.com/s2/favicons?domain=${extractDomain(url)}&sz=32`}
              alt=""
              width={12}
              height={12}
              className="w-3 h-3 rounded-sm"
            />
            <span>{extractDomain(url)}</span>
          </a>
        </div>
      )}
      <div className={`px-3 py-2.5 ${proseClasses}`}>
        <ReactMarkdown>{result}</ReactMarkdown>
      </div>
    </div>
  );
}

export function ProseResultContent({ content, compact }: { content: string; compact?: boolean }): React.JSX.Element {
  const proseClasses = compact ? PROSE_CLASSES_SM : PROSE_CLASSES;
  return (
    <div className={`px-3 py-2.5 ${proseClasses}`}>
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
