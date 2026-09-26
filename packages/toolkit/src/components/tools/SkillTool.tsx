import React, { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { cn } from '../../utils/cn.js';
import { tk } from '../../tokens.js';

interface SkillToolProps {
  input: { skill?: unknown; args?: unknown };
  isPending?: boolean;
}

const skillIcon = 'text-cyan-600 dark:text-cyan-400/80';

function ArgsBody({ args }: { args: string }): React.JSX.Element {
  return (
    <div className={cn('border-t px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words', tk.separator, tk.text.secondary)}>
      {args}
    </div>
  );
}

/** A skill launch: rarer than a tool call, so a faint cyan surface lifts it above the tool rows around it. */
export function SkillTool({ input, isPending }: SkillToolProps): React.JSX.Element {
  const skill = typeof input?.skill === 'string' ? input.skill : 'skill';
  const args = typeof input?.args === 'string' ? input.args.trim() : '';
  const [isExpanded, setIsExpanded] = useState(false);
  const verb = isPending ? 'Using' : 'Used';

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      canExpand={args.length > 0}
      cardClassName="border-cyan-600/30 bg-cyan-500/[0.07] dark:border-cyan-400/25 dark:bg-cyan-400/[0.06]"
      headerContent={(
        <>
          <BookOpen size={14} className={cn(skillIcon, 'flex-shrink-0')} />
          <span className={cn('text-xs', tk.text.muted)}>{verb} skill</span>
          <span className={cn('text-[13px] font-medium truncate', tk.text.primary)}>{skill}</span>
        </>
      )}
      content={args ? <ArgsBody args={args} /> : undefined}
    />
  );
}
