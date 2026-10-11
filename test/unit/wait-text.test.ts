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
  { worker: 'conv-RFO_uvBVLWKT', task: 'Install the playset on the PC, boot it, check paragons, pictures, ruler names and portraits', archived: false },
  { worker: 'conv-dmb6Tx5KWJ3d', task: 'Spread moments', archived: false },
  { worker: 'conv-dmb6Zz9aaaaa', task: 'Another', archived: true },
];

const references = {
  'conv-6oq_0-6obCtu': { found: true, name: 'Lattice restyle', project: null },
  'conv-Zn6WG5gd2orJ': { found: true, name: 'Check the coalition truce on the PC, then Jason reads draft 2', project: "Jason's Stellaris" },
  'conv-RFOuvBVLWKT': { found: false, name: null, project: null },
};

function text(wait: string): string {
  const html = renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(WaitText, { text: wait, workers, references, coordinatorId: 'conv-g2gNFpM2gZnW' })),
  );
  return html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");
}

describe('a wait names other sessions readably', () => {
  it('reads a worker on this project by its task when short, else as "a worker", keeping the possessive', () => {
    expect(text("conv-CYr0hqzWOxrh's hover shot of the next moment")).toBe("Story layer's hover shot of the next moment");
    expect(text('conv-RFO_uvBVLWKT to install 2c421c1 at the next restart')).toBe('a worker to install 2c421c1 at the next restart');
  });

  // 2026-10-11: "the playset worker (another session)" read oddly.
  it('drops a bracketed id after words that already name the session', () => {
    expect(text('the playset worker (conv-RFO_uvBVLWKT) to finish on the gaming PC')).toBe('the playset worker to finish on the gaming PC');
    expect(text('a reply from (conv-CYr0hqzWOxrh) first')).toBe('a reply from (Story layer) first');
  });

  it('reads a short prefix of exactly one worker id as that worker', () => {
    expect(text("CYr0's next restart using `rig restart`")).toBe("Story layer's next restart using `rig restart`");
    expect(text('conv-CYr0 to finish')).toBe('Story layer to finish');
    // Ambiguous, too short, the wrong case, or inside a longer word: left as written.
    expect(text('dmb6 to finish')).toBe('dmb6 to finish');
    expect(text('CYr0 to finish')).toBe('Story layer to finish');
    expect(text('CYr to finish')).toBe('CYr to finish');
    expect(text('cyr0 to finish')).toBe('cyr0 to finish');
    expect(text('xCYr0 to finish')).toBe('xCYr0 to finish');
  });

  it('reads the coordinator and any other session by what the server calls it, never its id', () => {
    expect(text('conv-g2gNFpM2gZnW to decide.')).toBe('the coordinator to decide.');
    expect(text("conv-6oq_0-6obCtu's review")).toBe("Lattice restyle's review");
    expect(text('conv-Zn6WG5gd2orJ to finish')).toBe("a session in Jason's Stellaris to finish");
    expect(text('conv-RFOuvBVLWKT to finish')).toBe('an unknown session to finish');
    // Not yet answered for: nothing invented.
    expect(text('conv-unansweredXY to finish')).toBe('another session to finish');
  });
});
