// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveCardOrientation } from '../../src/web/chat/components/shared/session-card-orientation.js';
import {
  markUserSend,
  readUserSendMarks,
  useUserSendMarks,
  USER_SEND_MARKS_KEY,
} from '../../src/web/chat/components/shared/user-send-marks.js';
import type { AmbientRead, ArrowKind } from '../../src/web/chat/components/AmbientPortfolio/ambient-types.js';

const SCAN_TS = Date.parse('2026-08-10T09:00:00.000Z');

function read(kind: ArrowKind, text: string): AmbientRead {
  return {
    sessionId: 'conv-abc',
    sourceBoundaryTs: SCAN_TS,
    context: 'Rewriting the sidebar arrow rules',
    arrow: { kind, text },
    portfolio: 'lattice',
    workArea: null,
    mode: 'building',
    deliverable: 'ships',
    snag: null,
    markers: [],
    flag: null,
    flagLine: null,
    evidence: [],
  };
}

describe('arrow clearing after the reader sends', () => {
  it('drops "your move" once a send lands after the scan boundary', () => {
    const ambientRead = read('your-move', 'answer the model-choice question');
    ambientRead.suggestedNext = 'Use Luna for the card scan.';
    const orientation = resolveCardOrientation({
      ambientRead,
      userSentAt: SCAN_TS + 1_000,
    });

    expect(orientation.arrow).toBeNull();
    // The description still comes from the same read — only the ask is stale.
    expect(orientation.description).toEqual({
      text: 'Rewriting the sidebar arrow rules',
      source: 'ambient',
    });
  });

  it('keeps an outside-session "your move" after an unrelated message', () => {
    const orientation = resolveCardOrientation({
      ambientRead: read('your-move', 'open the demo and test a voice conversation'),
      userSentAt: SCAN_TS + 1_000,
    });

    expect(orientation.arrow).toEqual({
      kind: 'your-move',
      text: 'open the demo and test a voice conversation',
    });
  });

  it('keeps "waiting on" — a message does not resolve the external dependency', () => {
    const orientation = resolveCardOrientation({
      ambientRead: read('waiting-on', 'the overnight batch to finish'),
      userSentAt: SCAN_TS + 1_000,
    });

    expect(orientation.arrow).toEqual({ kind: 'waiting-on', text: 'the overnight batch to finish' });
  });

  it('keeps an arrow whose read already accounts for the send', () => {
    const orientation = resolveCardOrientation({
      ambientRead: read('your-move', 'pick the rollout order'),
      userSentAt: SCAN_TS - 1_000,
    });

    expect(orientation.arrow).toEqual({ kind: 'your-move', text: 'pick the rollout order' });
  });

  it('keeps "working" — a message is not an answer to a progress report', () => {
    const orientation = resolveCardOrientation({
      ambientRead: read('working', 'running the eval battery'),
      userSentAt: SCAN_TS + 1_000,
    });

    expect(orientation.arrow).toEqual({ kind: 'working', text: 'running the eval battery' });
  });

  it('keeps every arrow when the reader has sent nothing', () => {
    const orientation = resolveCardOrientation({
      ambientRead: read('your-move', 'reply to Sam'),
    });

    expect(orientation.arrow).toEqual({ kind: 'your-move', text: 'reply to Sam' });
  });
});

describe('user send marks', () => {
  beforeEach(() => window.localStorage.clear());

  it('records the newest send per session and leaves others alone', () => {
    markUserSend('conv-one', 1_000);
    markUserSend('conv-two', 2_000);
    markUserSend('conv-one', 3_000);

    expect(readUserSendMarks()).toEqual({ 'conv-one': 3_000, 'conv-two': 2_000 });
  });

  it('drops marks older than the ambient scan\'s own 48h dormancy window', () => {
    const now = Date.parse('2026-08-10T12:00:00.000Z');
    markUserSend('conv-stale', now - 49 * 60 * 60 * 1000);
    markUserSend('conv-fresh', now);

    expect(readUserSendMarks()).toEqual({ 'conv-fresh': now });
  });

  it('reaches a subscriber in another subtree without waiting for a poll', () => {
    // The composer and the sidebar never share a parent — this event is the
    // only thing that clears the arrow at send time rather than 30s later.
    const { result } = renderHook(() => useUserSendMarks());
    expect(result.current['conv-elsewhere']).toBeUndefined();

    act(() => markUserSend('conv-elsewhere', 5_000));

    expect(result.current['conv-elsewhere']).toBe(5_000);
  });

  it('reads a corrupt store as no marks rather than throwing', () => {
    window.localStorage.setItem(USER_SEND_MARKS_KEY, 'not json');

    expect(readUserSendMarks()).toEqual({});
  });
});
