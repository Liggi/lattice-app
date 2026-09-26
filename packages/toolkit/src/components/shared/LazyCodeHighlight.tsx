import React, { Suspense } from 'react';
import { cn } from '../../utils/cn.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { tk } from '../../tokens.js';

interface LazyCodeHighlightProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  className?: string;
}

const CodeHighlight = React.lazy(async () => {
  const mod = await import('./CodeHighlight.js');
  return { default: mod.CodeHighlight };
});

function CodeHighlightFallback({ code, className = '' }: Pick<LazyCodeHighlightProps, 'code' | 'className'>): React.JSX.Element {
  return (
    <pre className={cn(
      'm-0 px-3 py-2.5 font-mono text-[13px] whitespace-pre-wrap break-words leading-relaxed',
      tk.codeBg,
      tk.text.secondary,
      className,
    )}>
      <code>{code.trimEnd()}</code>
    </pre>
  );
}

export function LazyCodeHighlight(props: LazyCodeHighlightProps): React.JSX.Element {
  return (
    <ErrorBoundary inline name="CodeHighlight" fallback={<CodeHighlightFallback code={props.code} className={props.className} />}>
      <Suspense fallback={<CodeHighlightFallback code={props.code} className={props.className} />}>
        <CodeHighlight {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
