import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { X, ExternalLink, Check, AlertCircle, Copy } from 'lucide-react';

/**
 * Lightweight toast notification system
 *
 * Usage:
 *   const { showToast } = useToast();
 *   showToast({
 *     title: 'Walkthrough Ready',
 *     message: 'Click to view',
 *     type: 'success',
 *     action: { label: 'View', href: '/session/abc/walkthrough' }
 *   });
 */

export interface ToastAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface Toast {
  id: string;
  title: string;
  message?: string;
  type: 'success' | 'error' | 'info';
  action?: ToastAction;
  duration?: number; // ms, default 5000, 0 = persistent
  copyUrl?: string; // URL to copy to clipboard
}

interface ToastContextValue {
  showToast: (toast: Omit<Toast, 'id'>) => string;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (toast.duration !== 0) {
      const timer = setTimeout(onDismiss, toast.duration || 5000);
      return () => clearTimeout(timer);
    }
  }, [toast.duration, onDismiss]);

  const handleCopyUrl = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (toast.copyUrl) {
      const fullUrl = window.location.origin + toast.copyUrl;
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // The icon carries the state; the card itself stays neutral.
  const iconColor = {
    success: 'text-emerald-400',
    error: 'text-rose-300',
    info: 'text-fg-2',
  }[toast.type];

  const Icon = {
    success: Check,
    error: AlertCircle,
    info: AlertCircle,
  }[toast.type];

  return (
    <div
      className={`
        flex items-start gap-3 p-3 rounded-lg
        bg-surface-2 border border-line-2
        animate-in slide-in-from-right-5 fade-in duration-200
        max-w-sm
      `}
    >
      <Icon size={18} className={`${iconColor} shrink-0 mt-0.5`} />

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-fg">{toast.title}</div>
        {toast.message && (
          <div className="text-xs text-fg-2 mt-0.5 line-clamp-2">
            {toast.message}
          </div>
        )}

        {/* Actions row */}
        {(toast.action || toast.copyUrl) && (
          <div className="flex items-center gap-2 mt-2">
            {toast.action && (
              toast.action.href && !toast.action.onClick ? (
                <a
                  href={toast.action.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-accent hover:bg-accent-soft transition-colors"
                >
                  <ExternalLink size={12} />
                  {toast.action.label}
                </a>
              ) : (
                <button
                  onClick={toast.action.onClick}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-accent hover:bg-accent-soft transition-colors"
                >
                  {toast.action.label}
                </button>
              )
            )}

            {toast.copyUrl && (
              <button
                onClick={handleCopyUrl}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-fg-2 hover:text-fg hover:bg-surface transition-colors"
                title="Copy URL"
              >
                {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy URL'}
              </button>
            )}
          </div>
        )}
      </div>

      <button
        onClick={onDismiss}
        className="text-fg-3 hover:text-fg transition-colors shrink-0"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
    return id;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}

      {/* Toast container - fixed position top right */}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              onDismiss={() => dismissToast(toast.id)}
            />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
