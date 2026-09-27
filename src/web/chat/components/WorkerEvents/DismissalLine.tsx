/**
 * The user dismissed one of the project's threads from the panel, or brought
 * one back: one quiet line in the coordinator's thread, in the shape of the
 * worker event lines around it. The coordinator was told in an attributed
 * line of its own (`thread-dismissal.ts`); this is what the user sees of it.
 */

import React from 'react';
import { CirclePause, Undo2 } from 'lucide-react';
import type { ChatMessage } from '../../types';

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function DismissalLine({ message }: { message: ChatMessage }): JSX.Element | null {
  const dismissal = message.dismissal;
  if (!dismissal) return null;
  const dismissed = dismissal.action === 'dismissed';
  const Icon = dismissed ? CirclePause : Undo2;
  const time = formatTime(message.timestamp);
  return (
    <div data-testid="thread-dismissal" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-fg-2">
      <Icon size={14} className="shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1 leading-[1.4]">
        <span className="font-medium text-fg">{dismissed ? 'You dismissed' : 'You brought back'}</span>
        <span> · {dismissal.label}</span>
        <span className="ml-2 text-fg-3">{dismissed ? 'Parked; the coordinator was told' : 'The coordinator was told'}</span>
      </span>
      {time && <span className="shrink-0 text-xs text-fg-3">{time}</span>}
    </div>
  );
}
