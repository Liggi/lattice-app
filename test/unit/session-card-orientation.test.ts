/**
 * The card's "what is this doing" line has two possible sources and they
 * disagree. Insights freeze a mission near session start; Argus rescans on every
 * turn-end. The observed failure this ranking fixes: a game-modding session whose
 * insight text still read "Establish experimental methodology for mechanics
 * study" three hours into actually running an overnight batch, which Argus
 * described as "Building an unattended batch orchestrator in runs/corpus/ ...
 * now executing the overnight shakedown run".
 */

import { describe, expect, it } from 'vitest';
import { resolveCardOrientation } from '@/web/chat/components/shared/session-card-orientation';
import type { AmbientRead, ArrowKind } from '@/web/chat/components/AmbientPortfolio/ambient-types';

function read(overrides: Partial<AmbientRead> = {}): AmbientRead {
  return {
    sessionId: 'conv-test',
    context: 'Running the overnight shakedown batch.',
    arrow: { kind: 'waiting-on', text: 'the overnight shakedown run to finish' },
    portfolio: 'modding',
    workArea: 'batch orchestrator',
    mode: 'operating',
    deliverable: 'ships',
    snag: null,
    markers: [],
    flag: null,
    flagLine: null,
    evidence: [],
    ...overrides,
  };
}

describe('resolveCardOrientation — description', () => {
  it('prefers the ambient read over the frozen mission', () => {
    const { description } = resolveCardOrientation({
      ambientRead: read(),
      mission: 'Establish experimental methodology for mechanics study',
    });

    expect(description).toEqual({ text: 'Running the overnight shakedown batch.', source: 'ambient' });
  });

  it('falls back to the mission when there is no read', () => {
    const { description } = resolveCardOrientation({ ambientRead: null, mission: 'Ship the sidebar rework' });
    expect(description).toEqual({ text: 'Ship the sidebar rework', source: 'insights' });
  });

  // The scan skips sessions dormant past 48h, so a read can arrive with nothing
  // useful in it rather than not arriving at all.
  it('falls back when the read carries an empty context', () => {
    const { description } = resolveCardOrientation({
      ambientRead: read({ context: '   ' }),
      mission: 'Ship the sidebar rework',
    });
    expect(description).toEqual({ text: 'Ship the sidebar rework', source: 'insights' });
  });

  it('has no description when neither source has one', () => {
    expect(resolveCardOrientation({ ambientRead: null, mission: null }).description).toBeNull();
  });
});

describe('resolveCardOrientation — arrow', () => {
  it.each<ArrowKind>(['your-move', 'waiting-on', 'working'])('surfaces a %s arrow', (kind) => {
    const { arrow } = resolveCardOrientation({
      ambientRead: read({ arrow: { kind, text: 'the deploy to finish' } }),
    });
    expect(arrow).toEqual({ kind, text: 'the deploy to finish' });
  });

  // A card with no arrow already says "nothing outstanding"; printing it spends
  // a line to repeat that.
  it('drops nothing-pending rather than spending a line on it', () => {
    const { arrow } = resolveCardOrientation({
      ambientRead: read({ arrow: { kind: 'nothing-pending', text: 'finished' } }),
    });
    expect(arrow).toBeNull();
  });

  it('drops an arrow with no text', () => {
    const { arrow } = resolveCardOrientation({
      ambientRead: read({ arrow: { kind: 'waiting-on', text: '  ' } }),
    });
    expect(arrow).toBeNull();
  });

  it('has no arrow without a read — insights never produce one', () => {
    const { arrow } = resolveCardOrientation({ ambientRead: null, mission: 'Ship it' });
    expect(arrow).toBeNull();
  });
});
