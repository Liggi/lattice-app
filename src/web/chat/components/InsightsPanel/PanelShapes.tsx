/**
 * The project panel's two shape sections: Track, the project's threads as a
 * step chain, and Outputs, the screenshots and pull requests the
 * conversation has produced. Both draw nothing when they have nothing.
 */

import { type JSX, useState } from 'react';
import { GitPullRequest, Link2 } from 'lucide-react';
import { StateGlyph } from '../shared/StateGlyph';
import { ViewableImage } from '../MessageList/ImageViewer';
import { localImageUrl } from '../MessageList/MessageItem';
import { Section } from './NarrowPanel';
import type { TrackStep } from './project-track';
import { outputCaptionLabels, type ProjectOutputs } from './project-outputs';

export function TrackSection({ steps }: { steps: TrackStep[] }): JSX.Element | null {
  if (steps.length === 0) return null;
  return (
    <Section title="Track" testId="panel-track">
      <ol className="flex flex-col">
        {steps.map((step, index) => (
          <li key={step.seq} data-track-state={step.state} title={step.detail} className="relative flex items-start gap-2.5 px-2 py-[7px]">
            {index < steps.length - 1 && (
              <span aria-hidden className="absolute left-[21.5px] top-[27px] bottom-[-7px] w-px bg-line-2" />
            )}
            <span className="flex h-[20px] w-7 shrink-0 items-center justify-center">
              <StateGlyph
                kind={step.state}
                size={15}
                className={step.state === 'progress' ? 'text-fg' : step.state === 'done' || step.state === 'waiting' ? 'text-fg-3' : 'text-fg-3/70'}
              />
            </span>
            <span className={`min-w-0 flex-1 break-words text-[13.5px] leading-[20px] ${
              step.state === 'progress' ? 'font-medium text-fg' : step.state === 'done' || step.state === 'waiting' ? 'text-fg-2' : 'text-fg-3'
            }`}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function OutputsSection({ outputs, excludeHrefs }: { outputs: ProjectOutputs | null; excludeHrefs?: ReadonlySet<string> }): JSX.Element | null {
  const links = outputs?.links.filter((link) => !excludeHrefs?.has(link.href)) ?? [];
  // A screenshot whose file has gone (a cleared /tmp) is dropped, not drawn as a broken tile.
  const [failedPaths, setFailedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const images = (outputs?.images ?? []).filter((image) => !failedPaths.has(image.path));
  if (images.length === 0 && links.length === 0) return null;
  const labels = outputCaptionLabels(images);
  const markFailed = (p: string) => setFailedPaths((prev) => (prev.has(p) ? prev : new Set(prev).add(p)));
  return (
    <Section title="Outputs" testId="panel-outputs">
      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5 px-2 pl-[46px] pb-1">
          {images.map((image, index) => {
            const url = localImageUrl(image.path, image.messageId);
            const label = labels[index];
            return (
              <figure key={image.path} className="m-0 min-w-0">
                <ViewableImage src={url} alt={image.caption || 'Screenshot'} className="block w-full cursor-zoom-in">
                  <span className="block aspect-[16/10] overflow-hidden rounded-md border border-line bg-surface hover:border-line-2">
                    <img src={url} alt={image.caption || 'Screenshot'} loading="lazy" onError={() => markFailed(image.path)} className="h-full w-full object-cover object-top" />
                  </span>
                </ViewableImage>
                {label && (
                  <figcaption title={image.caption} className="truncate pt-1.5 text-[12px] leading-snug text-fg-3">
                    {label}
                  </figcaption>
                )}
              </figure>
            );
          })}
        </div>
      )}
      {links.map((link) => (
        <a
          key={link.href}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="panel-output-link"
          className="flex items-start gap-2.5 rounded-sm px-2 py-1.5 text-[13.5px] leading-[1.45] no-underline hover:bg-surface-2"
        >
          <span className="flex h-[19px] w-7 shrink-0 items-center justify-center text-fg-3">
            {link.kind === 'pr' ? <GitPullRequest size={15} /> : <Link2 size={15} />}
          </span>
          <span className="min-w-0 flex-1 break-words">
            <span className="tabular-nums text-fg-3">{link.label}</span>
            {link.title && <span className="ml-1.5 text-fg-2">{link.title}</span>}
          </span>
        </a>
      ))}
    </Section>
  );
}
