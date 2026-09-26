import React, { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  name?: string;
  inline?: boolean;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error(
      `[ErrorBoundary${this.props.name ? `:${this.props.name}` : ''}]`,
      error,
      errorInfo.componentStack,
    );
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError && this.state.error) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.state.error, this.reset);
      }
      if (this.props.fallback) return this.props.fallback;
      if (this.props.inline) {
        return (
          <span className="inline-flex items-center gap-1.5 text-red-400 text-sm">
            <AlertTriangle size={14} />
            <span>Error{this.props.name ? ` in ${this.props.name}` : ''}</span>
            <button onClick={this.reset} className="text-red-300 hover:text-red-200 underline">
              retry
            </button>
          </span>
        );
      }
      return (
        <div className="my-2 border border-red-500/30 rounded-lg overflow-hidden bg-red-500/5">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-red-500/20">
            <AlertTriangle size={14} className="text-red-400 flex-shrink-0" />
            <span className="text-xs font-medium text-rose-400">
              Render Error{this.props.name ? ` — ${this.props.name}` : ''}
            </span>
            <button
              onClick={this.reset}
              className="ml-auto flex items-center gap-1 px-2 py-1 text-xs text-red-300 hover:text-red-200 hover:bg-red-500/10 rounded transition-colors"
            >
              <RefreshCw size={12} /> Retry
            </button>
          </div>
          <div className="px-3 py-2 text-sm text-red-200 font-medium">
            {this.state.error.message}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
