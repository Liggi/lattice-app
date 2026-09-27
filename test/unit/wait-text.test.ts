import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WaitText } from '../../src/web/chat/components/InsightsPanel/WaitText';
import { TooltipProvider } from '../../src/web/chat/components/ui/tooltip';

/**
 * 2026-09-27: worker cards read "Waiting on conv-CYr0hqzWOxrh's hover shot".
 * A conversation id in a wait reads as who it is, never as the raw id.
 */
const workers = [
  { worker: 'conv-CYr0hqzWOxrh', task: 'Story layer', archived: false },
  { worker: 'conv-dmb6Tx5KWJ3d', task: 'Spread moments', archived: false },
  { worker: 'conv-dmb6Zz9aaaaa', task: 'Another', archived: true },
];

function text(wait: string): string {
  const html = renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(WaitText, { text: wait, workers, coordinatorId: 'conv-g2gNFpM2gZnW' })),
  );
  return html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");
}

describe('a wait names other sessions readably', () => {
  it('reads a worker on this project as "a worker", keeping the possessive', () => {
    expect(text("conv-CYr0hqzWOxrh's hover shot of the next moment")).toBe("a worker's hover shot of the next moment");
    expect(text('conv-CYr0hqzWOxrh to install 2c421c1 at the next restart')).toBe('a worker to install 2c421c1 at the next restart');
  });

  it('reads a short prefix of exactly one worker id as that worker', () => {
    expect(text("CYr0's next restart using `rig restart`")).toBe("a worker's next restart using `rig restart`");
    expect(text('conv-CYr0 to finish')).toBe('a worker to finish');
    // Ambiguous, too short, the wrong case, or inside a longer word: left as written.
    expect(text('dmb6 to finish')).toBe('dmb6 to finish');
    expect(text('CYr to finish')).toBe('CYr to finish');
    expect(text('cyr0 to finish')).toBe('cyr0 to finish');
    expect(text('xCYr0 to finish')).toBe('xCYr0 to finish');
  });

  it('reads the coordinator and any other session without inventing a name', () => {
    expect(text('conv-g2gNFpM2gZnW to decide.')).toBe('the coordinator to decide.');
    expect(text("conv-6oq_0-6obCtu's review")).toBe("another session's review");
  });
});
