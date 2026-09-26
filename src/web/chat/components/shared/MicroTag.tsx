import React from 'react';

export function MicroTag({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`text-[11px] leading-none px-1.5 py-0.5 rounded-sm bg-surface-2 text-fg-2 ${className}`}
    >
      {children}
    </span>
  );
}
