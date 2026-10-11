import { useEffect, useState } from 'react';
import type { LatticeWebHost } from '@liggi/lattice-plugin-kit';

function Wave({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 9c2-4 4 4 6 0s4 4 6 0" />
    </svg>
  );
}

export default function activate(web: LatticeWebHost): void {
  let count = 0;
  const listeners = new Set<(n: number) => void>();
  const set = (n: number) => { count = n; listeners.forEach((fn) => fn(n)); };
  void web.api.get<{ count: number }>('/count').then((r) => set(r.count));

  function useCount(): number {
    const [n, setN] = useState(count);
    useEffect(() => { listeners.add(setN); return () => { listeners.delete(setN); }; }, []);
    return n;
  }

  function HelloPage() {
    const n = useCount();
    const [error, setError] = useState<string | null>(null);
    return (
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4" data-testid="hello-page">
        <h1 className="text-xl text-fg">Bumped {n} times</h1>
        <div className="flex gap-2">
          <button type="button" data-testid="hello-bump" className="px-3 py-1.5 rounded-md bg-accent/10 text-accent text-[13px] font-medium hover:bg-accent/20 cursor-pointer"
            onClick={() => void web.api.post<{ count: number }>('/bump').then((r) => set(r.count))}>
            Bump
          </button>
          <button type="button" data-testid="hello-start" className="px-3 py-1.5 rounded-md text-fg-2 text-[13px] hover:bg-surface-2 cursor-pointer"
            onClick={() => void web.api.post<{ conversationId: string }>('/start', { message: 'Reply with the single word: hello.' })
              .then((r) => web.navigate(`/c/${r.conversationId}`))
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}>
            Start a session
          </button>
        </div>
        {error && <p className="text-xs text-rose-300">{error}</p>}
      </div>
    );
  }

  web.page('/', HelloPage, { title: 'Hello' });
  web.sidebarLink({
    label: 'Hello',
    path: '/',
    icon: Wave,
    useBadge: () => {
      const n = useCount();
      return n ? `${n} bumps` : null;
    },
  });
}
