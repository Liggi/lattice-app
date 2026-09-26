/**
 * Markdown rendering for the article surface.
 *
 * The block structure follows thekg.io's `src/components/markdown-display.tsx`
 * — the same headings, dot bullets, code card and takeaways blockquote — but
 * every surface, line and text colour is the app's own flat vocabulary, so an
 * article reads as part of Lattice rather than as an imported page.
 *
 * Two things differ from the source in structure, both forced by this repo
 * rather than chosen:
 *
 *  - the container class sits on the wrapping div. thekg.io passes it as
 *    `<ReactMarkdown className=...>`, which react-markdown has ignored since
 *    v9 (the prop was removed); on the wrapper it actually applies, and the
 *    `[&>h1+h2]` style sibling rules still address the rendered blocks because
 *    react-markdown renders them as direct children.
 *  - fenced code keeps this app's shiki highlighter rather than rendering as
 *    plain text. The highlighter's own fill is overridden to transparent so
 *    the card behind it is what you see.
 *
 * The wrapper is also the element quotes are resolved inside and exchange
 * cards are inserted into, so it must stay the direct parent of the rendered
 * blocks — nothing may wrap them in between.
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LazyCodeHighlight } from '../../CodeHighlight';
import {
  ConceptTooltip,
  conceptTextOf,
  useNormalizedTooltips,
  type TooltipMap,
} from './ConceptTooltip';

interface MarkdownComponentProps {
  children?: React.ReactNode;
  className?: string;
  node?: unknown;
  inline?: boolean;
  [key: string]: unknown;
}

/** thekg.io's container string, copied exactly. */
const MARKDOWN_CONTAINER =
  'prose prose-invert prose-sm max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0 '
  + 'prose-pre:bg-transparent [&>h1+h2]:mt-3 [&>h2+h3]:mt-2';

const components: Record<string, React.ComponentType<MarkdownComponentProps>> = {
  h1({ children }: MarkdownComponentProps) {
    return <h1 className="mb-4 text-base font-medium text-fg">{children}</h1>;
  },
  h2({ children }: MarkdownComponentProps) {
    return <h2 className="mb-4 mt-6 text-sm font-medium text-fg">{children}</h2>;
  },
  h3({ children }: MarkdownComponentProps) {
    return <h3 className="mb-3 mt-4 text-[13px] font-medium text-fg-2">{children}</h3>;
  },
  p({ children }: MarkdownComponentProps) {
    return <p className="text-fg leading-relaxed mb-5 text-sm">{children}</p>;
  },
  ol({ children }: MarkdownComponentProps) {
    return (
      <ol className="list-decimal list-inside space-y-2 mb-4 text-fg pl-3">{children}</ol>
    );
  },
  li({ children }: MarkdownComponentProps) {
    return (
      <div className="flex items-start gap-2 text-sm text-fg mb-1">
        <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-line-2 flex-shrink-0" />
        <div>{children}</div>
      </div>
    );
  },
  strong({ children }: MarkdownComponentProps) {
    return <strong className="font-medium text-fg">{children}</strong>;
  },
  blockquote({ children }: MarkdownComponentProps) {
    return (
      <blockquote
        className="p-4 my-4 mt-6 rounded-lg border border-line bg-surface
                   not-prose [&>div>p]:mb-0 [&>div>p:not(:last-child)]:mb-2"
      >
        <div className="text-xs font-medium mb-2 text-fg-2">Key takeaways</div>
        <div className="space-y-2 pt-3 border-t border-line">{children}</div>
      </blockquote>
    );
  },
  pre({ children }: MarkdownComponentProps) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <pre className="my-4">
          <div className="px-1">{children}</div>
        </pre>
      </div>
    );
  },
  code({ node: _node, inline, className, children, ...props }: MarkdownComponentProps) {
    const match = /language-(\w+)/.exec(className || '');
    if (!inline && match) {
      // The highlighter stands in for the original's plain `text-xs` code; its
      // own fill is dropped so the card behind it is the visible surface.
      return (
        <LazyCodeHighlight
          code={String(children).replace(/\n$/, '')}
          language={match[1]}
          className="rounded-lg overflow-hidden max-w-full box-border bg-transparent"
        />
      );
    }
    return (
      <code className={inline || !match ? className : `${className} text-xs`} {...props}>
        {children}
      </code>
    );
  },
  // Not in the original, which has no links in article bodies. A link is an
  // interactive thing, so it takes the app's one accent.
  a({ href, children }: MarkdownComponentProps & { href?: string }) {
    const isInternal = href?.startsWith('/');
    return (
      <a
        href={href}
        target={isInternal ? undefined : '_blank'}
        rel={isInternal ? undefined : 'noopener noreferrer'}
        className="text-accent underline underline-offset-2"
      >
        {children}
      </a>
    );
  },
};

/**
 * The article body. `hostRef` is the element quotes are resolved inside and
 * exchange cards are inserted into, so it must be the direct parent of the
 * rendered blocks — nothing may wrap them in between.
 */
export function ArticleMarkdown({
  content,
  hostRef,
  tooltips,
  onLearnMore,
  isCreatingArticle = false,
}: {
  content: string;
  hostRef?: React.Ref<HTMLDivElement>;
  /** Concept → markdown explanation. Terms without one render as plain bold. */
  tooltips?: TooltipMap;
  onLearnMore?: (concept: string) => void;
  isCreatingArticle?: boolean;
}): JSX.Element {
  const normalized = useNormalizedTooltips(tooltips);

  // Only `strong` differs from the shared renderers, and only when there is
  // something to show — so an article with no tooltips renders the same tree.
  const withTooltips: typeof components = React.useMemo(() => ({
    ...components,
    strong({ children }: MarkdownComponentProps) {
      const concept = conceptTextOf(children);
      return (
        <ConceptTooltip
          concept={concept}
          tooltip={normalized[concept.toLowerCase()]}
          onLearnMore={onLearnMore}
          isCreatingArticle={isCreatingArticle}
        />
      );
    },
  }), [normalized, onLearnMore, isCreatingArticle]);

  return (
    <div ref={hostRef} data-testid="km-article-body" className={MARKDOWN_CONTAINER}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={withTooltips}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * An answer inside an exchange card. Same renderers as the article — thekg.io
 * reuses one `MarkdownDisplay` everywhere, including inside its nodes.
 */
export function NoteMarkdown({ content }: { content: string }): JSX.Element {
  return (
    <div className={MARKDOWN_CONTAINER}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
