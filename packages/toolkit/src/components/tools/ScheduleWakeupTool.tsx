import React, { useState } from 'react';
import { AlarmClock } from 'lucide-react';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { cn } from '../../utils/cn.js';
import { tk, accent } from '../../tokens.js';

interface ScheduleWakeupInput {
  delaySeconds?: number;
  prompt?: string;
  reason?: string;
}

interface ScheduleWakeupToolProps {
  input: ScheduleWakeupInput;
  result: string;
  isPending?: boolean;
}

function formatDelay(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (seconds < 3600) return secs ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(seconds / 3600);
  const remMins = Math.round((seconds % 3600) / 60);
  return remMins ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

// Pull "HH:MM:SS" out of the result string "Next wakeup scheduled for 20:27:00 (in 120s)."
function parseScheduledAt(result: string): string | null {
  const m = result.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  return m ? m[1] : null;
}

export function ScheduleWakeupTool({ input, result, isPending = false }: ScheduleWakeupToolProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);

  const delay = input?.delaySeconds ?? 0;
  const reason = (input?.reason ?? '').trim();
  const prompt = (input?.prompt ?? '').trim();
  const scheduledAt = parseScheduledAt(result);
  const delayLabel = formatDelay(delay);

  const summaryParts: string[] = [];
  if (scheduledAt && delayLabel) summaryParts.push(`${scheduledAt} (in ${delayLabel})`);
  else if (scheduledAt) summaryParts.push(scheduledAt);
  else if (delayLabel) summaryParts.push(`in ${delayLabel}`);
  if (reason) summaryParts.push(reason);
  const headerSummary = summaryParts.join(' — ');

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardClassName={accent.amber.card}
      headerContent={(
        <>
          <div className="flex items-center gap-2 flex-shrink-0">
            <AlarmClock size={14} className={`${accent.amber.icon} flex-shrink-0`} />
            <span className={`text-xs ${tk.text.muted}`}>Wakeup</span>
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>
            {isPending ? 'scheduling…' : (headerSummary || 'scheduled')}
          </span>
        </>
      )}
      content={(
        <>
          {(reason || delayLabel || scheduledAt) && (
            <div className={cn('border-t px-3 py-2 text-[13px] flex flex-col gap-0.5', tk.separator, tk.codeBgSubtle)}>
              {scheduledAt && (
                <div className={tk.text.secondary}>
                  <span className={`mr-2 ${tk.text.muted}`}>Fires at</span>
                  <span className={tk.text.primary}>{scheduledAt}</span>
                  {delayLabel && <span className={`ml-1 ${tk.text.muted}`}>(in {delayLabel})</span>}
                </div>
              )}
              {!scheduledAt && delayLabel && (
                <div className={tk.text.secondary}>
                  <span className={`mr-2 ${tk.text.muted}`}>Delay</span>
                  <span className={tk.text.primary}>{delayLabel}</span>
                </div>
              )}
              {reason && (
                <div className={tk.text.secondary}>
                  <span className={`mr-2 ${tk.text.muted}`}>Reason</span>
                  <span className={tk.text.primary}>{reason}</span>
                </div>
              )}
            </div>
          )}
          {prompt && (
            <div className={cn('border-t px-3 py-2.5', tk.separator, tk.codeBg)}>
              <div className={`text-xs font-medium mb-1 ${tk.text.faint}`}>Prompt</div>
              <pre className={cn('m-0 font-mono text-[13px] whitespace-pre-wrap break-words leading-relaxed', tk.text.primary)}>
                {prompt}
              </pre>
            </div>
          )}
        </>
      )}
    />
  );
}
