/* oxlint-disable react-doctor/no-cascading-set-state, react-doctor/no-giant-component, react-doctor/prefer-useReducer, react-doctor/no-render-in-render, react-doctor/no-effect-event-handler, react-doctor/no-array-index-as-key */
import React, { useMemo, useState, useCallback, useRef } from 'react';
import { SkillHeading } from './SkillHeading';
import { Code, Lightbulb, AlertTriangle, Copy, Check, FileText, Image, Loader2, ExternalLink, FlaskConical, LayoutDashboard, MessageCircle, Wrench, Brain } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkSlackBullets } from '../../utils/slack-bullets';
import { AgentMessage } from './AgentMessage';
import { JsonViewer } from '../JsonViewer/JsonViewer';
import { ToolUseRenderer, type BackgroundTaskState } from '@liggi/agent-ui-toolkit';
import { LazyCodeHighlight } from '../CodeHighlight';
import { ViewableImage } from './ImageViewer';
import { DiagramBlock, DiagramStreamingContext } from './DiagramBlock';
import type { ChatMessage, ToolResult, QuestionRequest, DisplayContentBlock } from '../../types';
import { preserveThinkingBreaks } from '../../utils/thinking-text';
import { AddReactionButton, AgentReactionChips, ReactionChips, firstLine, useRegisterMessageActions, type ReactionTarget } from '../MessageReactions/MessageReactions';
import { copyText } from '../../utils/copy-text';
import { parseAnnotatedMessage } from '../../utils/annotations-format';
import { hasVisibleText } from '../../utils/blank-text';
import { AnnotatedUserMessage } from './AnnotatedUserMessage';
import { UserText } from './UserText';
import type { PastedSpan } from '@liggi/agent-ui-harness/protocol';
import { AttachedText } from './AttachedText';
import { isAttachedTextFileBlock, parseAttachedTextFile } from '@/constants/attached-text-file';
// import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';

interface MessageItemProps {
  message: ChatMessage;
  toolResults?: Record<string, ToolResult>;
  childrenMessages?: Record<string, ChatMessage[]>;
  expandedTasks?: Set<string>;
  onToggleTaskExpanded?: (toolUseId: string) => void;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  isStreaming?: boolean;
  currentQuestionRequest?: QuestionRequest | null;
  onAnswerQuestion?: (questionId: string, answers: Record<string, string>) => void;
  onPlanApprove?: () => void | Promise<void>;
  onPlanReject?: () => void | Promise<void>;
  planOutcomes?: Record<string, 'approved' | 'rejected'>;
  backgroundTaskStates?: Record<string, BackgroundTaskState>;
  /** A message of the thread's own agent that the user can react to; off for a subagent's nested messages. */
  reactable?: boolean;
}

const EMPTY_TOOL_RESULTS: Record<string, ToolResult> = {};
const EMPTY_CHILDREN_MESSAGES: Record<string, ChatMessage[]> = {};

/** The blocks of a user message that are attachments: images, documents and attached text files. */
export function isAttachmentBlock(block: { type: string; text?: string }): boolean {
  return block.type === 'image' || block.type === 'document' || isAttachedTextFileBlock(block);
}

/**
 * The inside of the user's bubble: attachments, then the text, with a notes
 * block shown as passage and note. The thread and the queue above the composer
 * both draw it, so a message looks the same before and after it is taken in.
 */
export function UserMessageBody({ text, pastes, media }: { text: string; pastes?: readonly PastedSpan[]; media?: React.ReactNode[] }): JSX.Element {
  const content = text.trim();
  // Pasted stretches count back from the end of the text, so trimming its end moves them.
  const trimmedFromEnd = text.length - text.trimEnd().length;
  const trimmedPastes = pastes?.map((span) => ({ fromEnd: span.fromEnd - trimmedFromEnd, length: span.length }));
  // Notes on the agent's reply render as passage + note; they are never collapsed.
  const annotated = parseAnnotatedMessage(content);
  return (
    <>
      {media && media.length > 0 && (
        <div className={`flex flex-wrap gap-2${content ? ' mb-2' : ''}`}>{media}</div>
      )}
      {annotated ? (
        <AnnotatedUserMessage parsed={annotated} />
      ) : content ? (
        <UserText text={content} pastes={trimmedPastes} />
      ) : null}
    </>
  );
}

