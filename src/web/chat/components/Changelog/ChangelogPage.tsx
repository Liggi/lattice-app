import { Link } from 'react-router-dom';
import {
  changelogMilestones,
  changelogStart,
  changelogVersionLedger,
} from '@/web/chat/changelog/changelog-data';

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function ChangelogPage(): JSX.Element {
  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-3xl px-3 pb-8 pt-4 sm:px-6 sm:pb-12 sm:pt-6">
        <header className="sticky top-0 z-10 mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-bg px-3 py-3 sm:mb-8 sm:px-4">
          <div>
            <p className="text-xs text-fg-3">
              Lattice Orchestrator
            </p>
            <h1 className="mt-1 text-base font-medium text-fg">
              Changelog
            </h1>
          </div>
          <Link
            to="/"
            className="inline-flex items-center rounded-sm px-3 py-2 text-[13px] font-medium text-accent no-underline transition-colors hover:bg-accent-soft"
          >
            Open app
          </Link>
        </header>

        <section className="rounded-lg border border-line bg-surface p-4 sm:p-5">
          <p className="text-xs font-medium text-fg-2">
            Timeline start
          </p>
          <p className="mt-2 text-sm font-medium text-fg">
            {changelogStart.title}
          </p>
          <p className="mt-1 text-[13px] text-fg-2">{changelogStart.summary}</p>
          <p className="mt-3 text-xs tabular-nums text-fg-3">
            {formatDate(changelogStart.date)} baseline
          </p>
        </section>

        <section className="mt-6 sm:mt-8">
          <p className="mb-3 text-xs font-medium text-fg-2">
            Release milestones
          </p>
          <ol className="space-y-3 sm:space-y-4">
            {changelogMilestones.map((release) => (
              <li key={release.version} className="rounded-lg border border-line bg-surface p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-mono text-xs tabular-nums text-fg-2">
                    {release.version}
                  </p>
                  <p className="text-xs tabular-nums text-fg-3">
                    {formatDate(release.date)}
                  </p>
                </div>
                <h2 className="mt-2 text-sm font-medium text-fg">
                  {release.title}
                </h2>
                <p className="mt-1 text-[13px] text-fg-2">{release.summary}</p>
                <ul className="mt-3 space-y-2">
                  {release.highlights.map((highlight) => (
                    <li key={highlight} className="flex items-start gap-2 text-[13px] text-fg-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-line-2" />
                      <span className="break-words">{highlight}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-6 sm:mt-8">
          <p className="mb-3 text-xs font-medium text-fg-2">
            Version ledger
          </p>
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-3 py-2 text-xs text-fg-3 sm:px-4">
              Version-by-version history from baseline to current release.
            </div>
            <ul className="max-h-[56vh] divide-y divide-line overflow-y-auto sm:max-h-[62vh]">
              {changelogVersionLedger.map((entry) => (
                <li key={entry.version} className="px-3 py-3 sm:px-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-mono text-xs tabular-nums text-fg-2">
                      {entry.version}
                    </p>
                    <p className="text-xs tabular-nums text-fg-3">
                      {formatDate(entry.date)}
                    </p>
                  </div>
                  <p className="mt-1 break-words text-[13px] text-fg-2">{entry.summary}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
