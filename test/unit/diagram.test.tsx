// @vitest-environment happy-dom

/**
 * An agent's ```diagram fence: an SVG drawn in the chat, a placeholder while
 * the fence is still arriving, its source when it cannot be drawn, and the
 * check an agent runs to look before sending.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DiagramBlock, DiagramStreamingContext } from '../../src/web/chat/components/MessageList/DiagramBlock';
import { diagramLayouts, naturalWidth } from '../../src/utils/diagram-style';
import { extractDiagrams, lintDiagram, lintLayouts } from '../../src/cli/diagram-command';

afterEach(cleanup);

const SVG = '<svg viewBox="0 0 340 60" width="340"><rect class="box" x="1" y="1" width="100" height="40" rx="6"/><text x="12" y="26">App</text></svg>';
const WIDE = '<svg viewBox="0 0 600 40" width="600"><rect class="box" x="1" y="1" width="100" height="30" rx="6"/><text x="12" y="20">Wide</text></svg>';

describe('DiagramBlock', () => {
  it('draws a complete SVG in a sandboxed frame with a source toggle', () => {
    const { container } = render(<DiagramBlock source={SVG} />);
    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('srcdoc')).toContain('<text x="12" y="26">App</text>');
    expect(screen.getByText('Source')).toBeTruthy();
    expect(container.querySelector('[data-diagram-expand]')).toBeNull();
  });

  it('puts both layouts in the frame and lets its own width pick the wide one', () => {
    const { container } = render(<DiagramBlock source={`${SVG}\n${WIDE}`} />);
    const doc = container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(doc).toContain(`<div class="l n">${SVG}</div><div class="l w">${WIDE}</div>`);
    expect(doc).toContain('@container (min-width: 600px)');
    act(() => { screen.getByText('Source').click(); });
    expect(container.querySelector('[data-diagram-toggle-source]')?.textContent).toBe('Hide source');
  });

  it('keeps the drawing when the frame is measured while hidden', () => {
    const { container } = render(<DiagramBlock source={SVG} />);
    const frame = container.querySelector('iframe')!;
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { latticeDiagram: { height: 0, natural: 340, shown: 0 } } }));
    });
    expect(container.querySelector('iframe')).toBeTruthy();
    expect(container.querySelector('[data-diagram-source]')).toBeNull();
  });

  it('shows a placeholder, not half a drawing, while the fence is still arriving', () => {
    const { container } = render(
      <DiagramStreamingContext.Provider value={true}>
        <DiagramBlock source={'<svg viewBox="0 0 340 60" width="340"><rect class="box"'} />
      </DiagramStreamingContext.Provider>,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText('Drawing a diagram…')).toBeTruthy();
  });

  it('shows the source when the finished fence is not a drawable SVG', () => {
    const { container } = render(<DiagramBlock source={'<div class="node">Composer</div>'} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText('This diagram could not be drawn. Its source:')).toBeTruthy();
  });
});

describe('diagram source helpers', () => {
  it('accepts one whole <svg>, or two of different widths with the wider as the wide layout', () => {
    expect(diagramLayouts(`\n${SVG}\n`)).toEqual({ narrow: SVG, wide: null });
    expect(diagramLayouts(`${WIDE}\n\n${SVG}`)).toEqual({ narrow: SVG, wide: WIDE });
    const nested = '<svg viewBox="0 0 340 60" width="340"><svg x="0" width="10"></svg></svg>';
    expect(diagramLayouts(nested)).toEqual({ narrow: nested, wide: null });
    expect(diagramLayouts('<svg viewBox="0 0 10 10">')).toBeNull();
    expect(diagramLayouts(`${SVG}\n<svg viewBox="0 0 600 40" width="600">`)).toBeNull();
    expect(diagramLayouts(`<p>x</p>${SVG}`)).toBeNull();
    expect(diagramLayouts(`${SVG}<p>x</p>${WIDE}`)).toBeNull();
    expect(diagramLayouts(`${SVG}${SVG}`)).toBeNull();
    expect(diagramLayouts(`${SVG}${WIDE}${WIDE.replace(/600/g, '500')}`)).toBeNull();
  });

  it('reads the natural width from width, else the viewBox', () => {
    expect(naturalWidth(SVG)).toBe(340);
    expect(naturalWidth('<svg viewBox="0 0 680 120"></svg>')).toBe(680);
  });

  it('finds every diagram fence in a reply draft, or a bare SVG file', () => {
    expect(extractDiagrams(`Intro\n\n\`\`\`diagram\n${SVG}\n\`\`\`\n\nMore\n\n\`\`\`diagram\n${SVG}\n\`\`\`\n`)).toHaveLength(2);
    expect(extractDiagrams(SVG)).toEqual([SVG]);
    expect(extractDiagrams('no diagram here')).toEqual([]);
  });

  it('flags a shape that would render solid black, but not one that inherits a fill or sits in a marker', () => {
    const black = '<svg viewBox="0 0 340 60" width="340"><rect x="1" y="1" width="10" height="10"/></svg>';
    expect(lintDiagram(black).join('\n')).toContain('renders solid black');
    const fine = '<svg viewBox="0 0 340 60" width="340"><defs><marker id="m"><path d="M0 0 L5 5"/></marker></defs><g class="off"><rect x="1" y="1" width="10" height="10"/></g></svg>';
    expect(lintDiagram(fine)).toEqual([]);
  });

  it('warns when a drawing will shrink on a phone or has no viewBox', () => {
    expect(lintDiagram('<svg viewBox="0 0 680 100" width="680"></svg>').join('\n')).toContain('open it full size');
    expect(lintDiagram('<svg width="340" height="60"></svg>').join('\n')).toContain('no viewBox');
  });

  it('accepts a 600-wide layout beside the phone one, but not one wider than the desktop column', () => {
    expect(lintLayouts({ narrow: SVG, wide: WIDE })).toEqual([]);
    expect(lintLayouts({ narrow: SVG, wide: WIDE.replace(/600/g, '680') }).join('\n')).toContain('desktop would show the phone layout');
  });
});