/** A user message's attachments, as its bubble shows them above the text. */
export function attachmentMedia(blocks: readonly DisplayContentBlock[]): React.ReactNode[] {
  return (blocks as ReadonlyArray<{ type: string; text?: string; source?: { type: string; media_type: string; data?: string; url?: string } }>).map((block, idx) => {
    const file = block.type === 'text' && block.text ? parseAttachedTextFile(block.text) : null;
    if (file) {
      return <AttachedText key={`file-${idx}`} kind="file" label={file.fileName} content={file.content} />;
    }
    if (block.type === 'image' && block.source) {
      const src = block.source.type === 'base64'
        ? `data:${block.source.media_type};base64,${block.source.data}`
        : block.source.url;
      return (
        <ImageWithPlaceholder
          key={`img-${idx}`}
          src={src}
          alt="Attached"
          className="max-w-[200px] max-h-[200px] rounded-md border border-line object-contain"
        />
      );
    }
    if (block.type === 'document') {
      return (
        <div key={`doc-${idx}`} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-2">
          <FileText size={14} className="text-fg-2" />
          <span className="text-xs text-fg-2">PDF</span>
        </div>
      );
    }
    return null;
  });
}

// Image component with loading placeholder
function ImageWithPlaceholder({
  src,
  alt = "Attached",
  className = "max-w-[200px] max-h-[200px] rounded-md border border-line object-contain"
}: {
  src?: string;
  alt?: string;
  className?: string;
}): JSX.Element {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const handleLoad = useCallback(() => setIsLoading(false), []);
  const handleError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
  }, []);

  if (hasError) {
    return (
      <div className={`${className} flex items-center justify-center bg-surface`}>
        <span className="text-xs text-fg-3">Failed to load</span>
      </div>
    );
  }

  return (
    <div className="relative inline-block">
      {isLoading && (
        <div className={`${className} flex items-center justify-center bg-surface absolute inset-0`}>
          <Loader2 size={20} className="animate-spin text-fg-3" />
        </div>
      )}
      <ViewableImage src={src} alt={alt} className="block cursor-zoom-in">
        <img
          src={src}
          alt={alt}
          className={`${className} ${isLoading ? 'invisible' : 'visible'}`}
          onLoad={handleLoad}
          onError={handleError}
        />
      </ViewableImage>
    </div>
  );
}

// Strip NEXT_STEPS block from display (rendered separately as clickable pills)
function stripNextStepsBlock(text: string): string {
  const stripped = text.replace(/<!--\s*NEXT_STEPS\s*\n[\s\S]*?-->/g, '').trim();
  return hasVisibleText(stripped) ? stripped : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveToolName(value: unknown, input: Record<string, unknown>): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0 && trimmed.toLowerCase() !== 'unknown') {
      return trimmed;
    }
  }

  const fallbackCandidates = [
    input.tool_name,
    input.toolName,
    input.recipient_name,
    input.recipientName,
  ];

  for (const candidate of fallbackCandidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length > 0 && trimmed.toLowerCase() !== 'unknown') {
        return trimmed;
      }
    }
  }

  return 'Tool';
}

