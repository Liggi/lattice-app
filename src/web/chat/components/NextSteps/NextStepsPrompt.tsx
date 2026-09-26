import React, { useCallback, useRef } from 'react';
import {
  ArrowRight,
  FileCode,
  FlaskConical,
  GitBranch,
  GitCommit,
  ListChecks,
  Play,
  RefreshCw,
  Rocket,
  Search,
  Sparkles,
  TestTube,
  Wrench,
  X,
  type LucideProps,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import type { NextStepProposal } from '../../types';

interface NextStepsPromptProps {
  steps: NextStepProposal[];
  onSelect: (prompt: string) => void;
  onDismiss?: () => void;
}

type IconComponent = React.ComponentType<LucideProps>;

const NEXT_STEP_ICONS: Record<string, IconComponent> = {
  ArrowRight,
  FileCode,
  FlaskConical,
  GitBranch,
  GitCommit,
  ListChecks,
  Play,
  RefreshCw,
  Rocket,
  Search,
  Sparkles,
  TestTube,
  Wrench,
};

// Map icon name to an explicitly supported Lucide icon.
// Unknown names safely render without an icon rather than pulling the full icon package.
function getIcon(iconName?: string): IconComponent | null {
  if (!iconName) return null;

  const normalized = iconName.replace(/Icon$/, '');
  return NEXT_STEP_ICONS[normalized] ?? null;
}

/**
 * Pill button that handles both click and touch reliably.
 * On mobile, onClick can be flaky due to 300ms delay, scroll interference,
 * or hover-transform styles. This component uses onTouchEnd as the primary
 * handler on touch devices, preventing the duplicate onClick.
 */
type PillButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  onTap: () => void;
};

const PillButton = React.forwardRef<HTMLButtonElement, PillButtonProps>(
  function PillButton({ onTap, className, children, onClick: externalOnClick, ...rest }, ref) {
    const touchedRef = useRef(false);

    const handleTouchEnd = useCallback((e: React.TouchEvent) => {
      e.preventDefault(); // Prevent ghost click
      touchedRef.current = true;
      onTap();
      // Reset after a tick so subsequent clicks on desktop still work
      setTimeout(() => { touchedRef.current = false; }, 300);
    }, [onTap]);

    const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
      // Skip if this was already handled by touch
      if (touchedRef.current) return;
      onTap();
      // Also fire Radix's onClick passed via asChild spread
      externalOnClick?.(e);
    }, [onTap, externalOnClick]);

    return (
      <button
        ref={ref}
        {...rest}
        onClick={handleClick}
        onTouchEnd={handleTouchEnd}
        className={className}
        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
      >
        {children}
      </button>
    );
  }
);

/**
 * Shows the full prompt text that will be sent when the pill is clicked.
 */
function StyledTooltip({ content, children }: { content: string; children: React.ReactNode }) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        {children}
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        label="Prompt"
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Displays proposed next steps as a quiet row of chips above the composer.
 * Touch targets are 44px+ for reliable mobile taps.
 */
export function NextStepsPrompt({ steps, onSelect, onDismiss }: NextStepsPromptProps): JSX.Element {
  if (steps.length === 0) {
    return <></>;
  }

  return (
    <TooltipProvider>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-fg-3">
          Next
        </span>
        {steps.map((step) => {
          const Icon = getIcon(step.icon);
          const tooltipText = step.description || step.prompt;
          return (
            <StyledTooltip key={`${step.prompt}-${step.label}`} content={tooltipText}>
              <PillButton
                onTap={() => onSelect(step.prompt)}
                className="flex items-center gap-2 px-3 py-2.5 min-h-[44px] rounded-md
                           bg-surface border border-line-2
                           text-fg text-[13px]
                           hover:bg-surface-2 active:bg-line-2
                           transition-colors duration-100 cursor-pointer select-none"
              >
                {Icon && <Icon size={14} />}
                <span>{step.label}</span>
              </PillButton>
            </StyledTooltip>
          );
        })}
        {onDismiss && (
          <StyledTooltip content="Dismiss suggestions">
            <PillButton
              onTap={onDismiss}
              className="p-2.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md
                         bg-surface border border-line-2
                         text-fg-3
                         hover:bg-surface-2 hover:text-fg active:bg-line-2
                         transition-colors duration-100 cursor-pointer select-none"
            >
              <X size={14} />
            </PillButton>
          </StyledTooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
