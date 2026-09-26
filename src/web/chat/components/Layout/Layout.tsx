import React from 'react';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps): JSX.Element {
  return (
    <div className="flex flex-col w-full h-full overflow-hidden bg-background relative">
      <main className="flex-1 flex flex-col overflow-hidden h-full min-h-0">
        {children}
      </main>
    </div>
  );
}
