// @vitest-environment happy-dom

/**
 * Marginalia placement, through the real render path.
 *
 * The anchoring functions are unit-tested against hand-built DOM elsewhere;
 * what this covers is the part that only exists once React is involved: the
 * card container is injected between blocks react-markdown owns, the portal
 * renders into it, and a re-anchor leaves no orphaned containers behind. That
 * is the mechanism most likely to be quietly wrong, because nothing about it
 * fails loudly.
 */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ArticleMarkdown } from '../../src/web/chat/components/LearningMap/article/ArticleMarkdown.js';
import { ExchangeCard } from '../../src/web/chat/components/LearningMap/article/ExchangeCard.js';
import { useExchangeAnchors } from '../../src/web/chat/components/LearningMap/article/useExchangeAnchors.js';

interface TestExchange {
  id: string;
  quote: string;
  quote_start: number | null;
  question: string;
  answer_md: string | null;
}

const BODY = [
  'The harness owns the event log.',
  '',
  'The daemon owns the PTY.',
].join('\n');

/** The same composition ArticlePage uses: body, anchors, portalled cards. */
function Harness({ exchanges }: { exchanges: TestExchange[] }): JSX.Element {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const anchors = useExchangeAnchors(host, BODY, exchanges);
  const byId = new Map(exchanges.map((exchange) => [exchange.id, exchange]));

  return (
    <div>
      <ArticleMarkdown content={BODY} hostRef={setHost} />
      {anchors.slots.map((slot) => createPortal(
        <>
          {slot.exchangeIds.map((id) => {
            // Same guard ArticlePage carries. For one render after the
            // exchange list changes, the anchors are still the previous pass's
            // — the layout effect that rebuilds them has not run yet — so an
            // id here can name an exchange that no longer exists.
            const exchange = byId.get(id);
            if (!exchange) return null;
            return (
              <ExchangeCard
                key={id}
                question={exchange.question}
                answerMd={exchange.answer_md}
              />
            );
          })}
        </>,
        slot.container,
        slot.exchangeIds.join(' '),
      ))}
      <div data-testid="unlocated-count">{anchors.unlocated.length}</div>
    </div>
  );
}

function body(): HTMLElement {
  return screen.getByTestId('km-article-body');
}

/**
 * Article paragraphs only. A descendant query would also catch the paragraphs
 * inside a card's rendered answer, which are not part of the article.
 */
function articleParagraphs(): HTMLElement[] {
  return Array.from(body().children).filter(
    (element): element is HTMLElement => element.tagName === 'P',
  );
}

afterEach(cleanup);

describe('exchange marginalia in the rendered article', () => {
  it('puts the card directly after the paragraph its span sits in', () => {
    render(<Harness exchanges={[{
      id: 'e1',
      quote: 'daemon owns the PTY',
      quote_start: null,
      question: 'What happens on a server restart?',
      answer_md: 'The session survives; the turn does not.',
    }]} />);

    const paragraphs = articleParagraphs();
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[1].textContent).toBe('The daemon owns the PTY.');

    const card = screen.getByTestId('km-exchange-card');
    // Injected container is the paragraph's next sibling, and the card is in it.
    const container = paragraphs[1].nextElementSibling!;
    expect(container.getAttribute('data-km-exchange-anchor')).toBe('e1');
    expect(container.contains(card)).toBe(true);
    expect(container.parentElement).toBe(body());

    expect(screen.getByText('What happens on a server restart?')).toBeTruthy();
    expect(screen.getByText('The session survives; the turn does not.')).toBeTruthy();
  });

  it('hides the card from the quote index, so a later quote cannot match it', () => {
    render(<Harness exchanges={[
      {
        id: 'e1',
        quote: 'harness owns',
        quote_start: null,
        question: 'q1',
        answer_md: 'A phrase only present inside this answer: quicksilver.',
      },
      {
        id: 'e2',
        quote: 'quicksilver',
        quote_start: null,
        question: 'q2',
        answer_md: null,
      },
    ]} />);

    // e2's quote exists only inside e1's rendered answer, which is marked
    // data-annotation-ui and therefore invisible to the index.
    expect(screen.getByTestId('unlocated-count').textContent).toBe('1');
    expect(screen.getAllByTestId('km-exchange-card')).toHaveLength(1);
  });

  it('anchors two exchanges on one paragraph into a single container', () => {
    render(<Harness exchanges={[
      { id: 'a', quote: 'harness', quote_start: null, question: 'first?', answer_md: null },
      { id: 'b', quote: 'event log', quote_start: null, question: 'second?', answer_md: null },
    ]} />);

    const container = body().querySelector('[data-km-exchange-anchor]')!;
    expect(container.getAttribute('data-km-exchange-anchor')).toBe('a b');
    expect(container.querySelectorAll('[data-testid="km-exchange-card"]')).toHaveLength(2);
    expect(body().querySelectorAll('[data-km-exchange-anchor]')).toHaveLength(1);
  });

  it('leaves no injected containers behind when the exchanges change', () => {
    const { rerender } = render(<Harness exchanges={[
      { id: 'e1', quote: 'daemon', quote_start: null, question: 'q1', answer_md: null },
    ]} />);
    expect(body().querySelectorAll('[data-km-exchange-anchor]')).toHaveLength(1);

    rerender(<Harness exchanges={[
      { id: 'e2', quote: 'harness', quote_start: null, question: 'q2', answer_md: null },
    ]} />);

    const containers = body().querySelectorAll('[data-km-exchange-anchor]');
    expect(containers).toHaveLength(1);
    expect(containers[0].getAttribute('data-km-exchange-anchor')).toBe('e2');
    // The card moved to the first paragraph with it.
    expect(articleParagraphs()[0].nextElementSibling).toBe(containers[0]);
    expect(screen.getAllByTestId('km-exchange-card')).toHaveLength(1);
    expect(screen.getByText('q2')).toBeTruthy();
  });

  it('renders no containers and no cards when nothing has been asked', () => {
    render(<Harness exchanges={[]} />);
    expect(body().querySelectorAll('[data-km-exchange-anchor]')).toHaveLength(0);
    expect(screen.queryByTestId('km-exchange-card')).toBeNull();
    expect(screen.getByTestId('unlocated-count').textContent).toBe('0');
  });

  it('leaves an unlocatable quote to the fallback list', () => {
    render(<Harness exchanges={[
      { id: 'gone', quote: 'text deleted in an edit', quote_start: 4, question: 'q', answer_md: null },
    ]} />);

    expect(screen.getByTestId('unlocated-count').textContent).toBe('1');
    expect(body().querySelectorAll('[data-km-exchange-anchor]')).toHaveLength(0);
  });
});
