import React, { Suspense } from 'react';
import { cn } from '@/web/chat/lib/utils';
import { ErrorBoundary } from '../ErrorBoundary/ErrorBoundary';

interface LazyCodeHighlightProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  className?: string;
}

const CodeHighlight = React.lazy(async () => {
  const mod = await import('./CodeHighlight');
  return { default: mod.CodeHighlight };
});

function CodeHighlightFallback({ code, className = '' }: Pick<LazyCodeHighlightProps, 'code' | 'className'>): JSX.Element {
  return (
    <pre className={cn('m-0 overflow-x-auto bg-bg px-3.5 py-3 font-mono text-xs leading-relaxed text-fg-2', className)}>
      <code>{code.trimEnd()}</code>
    </pre>
  );
}

export function LazyCodeHighlight(props: LazyCodeHighlightProps): JSX.Element {
  return (
    <ErrorBoundary inline name="CodeHighlight" fallback={<CodeHighlightFallback code={props.code} className={props.className} />}>
      <Suspense fallback={<CodeHighlightFallback code={props.code} className={props.className} />}>
        <CodeHighlight {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

