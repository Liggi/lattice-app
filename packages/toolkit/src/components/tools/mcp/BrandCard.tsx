import React, { useEffect, useRef, useState } from 'react';
import { CollapsibleToolCard } from '../../CollapsibleToolCard.js';
import { cn } from '../../../utils/cn.js';
import { tk } from '../../../tokens.js';
import type { Brand } from './brand.js';

/**
 * The skeleton every brand card shares, so Slack, Notion and Linear cards read as one
 * family even though their bodies differ: brand mark, action, what was asked, what came
 * back, then a body tinted with the brand accent.
 */

interface BrandCardProps {
  brand: Brand;
  /** Tool action, already stripped of its server prefix. */
  action: string;
  /** What the call asked for. Truncates before the result summary does. */
  args?: string;
  /** What came back. Given priority over args when space is tight. */
  summary?: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
}

export function BrandCard({
  brand,
  action,
  args,
  summary,
  children,
  defaultExpanded = true,
}: BrandCardProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const a = brand.accent;
  const aDark = brand.accentDark ?? brand.accent;

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardStyle={{ borderColor: `${aDark}26` }}
      headerContent={(
        <>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Two marks rather than a runtime theme read: the dark: variant does the switch. */}
            <span style={{ color: a }} className="flex items-center dark:hidden">
              <brand.Mark size={13} />
            </span>
            <span style={{ color: aDark }} className="hidden dark:flex items-center">
              <brand.Mark size={13} />
            </span>
            <span className={`text-xs ${tk.text.muted}`}>{action}</span>
          </div>
          {args && (
            <span className={`text-xs ${tk.text.secondary} truncate min-w-0`} style={{ maxWidth: '32%' }}>
              {args}
            </span>
          )}
          {summary && (
            <span className={`text-xs ${tk.text.secondary} truncate flex-1 min-w-0`}>
              <span className={`mr-1 ${tk.text.faint}`}>→</span>
              {summary}
            </span>
          )}
        </>
      )}
      content={<CappedBody>{children}</CappedBody>}
    />
  );
}

/** How tall a card opens before the rest is folded behind "show the rest". */
const CAP_PX = 520;
const FADE = 'linear-gradient(to bottom, black calc(100% - 48px), transparent)';

/**
 * Keeps an open card from taking over the thread. Content taller than the cap is cut
 * at the cap with a fade, and a button beneath says so and opens the rest.
 */
function CappedBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > CAP_PX + 40);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const capped = overflows && !open;
  return (
    <div className={`border-t ${tk.separator}`}>
      <div ref={ref} className="overflow-hidden" style={capped ? { maxHeight: CAP_PX, maskImage: FADE, WebkitMaskImage: FADE } : undefined}>
        {children}
      </div>
      {capped && (
        <button
          onClick={() => setOpen(true)}
          className={cn('w-full px-3 py-1.5 text-left text-[11px] border-t', tk.separator, tk.text.muted, tk.hover)}
        >
          show the rest of this result
        </button>
      )}
    </div>
  );
}

/** Shared "there is more" affordance — always names what is being held back. */
export function ShowMore({
  hidden,
  unit,
  onClick,
}: {
  hidden: number | string;
  unit: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn('w-full px-3 py-1.5 text-left text-[11px] border-t', tk.separator, tk.text.muted, tk.hover)}
    >
      show {typeof hidden === 'number' ? hidden.toLocaleString() : hidden} more {unit}
    </button>
  );
}

/** A deterministic avatar colour from a name, for products that return no avatar URL. */
export function initialsColor(name: string): string {
  const PALETTE = ['#E01E5A', '#36C5F0', '#2EB67D', '#ECB22E', '#9065B0', '#337EA9', '#D9730D', '#448361'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function Avatar({ name, url, size = 20 }: { name: string; url?: string; size?: number }): React.JSX.Element {
  const initials = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  if (url) {
    return (
      <img
        src={url}
        alt={name}
        width={size}
        height={size}
        className="rounded flex-shrink-0 object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      className="inline-flex items-center justify-center rounded flex-shrink-0 font-medium text-white"
      style={{ width: size, height: size, backgroundColor: initialsColor(name), fontSize: size * 0.42 }}
      title={name}
    >
      {initials || '?'}
    </span>
  );
}
