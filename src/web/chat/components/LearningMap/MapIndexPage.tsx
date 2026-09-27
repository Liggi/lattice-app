/**
 * /map — the list of learning maps, plus an inline field to open a new one.
 *
 * `createMap` upserts by name, so the field doubles as "go to the map called
 * X", which is how a session refers to a map anyway.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Map as MapIcon, Plus } from 'lucide-react';
import { createMap, listMaps, type KmMapSummary } from '../../services/api/km-api';

function formatCreated(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function MapIndexPage(): JSX.Element {
  const navigate = useNavigate();
  const [maps, setMaps] = useState<KmMapSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const { maps: listed } = await listMaps();
      setMaps(listed);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(
    async (event: React.FormEvent): Promise<void> => {
      event.preventDefault();
      const trimmed = name.trim();
      if (!trimmed || creating) return;
      setCreating(true);
      try {
        const { map } = await createMap(trimmed);
        setName('');
        void navigate(`/map/${encodeURIComponent(map.id)}`);
      } catch (createError) {
        setError(createError instanceof Error ? createError.message : String(createError));
      } finally {
        setCreating(false);
      }
    },
    [name, creating, navigate],
  );

  return (
    <div className="min-h-dvh overflow-y-auto bg-bg text-fg">
      <header className="flex h-[52px] items-center gap-3 border-b border-line px-4">
        <Link
          to="/"
          aria-label="Back to sessions"
          className="rounded-sm p-1.5 text-fg-3 no-underline hover:bg-surface-2 hover:text-fg"
        >
          <ArrowLeft size={16} />
        </Link>
        <MapIcon size={16} className="text-fg-3" />
        <h1 className="text-base font-medium text-fg">Learning maps</h1>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-12 pt-5">
        <form onSubmit={submit} className="flex items-center gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="New map name"
            aria-label="New map name"
            className="min-w-0 flex-1 rounded-sm border border-line-2 bg-surface px-2.5 py-2 text-[13px] text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={!name.trim() || creating}
            className="inline-flex items-center gap-1.5 rounded-sm px-2.5 py-2 text-[13px] font-medium text-accent hover:bg-accent-soft disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Open
          </button>
        </form>
        <p className="mt-1.5 text-xs text-fg-3">
          Names are unique — an existing name opens that map rather than making a second one.
        </p>

        {error ? (
          <p className="mt-3 rounded-md border border-line bg-[rgb(var(--color-rose-rgb)/0.1)] px-3 py-2 text-sm text-rose-300">
            {error}
          </p>
        ) : null}

        {!loaded ? (
          <div className="flex items-center gap-2 pt-6 text-sm text-fg-2">
            <Loader2 size={15} className="animate-spin text-accent" /> Loading maps
          </div>
        ) : null}

        {loaded && maps.length === 0 && !error ? (
          <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm text-fg-2">
            No maps yet. Name one above, or let a session create one by posting to{' '}
            <code className="font-mono text-[12px]">/api/km/maps</code>.
          </p>
        ) : null}

        {maps.length > 0 ? (
          <ul className="mt-5 flex list-none flex-col gap-1.5 p-0">
            {maps.map((map) => (
              <li key={map.id}>
                <Link
                  to={`/map/${encodeURIComponent(map.id)}`}
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 no-underline hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                    {map.name}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-fg-3">
                    {map.article_count} {map.article_count === 1 ? 'node' : 'nodes'}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-fg-3">
                    {formatCreated(map.created_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </div>
  );
}