// Parse text to extract insight blocks for inline rendering
function parseInsightBlocks(text: string): Array<{ type: 'text' | 'insight'; content: string }> {
  const blocks: Array<{ type: 'text' | 'insight'; content: string }> = [];

  // Match insight blocks with or without backticks:
  // Handles: `★ Insight ─────` content `─────` OR ★ Insight ───── content ─────
  const insightRegex = /`?★\s*Insight\s*─+`?\s*([\s\S]*?)\s*`?─{5,}`?/g;

  let lastIndex = 0;
  let match;

  while ((match = insightRegex.exec(text)) !== null) {
    // Add text before the insight block
    if (match.index > lastIndex) {
      const beforeText = text.slice(lastIndex, match.index).trim();
      if (beforeText) {
        blocks.push({ type: 'text', content: beforeText });
      }
    }

    // Add the insight block content
    blocks.push({ type: 'insight', content: match[1].trim() });
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last insight
  if (lastIndex < text.length) {
    const afterText = text.slice(lastIndex).trim();
    if (afterText) {
      blocks.push({ type: 'text', content: afterText });
    }
  }

  // If no insights found, return the whole text as a single block
  if (blocks.length === 0) {
    blocks.push({ type: 'text', content: text });
  }

  return blocks;
}

// Render content with insight blocks nested inline within the response card
interface MarkdownComponentProps {
  children?: React.ReactNode;
  className?: string;
  node?: unknown;
  inline?: boolean;
  [key: string]: unknown;
}

/**
 * The row under an agent message: its reactions, and React and Copy. On
 * desktop the two buttons float in a small bar over the message's
 * bottom-right corner when the message is hovered, as Slack's do; the bar
 * sits in the row's reserved height and reaches no higher than the space
 * under the last line's descenders, so it never covers text. On touch there
 * is no hover, and a long-press on the words has to stay a text selection
 * (highlight a section, add a note), so React and Copy are offered in the bar
 * that selection brings up (`SelectionMessageActions`) and the row keeps only
 * the reactions.
 */
function MessageActions({ messageId, text, reaction }: { messageId: string; text: string; reaction?: ReactionTarget }): JSX.Element {
  const [copied, setCopied] = useState(false);
  // On touch the buttons live in the bar a text selection brings up instead.
  useRegisterMessageActions(messageId, text, reaction);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!copyText(text)) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative -ml-1.5 flex flex-wrap items-center gap-0.5 sm:min-h-7 sm:pr-20 pointer-coarse:min-h-0" data-testid="message-actions">
      {reaction && <ReactionChips target={reaction} className="-mt-1 ml-1.5 self-start" />}
      <div
        className="hidden items-center gap-0.5 transition-opacity sm:flex pointer-coarse:hidden sm:absolute sm:-right-1 sm:-top-[9px] sm:z-10 sm:rounded-sm sm:border sm:border-line-2 sm:bg-surface sm:p-px sm:shadow-sm sm:opacity-0 sm:group-hover/message:opacity-100 sm:focus-within:opacity-100 sm:has-[[data-state=open]]:opacity-100"
        data-testid="message-toolbar"
      >
        {reaction && <AddReactionButton target={reaction} />}
        <button
          type="button"
          onClick={handleCopy}
          onPointerDown={(e) => e.stopPropagation()}
          className="p-1.5 ui-icon-btn text-fg-3 touch-manipulation"
          title={copied ? 'Copied' : 'Copy response'}
          aria-label={copied ? 'Copied' : 'Copy response'}
        >
          {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

function ContentWithInsights({ text, markdownComponents }: {
  text: string;
  markdownComponents: Record<string, React.ComponentType<MarkdownComponentProps>>;
}): JSX.Element {
  const blocks = parseInsightBlocks(text);

  // The agent's words are the page, not a card. Its actions sit in the row
  // under the message (MessageActions), never over the text. Prose keeps the
  // 68ch reading measure; tables span the message column, like worker reports.
  return (
    <div>
      <div className="prose max-w-none text-sm leading-[1.55] dark:prose-invert [&>*]:max-w-[68ch] [&>[data-md-table]]:max-w-none">
        {blocks.map((block, idx) => {
          if (block.type === 'insight') {
            return (
              <div key={idx} className="my-3 not-prose rounded-lg bg-surface px-3.5 py-2.5">
                <div className="flex items-center gap-1.5 mb-1 text-xs font-medium text-fg-2">
                  <Lightbulb size={12} className="text-fg-3 flex-shrink-0" />
                  Insight
                </div>
                <div className="prose max-w-none text-sm leading-[1.55] dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkSlackBullets]} components={markdownComponents}>{block.content}</ReactMarkdown>
                </div>
              </div>
            );
          }
          return (
            <ReactMarkdown key={idx} remarkPlugins={[remarkGfm, remarkSlackBullets]} components={markdownComponents}>{block.content}</ReactMarkdown>
          );
        })}
      </div>
    </div>
  );
}

// Detect Lattice internal routes from URLs (handles full URLs with any host, or relative paths)
interface LatticeRouteInfo {
  path: string;           // Relative path to navigate to
  label: string;          // Display label for the card
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: React.ComponentType<any>;
}

const LATTICE_ROUTE_PATTERNS: Array<{
  pattern: RegExp;
  getInfo: (match: RegExpMatchArray) => Omit<LatticeRouteInfo, 'path'>;
}> = [
  {
    pattern: /^\/prototype\/(.+)$/,
    getInfo: (m) => ({
      label: m[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      icon: FlaskConical
    })
  },
  {
    pattern: /^\/c\/([a-f0-9-]+)$/,
    getInfo: (m) => ({
      label: `Session ${m[1].slice(0, 8)}`,
      icon: MessageCircle
    })
  },
  {
    pattern: /^\/dev$/,
    getInfo: () => ({ label: 'Dev Hub', icon: Wrench })
  },
  {
    pattern: /^\/session\/([a-f0-9-]+)\/review$/,
    getInfo: (m) => ({
      label: `Analysis ${m[1].slice(0, 8)}`,
      icon: LayoutDashboard
    })
  },
  {
    pattern: /^\/analysis\/cross-session$/,
    getInfo: () => ({
      label: 'Cross-session analysis',
      icon: LayoutDashboard
    })
  },
];

function getLatticeRouteInfo(href?: string): LatticeRouteInfo | null {
  if (!href) return null;

  // Extract pathname — we only care about the route pattern, not the hostname.
  // The card always navigates via relative path so it works regardless of
  // whether the original URL used localhost, Tailscale IP, or a custom domain.
  let pathname: string;
  if (href.startsWith('/')) {
    pathname = href;
  } else {
    try {
      const url = new URL(href);
      // Skip obviously external URLs (named domains that aren't localhost)
      const host = url.hostname;
      const isLocal = host === 'localhost' || host === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(host);
      if (!isLocal) return null;
      pathname = url.pathname;
    } catch {
      return null;
    }
  }

  for (const { pattern, getInfo } of LATTICE_ROUTE_PATTERNS) {
    const match = pathname.match(pattern);
    if (match) {
      return { path: pathname, ...getInfo(match) };
    }
  }
  return null;
}

// Inline card for Lattice route links — styled to match ProviderSelector aesthetic
function LatticeRouteCard({ route }: { route: LatticeRouteInfo }): JSX.Element {
  return (
    <a
      href={route.path}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 not-prose px-2 py-0.5 my-0.5 rounded-sm bg-surface-2 hover:bg-line-2 transition-colors duration-100 no-underline select-none align-middle cursor-pointer"
      style={{ touchAction: 'manipulation' }}
    >
      <route.icon size={12} className="text-fg-2 flex-shrink-0" />
      <span className="text-xs font-medium text-fg truncate max-w-[200px]">{route.label}</span>
      <ExternalLink size={10} className="text-fg-3 flex-shrink-0" />
    </a>
  );
}

// Custom components for ReactMarkdown
export const markdownComponents: Record<string, React.ComponentType<MarkdownComponentProps>> = {
  a({ href, children }: MarkdownComponentProps & { href?: string }) {
    // Detect if this is a Lattice internal link
    const latticeRoute = getLatticeRouteInfo(href);
    if (latticeRoute) {
      return <LatticeRouteCard route={latticeRoute} />;
    }
    // Regular links
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
  table({ children }: MarkdownComponentProps) {
    return (
      <div data-md-table className="my-3 not-prose">
        <div className="border border-line rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              {children}
            </table>
          </div>
        </div>
      </div>
    );
  },
  thead({ children }: MarkdownComponentProps) {
    return (
      <thead className="bg-surface border-b border-line">
        {children}
      </thead>
    );
  },
  tbody({ children }: MarkdownComponentProps) {
    return <tbody className="divide-y divide-line">{children}</tbody>;
  },
  tr({ children }: MarkdownComponentProps) {
    return <tr className="hover:bg-surface transition-colors">{children}</tr>;
  },
  th({ children }: MarkdownComponentProps) {
    return (
      <th className="px-3 py-2 text-left text-xs font-medium text-fg-2">
        {children}
      </th>
    );
  },
  td({ children }: MarkdownComponentProps) {
    return (
      <td className="px-3 py-2 text-fg">
        {children}
      </td>
    );
  },
  // Fenced blocks with a language render their own box (CodeHighlight), so
  // the wrapping <pre> becomes a plain container; otherwise the global `pre`
  // border and padding would frame the highlighter's box a second time.
  pre({ node: _node, children, ...props }: MarkdownComponentProps) {
    const kids = React.Children.toArray(children);
    const first = kids.length === 1 && React.isValidElement<{ className?: string }>(kids[0]) ? kids[0] : null;
    const hasLanguage = first !== null && /language-\w+/.test(first.props.className || '');
    if (hasLanguage) return <div className="not-prose my-3">{children}</div>;
    return <pre {...props}>{children}</pre>;
  },
  code({ node: _node, inline, className, children, ...props }: MarkdownComponentProps) {
    const match = /language-(\w+)/.exec(className || '');
    const language = match ? match[1] : 'text';

    if (!inline && language === 'diagram') {
      return <DiagramBlock source={String(children)} />;
    }

    // Block code with a language fence → syntax highlighting
    if (!inline && match) {
      return (
        <LazyCodeHighlight
          code={String(children).replace(/\n$/, '')}
          language={language}
          className="rounded-md border border-line max-w-full box-border"
        />
      );
    }

    // Inline code (or no language class): detect Lattice URLs and render as cards.
    // Note: react-markdown v10 doesn't reliably pass `inline` — so we check
    // for URLs regardless and only match if it looks like a full URL.
    const text = String(children).trim();
    if (/^https?:\/\//.test(text)) {
      const routeInfo = getLatticeRouteInfo(text);
      if (routeInfo) {
        return <LatticeRouteCard route={routeInfo} />;
      }
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  img({ src, alt }: MarkdownComponentProps & { src?: string; alt?: string }) {
    const url = localImageUrl(src);
    return (
      <ViewableImage src={url} alt={alt ?? ''} className="not-prose inline-block my-1 max-w-full cursor-zoom-in">
        <img
          src={url}
          alt={alt ?? ''}
          loading="lazy"
          className="block max-w-full h-auto max-h-[70vh] rounded-md border border-line"
        />
      </ViewableImage>
    );
  }
};

/**
 * An agent embeds a screenshot as `![alt](/tmp/shot.png)`: an absolute path on
 * the Lattice host. Point it at the server's image route so it renders from any
 * browser, including a phone. URLs and relative paths are left alone.
 */
export function localImageUrl(src: string | undefined): string | undefined {
  if (!src || !src.startsWith('/') || src.startsWith('//') || src.startsWith('/api/')) return src;
  let decoded = src;
  try { decoded = decodeURI(src); } catch { /* keep as written */ }
  return `/api/images?path=${encodeURIComponent(decoded)}`;
}


export function MessageItem({
  message,
  toolResults = EMPTY_TOOL_RESULTS,
  childrenMessages = EMPTY_CHILDREN_MESSAGES,
  expandedTasks: _expandedTasks = new Set(),
  onToggleTaskExpanded: _onToggleTaskExpanded,
  isFirstInGroup: _isFirstInGroup = true,
  isLastInGroup: _isLastInGroup = true,
  isStreaming = false,
  currentQuestionRequest,
  onAnswerQuestion,
  onPlanApprove,
  onPlanReject,
  planOutcomes,
  backgroundTaskStates,
  reactable = false,
}: MessageItemProps): JSX.Element | null {
  // Capture whether this component mounted during active streaming.
  // Only blocks that first appear while streaming should animate in;
  // blocks that existed before streaming starts (previous turns) must not.
  const mountedWhileStreaming = useRef(isStreaming);

  const _inlineToolResults = useMemo<Record<string, ToolResult>>(() => {
    if (!Array.isArray(message.content)) {
      return {};
    }
    const results: Record<string, ToolResult> = {};
    message.content.forEach((block) => {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result') {
        const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
        if (toolUseId) {
          const content = (block as { content?: string | unknown }).content;
          const result = Array.isArray(content) ? (content as ToolResult['result']) : content;
          results[toolUseId] = {
            status: 'completed',
            result: typeof result === 'string' || Array.isArray(result) ? (result as ToolResult['result']) : undefined,
            is_error: (block as { is_error?: boolean }).is_error,
          };
        }
      }
    });
    return results;
  }, [message.content]);

  // Handle user messages
  if (message.type === 'user') {
    // Extract text content
    const rawContent = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter((block: { type: string; text?: string }) => block.type === 'text' && !isAttachedTextFileBlock(block)).map((block: { type: string; text?: string }) => block.text || '').join('\n')
        : '';

    const content = rawContent.trim();

    // Extract attachment blocks (images, documents, attached text files) for rendering
    const mediaBlocks = Array.isArray(message.content)
      ? message.content.filter(isAttachmentBlock)
      : [];

    // Defensive guard: don't render empty user cards when a user turn carries
    // only non-visible blocks (e.g. historical tool_result payloads).
    if (!content && mediaBlocks.length === 0) {
      return null;
    }

    const mediaNodes = attachmentMedia(mediaBlocks);

    // Another session sent this. It gets its own entry rather than the user's
    // card, so coordination is inspectable without reading as their own words.
    if (message.attribution) {
      return (
        <AgentMessage
          attribution={message.attribution}
          text={content}
          media={mediaBlocks.length > 0 ? mediaNodes : undefined}
          reaction={reactable && message.attribution.sender && content.trim()
            ? { messageId: message.messageId, excerpt: firstLine(content), sender: message.attribution.sender }
            : undefined}
        />
      );
    }

    const userMessageCard = (
      <div className="group/user relative rounded-lg bg-surface w-full">
        <div className="px-3.5 py-2.5 text-sm leading-[1.55] text-fg">
          <UserMessageBody text={rawContent} pastes={message.pastes} media={mediaNodes} />
        </div>
      </div>
    );

    return (
      <div className="flex justify-end w-full my-1" data-testid="user-message">
        <div className="max-w-[85%] min-w-[100px]">
          {userMessageCard}
          <AgentReactionChips messageId={message.messageId} className="-mt-2.5 mr-2" />
        </div>
      </div>
    );
  }

  // Handle assistant messages with timeline
  if (message.type === 'assistant') {
    const mergedToolResults = toolResults || {};
    const messageText = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((block) => (block.type === 'text' && typeof block.text === 'string' ? stripNextStepsBlock(block.text) : '')).filter(Boolean).join('\n\n')
        : '';
    const reaction: ReactionTarget | undefined = reactable && messageText.trim()
      ? { messageId: message.messageId, excerpt: firstLine(messageText) }
      : undefined;

    const renderContent = () => {
      if (typeof message.content === 'string') {
        return (
          <div>
            <ContentWithInsights text={message.content} markdownComponents={markdownComponents} />
          </div>
        );
      }

      if (Array.isArray(message.content)) {
        const contentBlocks = message.content;

        const elements: React.ReactNode[] = [];
        const blockTypeOrdinals = new Map<string, number>();

        const resolveBlockKey = (block: DisplayContentBlock): string => {
          if (block.type === 'tool_use' && typeof block.id === 'string' && block.id.length > 0) {
            return `${message.messageId}-tool_use-${block.id}`;
          }

          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0) {
            return `${message.messageId}-tool_result-${block.tool_use_id}`;
          }

          const ordinal = blockTypeOrdinals.get(block.type) ?? 0;
          blockTypeOrdinals.set(block.type, ordinal + 1);
          return `${message.messageId}-${block.type}-${ordinal}`;
        };

        contentBlocks.forEach((block: DisplayContentBlock) => {
          const blockId = resolveBlockKey(block);

          // Tool results render inside ToolUseRenderer; don't show as standalone blocks
          if (block.type === 'tool_result') {
            return;
          }

          if (block.type === 'text') {
            // Strip NEXT_STEPS blocks - they're rendered separately as clickable pills
            const displayText = stripNextStepsBlock(typeof block.text === 'string' ? block.text : '');
            if (!displayText) return; // Skip empty blocks after stripping
            elements.push(
              <div key={blockId}>
                <ContentWithInsights text={displayText} markdownComponents={markdownComponents} />
              </div>
            );
            return;
          }

          if (block.type === 'thinking') {
            // Opus 5 returns signature-only thinking (empty text) for every
            // subagent block and the odd top-level one — render nothing rather
            // than an empty card. Fable subagent thinking has text and stays.
            const thinkingText = typeof block.thinking === 'string' ? block.thinking : '';
            if (!thinkingText.trim()) return;
            const blockLabel = 'Thinking';
            elements.push(
              <div key={blockId} className="max-w-[68ch]" data-testid="thinking-block">
                <div className="border border-line rounded-lg overflow-hidden">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-fg-3">
                    <Brain size={12} className="flex-shrink-0" />
                    {blockLabel}
                  </div>
                  <div className="px-3 pb-2.5 prose max-w-none text-[13px] leading-relaxed text-fg-2 dark:prose-invert [&_p]:text-fg-2">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{preserveThinkingBreaks(thinkingText)}</ReactMarkdown>
                  </div>
                </div>
              </div>
            );
            return;
          }

          if (block.type === 'tool_use') {
            const toolUseId = typeof block.id === 'string' ? block.id : '';
            if (!toolUseId) return;
            const toolInput = isRecord(block.input) ? block.input : {};
            const toolName = resolveToolName((block as { name?: unknown }).name, toolInput);
            const toolResult = mergedToolResults[toolUseId];

            // An old CLI's "Answer questions?" timeout error is not shown. An
            // AskUserQuestion that expired renders as a closed question card.
            if (toolResult?.is_error) {
              const resultText = typeof toolResult.result === 'string' ? toolResult.result : '';
              if (toolName !== 'AskUserQuestion' && resultText.toLowerCase().includes('answer questions?')) {
                return;
              }
            }

            // Check if this tool block has a pending question
            const matchingQuestionId = currentQuestionRequest?.toolUseId === toolUseId
              ? currentQuestionRequest?.id
              : undefined;

            if (toolName === 'Skill') {
              const skill = typeof toolInput.skill === 'string' ? toolInput.skill : 'skill';
              const args = typeof toolInput.args === 'string' ? toolInput.args.trim() : '';
              elements.push(
                <div key={blockId} className="w-full">
                  <SkillHeading skill={skill} args={args} />
                </div>
              );
              return;
            }

            // All tools render self-contained cards with consistent styling
            elements.push(
              <div key={blockId} className="w-full">
                <ToolUseRenderer
                  toolUse={{
                    type: 'tool_use',
                    id: toolUseId,
                    name: toolName,
                    input: toolInput,
                  }}
                  toolResult={toolResult}
                  toolResults={mergedToolResults}
                  workingDirectory={message.workingDirectory}
                  childrenMessages={childrenMessages as Record<string, import('@liggi/agent-ui-toolkit').ChatMessage[]>}
                  questionId={matchingQuestionId}
                  onAnswerQuestion={onAnswerQuestion}
                  isStreaming={isStreaming}
                  onPlanApprove={onPlanApprove}
                  onPlanReject={onPlanReject}
                  planOutcomes={planOutcomes}
                  backgroundTaskStates={backgroundTaskStates}
                  renderChildMessage={(childMessage) => (
                    <MessageItem
                      key={(childMessage as unknown as ChatMessage).messageId}
                      message={childMessage as unknown as ChatMessage}
                      toolResults={mergedToolResults}
                      childrenMessages={childrenMessages}
                      isStreaming={isStreaming}
                      backgroundTaskStates={backgroundTaskStates}
                    />
                  )}
                />
              </div>
            );
            return;
          }

          // Image content block (from multimodal input)
          if (block.type === 'image') {
            const source = (block as unknown as { source: { type: string; media_type: string; data?: string; url?: string } }).source;
            const src = source.type === 'base64'
              ? `data:${source.media_type};base64,${source.data}`
              : source.url;
            elements.push(
              <div key={blockId}>
                <div className="inline-block border border-line rounded-lg overflow-hidden">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-fg-3">
                    <Image size={12} />
                    Image
                  </div>
                  <div className="px-2 pb-2">
                    <ImageWithPlaceholder
                      src={src}
                      alt="Attached image"
                      className="max-w-md max-h-96 rounded-md object-contain"
                    />
                  </div>
                </div>
              </div>
            );
          }

          // Document content block (PDF from multimodal input)
          if (block.type === 'document') {
            elements.push(
              <div key={blockId}>
                <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-surface">
                  <FileText size={14} className="text-fg-3" />
                  <span className="text-xs text-fg-2">PDF document</span>
                </div>
              </div>
            );
            return;
          }

          // Default: render as JSON
          elements.push(
            <div key={blockId}>
              <div className="border border-line rounded-lg overflow-hidden">
                <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-fg-3">
                  <Code size={12} className="flex-shrink-0" />
                  Data
                </div>
                <div className="px-3 pb-2 text-[13px] leading-relaxed text-fg">
                  <JsonViewer data={block} />
                </div>
              </div>
            </div>
          );
        });

        return elements;
      }

      // Fallback
      return (
        <div>
          <div className="border border-line rounded-lg overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-fg-3">
              <Code size={12} className="flex-shrink-0" />
              Data
            </div>
            <div className="px-3 pb-2 text-[13px] leading-relaxed text-fg">
              <JsonViewer data={message.content} />
            </div>
          </div>
        </div>
      );
    };

    return (
      <div className={`group/message relative w-full flex flex-col gap-1.5${mountedWhileStreaming.current ? ' streaming-message' : ''}`} data-testid="assistant-message">
        <DiagramStreamingContext.Provider value={isStreaming}>{renderContent()}</DiagramStreamingContext.Provider>
        {messageText.trim() && <MessageActions messageId={message.messageId} text={messageText} reaction={reaction} />}
      </div>
    );
  }

  // Handle error messages
  if (message.type === 'error') {
    return (
      <div>
        <div className="rounded-lg bg-[rgb(var(--color-rose-rgb)/0.08)] max-w-[68ch]">
          <div className="flex items-center gap-1.5 px-3.5 pt-2.5 text-xs font-medium text-rose-300">
            <AlertTriangle size={12} className="flex-shrink-0" />
            {message.errorTitle ?? 'Error'}
          </div>
          <div className="px-3.5 pb-2.5 pt-1 text-[13px] text-fg whitespace-pre-wrap break-words">
            {String(message.content)}
          </div>
        </div>
      </div>
    );
  }

  // Default fallback
  return null;
}
