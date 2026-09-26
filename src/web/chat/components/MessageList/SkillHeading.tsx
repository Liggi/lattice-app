import React, { createContext, useContext, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

/** The conversation the thread belongs to, so a skill can be looked up in that project's own `.claude/skills`. */
export const SkillConversationContext = createContext<string | undefined>(undefined);

interface SkillDescription {
  name: string;
  summary: string | null;
  description: string | null;
}

async function fetchSkillDescription(name: string, conversationId: string | undefined): Promise<SkillDescription> {
  const params = new URLSearchParams({ name });
  if (conversationId) params.set('conversationId', conversationId);
  const response = await fetch(`/api/skills/describe?${params}`);
  if (!response.ok) throw new Error(`skills/describe ${response.status}`);
  return response.json() as Promise<SkillDescription>;
}

const rule = 'h-px bg-line flex-shrink-0';

/** Backticked spans in a SKILL.md description, shown as code rather than as literal backticks. */
function InlineCode({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith('`') && part.endsWith('`') && part.length > 2
        ? <span key={i} className="font-mono text-[11.5px] text-fg-2">{part.slice(1, -1)}</span>
        : <React.Fragment key={i}>{part}</React.Fragment>))}
    </>
  );
}

/**
 * Where a skill starts: a thin full-width line carrying the skill's name, with
 * what it is for beneath. There is no closing line: Claude does not mark where
 * a skill ends. Opens to what the agent asked of it and the whole description.
 */
export function SkillHeading({ skill, args }: { skill: string; args: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const conversationId = useContext(SkillConversationContext);
  const { data } = useQuery({
    queryKey: ['skill-describe', skill, conversationId ?? ''],
    queryFn: () => fetchSkillDescription(skill, conversationId),
    staleTime: Infinity,
    retry: false,
  });
  const canOpen = args.length > 0 || Boolean(data?.description);

  return (
    <div data-testid="skill-heading" className="pt-2">
      <button
        type="button"
        onClick={() => canOpen && setOpen((v) => !v)}
        aria-expanded={canOpen ? open : undefined}
        className={`block w-full text-left ${canOpen ? 'cursor-pointer group' : 'cursor-default'}`}
      >
        <span className="flex items-center gap-2">
          <span className={`${rule} w-3`} />
          <BookOpen size={13} className="flex-shrink-0 text-cyan-600 dark:text-cyan-400/80" />
          <span className="text-[13px] font-medium text-fg">{skill}</span>
          <span className={`${rule} flex-1`} />
        </span>
        {data?.summary && (
          <span className="mt-0.5 block pl-[41px] text-[12.5px] leading-snug text-fg-3 group-hover:text-fg-2 transition-colors">
            <InlineCode text={data.summary} />
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 pl-[41px] space-y-1.5 text-[13px] leading-relaxed text-fg-2">
          {args && <p className="whitespace-pre-wrap break-words">{args}</p>}
          {data?.description && <p className="text-fg-3 break-words"><InlineCode text={data.description} /></p>}
        </div>
      )}
    </div>
  );
}
