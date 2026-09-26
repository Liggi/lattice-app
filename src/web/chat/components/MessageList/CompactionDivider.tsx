interface CompactionDividerProps {
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  costUsd?: number;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}K`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function CompactionDivider({
  trigger,
  preTokens,
  postTokens,
  durationMs,
  costUsd,
}: CompactionDividerProps): JSX.Element {
  const details: string[] = [];
  if (trigger === 'manual') details.push('Manual');
  if (typeof preTokens === 'number' && typeof postTokens === 'number') {
    details.push(`${formatTokens(preTokens)} → ${formatTokens(postTokens)}`);
  }
  if (typeof durationMs === 'number') details.push(formatDuration(durationMs));
  if (typeof costUsd === 'number') details.push(`$${costUsd.toFixed(2)}`);

  return (
    <div data-testid="compaction-divider" className="flex items-center gap-3 my-4 px-4 text-[12.5px] text-fg-3 before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
      <span className="text-center">
        Context Compacted{details.length > 0 ? ` · ${details.join(' · ')}` : ''}
      </span>
    </div>
  );
}
