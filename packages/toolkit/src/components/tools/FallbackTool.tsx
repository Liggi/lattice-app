import React, { useState } from 'react';
import { CircleStop, Clock, Users, Wrench } from 'lucide-react';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { parseJson } from '../../utils/json.js';
import { cn } from '../../utils/cn.js';
import { tk } from '../../tokens.js';

interface FallbackToolProps {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
}

/**
 * Tools without a card of their own. They start closed with a one-line summary, and
 * open to labelled values rather than JSON. The few built-in tools seen often enough
 * to matter (scheduling, stopping a task, listing peers) get their own wording.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: string) => n.padStart(2, '0');

/** "23 8 25 9 *" → "Sep 25 08:23"; "0 9 * * *" → "daily at 09:00"; otherwise the expression. */
export function describeCron(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [m, h, dom, mon, dow] = f;
  const num = (v: string) => /^\d+$/.test(v);
  if (num(m) && num(h) && num(dom) && num(mon)) return `${MONTHS[Number(mon) - 1] ?? mon} ${Number(dom)} ${pad(h)}:${pad(m)}`;
  if (num(m) && num(h) && dom === '*' && mon === '*' && dow === '*') return `daily at ${pad(h)}:${pad(m)}`;
  if (num(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `hourly at :${pad(m)}`;
  return cron;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function asRecord(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = parseJson(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

interface Shape {
  icon: typeof Wrench;
  label: string;
  summary?: string;
  /** Replaces the default body; undefined keeps it. */
  body?: React.ReactNode;
  /** Input keys already said by the header or body. */
  skip?: string[];
}

function Prose({ text, mono }: { text: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className={cn('px-3 py-2.5 whitespace-pre-wrap break-words leading-relaxed', mono ? 'font-mono text-[12px]' : 'text-[13px]', tk.text.secondary)}>
      {text}
    </div>
  );
}

function shapeFor(toolName: string, input: Record<string, unknown>, result: string, record: Record<string, unknown> | null): Shape {
  const firstLine = result.split('\n').find((l) => l.trim())?.trim();
  switch (toolName) {
    case 'CronCreate': {
      const cron = str(input.cron) ?? '';
      const once = input.recurring === false || /one-shot/i.test(result);
      const when = describeCron(cron);
      const prompt = str(input.prompt);
      return {
        icon: Clock,
        label: 'Scheduled',
        summary: once ? `once, ${when}` : when === cron ? `on ${cron}` : when,
        body: prompt ? <Prose text={prompt} /> : undefined,
        skip: ['cron', 'recurring', 'prompt'],
      };
    }
    case 'CronDelete': return { icon: Clock, label: 'Cancelled scheduled task', summary: str(input.id), skip: ['id'] };
    case 'CronList': return { icon: Clock, label: 'Scheduled tasks', summary: /^No scheduled jobs/i.test(result) ? 'none' : undefined };
    case 'TaskStop': {
      const command = str(record?.command);
      return {
        icon: CircleStop,
        label: 'Stopped',
        summary: command?.split('\n')[0] ?? str(input.task_id),
        body: command ? <Prose text={command} mono /> : undefined,
        skip: ['task_id'],
      };
    }
    case 'ListAgents': {
      const peers = result.match(/Peer sessions \((\d+)\)/)?.[1];
      return { icon: Users, label: 'Listed peer sessions', summary: peers ? `${peers} running` : undefined, body: result ? <Prose text={result.trim()} mono /> : undefined };
    }
    default:
      return { icon: Wrench, label: toolName, summary: str(record?.message)?.split('\n')[0] ?? firstLine };
  }
}

function humanKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
}

function valueText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, 2);
}

/** Key/value pairs as a small two-column list. */
function Fields({ values }: { values: [string, unknown][] }): React.JSX.Element | null {
  const rows = values.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!rows.length) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2.5 text-[13px] leading-relaxed">
      {rows.map(([k, v]) => {
        const text = valueText(v);
        const structured = typeof v === 'object';
        return (
          <React.Fragment key={k}>
            <dt className={cn('text-xs pt-px', tk.text.muted)}>{humanKey(k)}</dt>
            <dd className={cn('m-0 min-w-0 whitespace-pre-wrap break-words', structured && 'font-mono text-[12px]', tk.text.secondary)}>{text}</dd>
          </React.Fragment>
        );
      })}
    </dl>
  );
}

export function FallbackTool({ toolName, input, result }: FallbackToolProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const record = asRecord(result ?? '');
  const shape = shapeFor(toolName, input ?? {}, result ?? '', record);
  const Icon = shape.icon;

  const inputRows = Object.entries(input ?? {}).filter(([k]) => !shape.skip?.includes(k));
  const resultBody = shape.body !== undefined
    ? shape.body
    : record
      ? <Fields values={Object.entries(record)} />
      : result?.trim() && result.trim() !== shape.summary ? <Prose text={result.trim()} /> : null;
  const inputBody = inputRows.length ? <Fields values={inputRows} /> : null;
  const hasBody = !!(resultBody || inputBody);

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      canExpand={hasBody}
      headerContent={(
        <>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Icon size={14} className={cn(tk.text.muted, 'flex-shrink-0')} />
            <span className={cn('text-xs', tk.text.secondary)}>{shape.label}</span>
          </div>
          {shape.summary && <span className={cn('text-xs truncate flex-1 min-w-0', tk.text.muted)}>{shape.summary}</span>}
        </>
      )}
      content={hasBody ? (
        <div className={cn('border-t', tk.separator)}>
          {resultBody}
          {resultBody && inputBody && <div className={cn('border-t', tk.separator)} />}
          {inputBody}
        </div>
      ) : undefined}
    />
  );
}
