import React, { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** What to show when there's an error. Defaults to a styled error card. */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Optional name for this boundary (shown in error UI for debugging) */
  name?: string;
  /** If true, show minimal inline error instead of full card */
  inline?: boolean;
  /** Called when an error is caught */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  showStack: boolean;
}

/**
 * React Error Boundary that catches render errors in children.
 *
 * Use at multiple levels for graceful degradation:
 * - App level: catches catastrophic failures, shows "something went wrong" page
 * - Route level: isolates page crashes, keeps nav working
 * - Component level: isolates widget crashes, keeps page functional
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, showStack: false };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log to console with component stack
    console.error(
      `[ErrorBoundary${this.props.name ? `:${this.props.name}` : ''}] Caught error:`,
      error,
      '\nComponent stack:',
      errorInfo.componentStack
    );

    // Call optional error handler
    this.props.onError?.(error, errorInfo);
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null, showStack: false });
  };

  toggleStack = (): void => {
    this.setState(prev => ({ showStack: !prev.showStack }));
  };

  render(): React.ReactNode {
    if (this.state.hasError && this.state.error) {
      // Custom fallback function
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.state.error, this.reset);
      }

      // Custom fallback node
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Inline minimal error
      if (this.props.inline) {
        return (
          <span className="inline-flex items-center gap-1.5 text-rose-300 text-sm">
            <AlertTriangle size={14} />
            <span>Error{this.props.name ? ` in ${this.props.name}` : ''}</span>
            <button
              onClick={this.reset}
              className="text-accent underline"
            >
              retry
            </button>
          </span>
        );
      }

      // Default styled error card
      return (
        <div className="my-2 border border-line rounded-lg overflow-hidden bg-surface">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
            <AlertTriangle size={14} className="text-rose-300 flex-shrink-0" />
            <span className="text-xs font-medium text-fg-2">
              Render error{this.props.name ? ` — ${this.props.name}` : ''}
            </span>
            <button
              onClick={this.reset}
              className="ml-auto flex items-center gap-1 px-2 py-1 text-xs text-accent hover:bg-accent-soft rounded-sm transition-colors"
            >
              <RefreshCw size={12} />
              Retry
            </button>
          </div>
          <div className="px-3 py-2">
            <p className="text-sm text-fg">
              {this.state.error.message}
            </p>
            {this.state.error.stack && (
              <div className="mt-2">
                <button
                  onClick={this.toggleStack}
                  className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg transition-colors"
                >
                  {this.state.showStack ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {this.state.showStack ? 'Hide' : 'Show'} stack trace
                </button>
                {this.state.showStack && (
                  <pre className="mt-2 text-xs text-fg-3 font-mono whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto">
                    {this.state.error.stack}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Full-page error fallback for app-level boundary.
 * Shows when the entire app crashes.
 */
export function AppErrorFallback({ error, reset }: { error: Error; reset: () => void }): JSX.Element {
  return (
    <div className="min-h-dvh bg-bg flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="border border-line rounded-lg overflow-hidden bg-surface">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
            <AlertTriangle size={18} className="text-rose-300" />
            <span className="text-sm font-medium text-fg">
              Application error
            </span>
          </div>
          <div className="p-4 space-y-4">
            <p className="text-sm text-fg-2">
              Something went wrong while rendering the application.
            </p>
            <p className="text-sm text-fg font-mono bg-bg border border-line px-3 py-2 rounded-md">
              {error.message}
            </p>
            <div className="flex gap-2">
              <button
                onClick={reset}
                className="flex items-center gap-2 px-4 py-2 bg-surface-2 hover:bg-line-2 text-fg rounded-md transition-colors"
              >
                <RefreshCw size={14} />
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 text-fg-2 hover:text-fg transition-colors"
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

