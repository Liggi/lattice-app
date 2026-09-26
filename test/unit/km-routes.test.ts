/**
 * The learning map HTTP surface, driven over a real listening Express server.
 *
 * The consumer is an agent hand-composing JSON from docs/learning-map-api.md,
 * so what these pin down is the part an agent gets wrong: bad node types and
 * edge kinds come back as 400 with the allowed vocabulary in the message, and
 * wrong ids come back as 404 naming the id, not as a 500.
 */

import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { createLogger } from '../../src/services/infrastructure/logger.js';
import { runSessionInfoSchemaBootstrap } from '../../src/services/sessions/session-info-migrations.js';
import { KnowledgeMapService } from '../../src/services/km/knowledge-map-service.js';
import { createKnowledgeMapRoutes } from '../../src/routes/km.routes.js';
import type {
  TooltipGenerationInput,
  TooltipGenerationResult,
  TooltipGenerator,
} from '../../src/services/km/tooltip-generator.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { LatticeError } from '../../src/types/index.js';

let server: Server | undefined;
let baseUrl: string;
let db: Database.Database;
let tooltipCalls: TooltipGenerationInput[];

/**
 * Stands in for the model. Records every call so a test can assert not just
 * what came back but what was *asked for* — the point of the endpoint is that a
 * second request does not re-ask for concepts it already has.
 */
class FakeTooltipGenerator implements TooltipGenerator {
  constructor(
    private readonly respond: (input: TooltipGenerationInput) => TooltipGenerationResult
      | Promise<TooltipGenerationResult>,
  ) {}

  async generate(input: TooltipGenerationInput): Promise<TooltipGenerationResult> {
    tooltipCalls.push(input);
    return this.respond(input);
  }
}

/** Explains every concept it is handed, as `### <concept>`. */
const explainsEverything = new FakeTooltipGenerator((input) => ({
  tooltips: Object.fromEntries(input.concepts.map((c) => [c, `### ${c}`])),
  failed: [],
}));

async function startServer(generator: TooltipGenerator = explainsEverything): Promise<void> {
  DatabaseProvider.resetInstance();
  db = DatabaseProvider.getInstance(':memory:').getDb();
  runSessionInfoSchemaBootstrap(db, createLogger('KmRoutesTest'));

  const app = express();
  app.use(express.json());
  tooltipCalls = [];
  app.use('/api/km', createKnowledgeMapRoutes({
    service: new KnowledgeMapService(db),
    tooltipGenerator: generator,
  }));
  app.use(errorHandler);

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/km`;
}

/**
 * Swaps in a different stand-in model. `beforeEach` has already started a
 * server with the cooperative one, so a test that wants failures throws that
 * away and starts over on a fresh database.
 */
async function restartServerWith(generator: TooltipGenerator): Promise<void> {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  DatabaseProvider.resetInstance();
  KnowledgeMapService.resetInstance();
  await startServer(generator);
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function seedMap(name = 'lattice'): Promise<string> {
  const { json } = await call('POST', '/maps', { name });
  return json.map.id;
}

async function seedArticle(mapId: string, title = 'Node'): Promise<string> {
  const { json } = await call('POST', `/maps/${mapId}/articles`, {
    title,
    content_md: '# body',
  });
  return json.article.id;
}

/** An article whose body carries bold terms for the tooltip endpoint to find. */
async function seedBoldArticle(
  mapId: string,
  content_md = 'The **EventLog** feeds the **daemon**.',
): Promise<string> {
  const { json } = await call('POST', `/maps/${mapId}/articles`, {
    title: 'Harness',
    content_md,
  });
  return json.article.id;
}

// Wrapped rather than passed by reference: `beforeEach(startServer)` would hand
// vitest's test context in as the generator argument and shadow the default.
beforeEach(() => startServer());

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  DatabaseProvider.resetInstance();
  KnowledgeMapService.resetInstance();
});

describe('GET/POST /api/km/maps', () => {
  it('starts empty', async () => {
    const { status, json } = await call('GET', '/maps');
    expect(status).toBe(200);
    expect(json).toEqual({ maps: [] });
  });

  it('creates a map with 201 and re-returns the same map with 200', async () => {
    const first = await call('POST', '/maps', { name: 'lattice' });
    expect(first.status).toBe(201);
    expect(first.json.created).toBe(true);

    const second = await call('POST', '/maps', { name: 'lattice' });
    expect(second.status).toBe(200);
    expect(second.json.created).toBe(false);
    expect(second.json.map.id).toBe(first.json.map.id);

    const list = await call('GET', '/maps');
    expect(list.json.maps).toHaveLength(1);
  });

  it('trims the name so trailing whitespace does not fork a second map', async () => {
    const first = await call('POST', '/maps', { name: 'lattice' });
    const second = await call('POST', '/maps', { name: '  lattice  ' });
    expect(second.json.map.id).toBe(first.json.map.id);
  });

  it('rejects a missing or blank name with 400', async () => {
    expect((await call('POST', '/maps', {})).status).toBe(400);
    const blank = await call('POST', '/maps', { name: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.json.error).toMatch(/name is required/);
  });

  it('reports article counts', async () => {
    const mapId = await seedMap();
    await seedArticle(mapId, 'One');
    await seedArticle(mapId, 'Two');

    const { json } = await call('GET', '/maps');
    expect(json.maps[0].article_count).toBe(2);
  });
});

describe('GET /api/km/maps/:mapId', () => {
  it('returns the map, its article headers without bodies, and its edges', async () => {
    const mapId = await seedMap();
    const from = await seedArticle(mapId, 'Starting node');
    const to = await seedArticle(mapId, 'Answer node');
    await call('POST', `/maps/${mapId}/edges`, {
      from_article_id: from,
      to_article_id: to,
      kind: 'follow',
      label: 'what buffers these across a restart?',
    });

    const { status, json } = await call('GET', `/maps/${mapId}`);
    expect(status).toBe(200);
    expect(json.map.id).toBe(mapId);
    expect(json.articles).toHaveLength(2);
    expect(json.articles[0]).not.toHaveProperty('content_md');
    expect(json.articles[0]).toMatchObject({ title: 'Starting node', node_type: 'article' });
    expect(json.edges).toHaveLength(1);
    expect(json.edges[0].kind).toBe('follow');
    expect(json.edges[0].label).toBe('what buffers these across a restart?');
  });

  it('404s on an unknown map id', async () => {
    const { status, json } = await call('GET', '/maps/km-map-nope');
    expect(status).toBe(404);
    expect(json.error).toContain('km-map-nope');
  });
});

describe('PATCH /api/km/maps/:mapId', () => {
  it('sets and clears the default responder conversation', async () => {
    const mapId = await seedMap();

    const listedBefore = await call('GET', '/maps');
    expect(listedBefore.json.maps[0].default_conv).toBeNull();

    const set = await call('PATCH', `/maps/${mapId}`, { default_conv: 'conv-responder' });
    expect(set.status).toBe(200);
    expect(set.json.map.default_conv).toBe('conv-responder');

    const fetched = await call('GET', `/maps/${mapId}`);
    expect(fetched.json.map.default_conv).toBe('conv-responder');

    const cleared = await call('PATCH', `/maps/${mapId}`, { default_conv: null });
    expect(cleared.json.map.default_conv).toBeNull();
  });

  it('treats a blank default_conv as clearing it', async () => {
    const mapId = await seedMap();
    await call('PATCH', `/maps/${mapId}`, { default_conv: 'conv-x' });

    const { json } = await call('PATCH', `/maps/${mapId}`, { default_conv: '   ' });
    expect(json.map.default_conv).toBeNull();
  });

  it('rejects a missing or non-string default_conv with 400', async () => {
    const mapId = await seedMap();

    const missing = await call('PATCH', `/maps/${mapId}`, {});
    expect(missing.status).toBe(400);
    expect(missing.json.error).toContain('default_conv');

    const wrongType = await call('PATCH', `/maps/${mapId}`, { default_conv: 7 });
    expect(wrongType.status).toBe(400);
    expect(wrongType.json.error).toContain('string or null');
  });

  it('404s on an unknown map id', async () => {
    const { status, json } = await call('PATCH', '/maps/km-map-nope', { default_conv: 'conv-x' });
    expect(status).toBe(404);
    expect(json.error).toContain('km-map-nope');
  });
});

describe('POST /api/km/maps/:mapId/articles', () => {
  it('creates an article and records provenance', async () => {
    const mapId = await seedMap();
    const { status, json } = await call('POST', `/maps/${mapId}/articles`, {
      title: 'The event log',
      content_md: '# The event log\n\nEvents flow through EventLog.',
      node_type: 'architecture-item',
      created_from: 'drawn while answering a question about restarts',
      created_by_conv: 'conv-1234',
    });

    expect(status).toBe(201);
    expect(json.article).toMatchObject({
      map_id: mapId,
      title: 'The event log',
      node_type: 'architecture-item',
      created_from: 'drawn while answering a question about restarts',
      created_by_conv: 'conv-1234',
      pinned_x: null,
      pinned_y: null,
    });
    expect(typeof json.article.created_at).toBe('number');
  });

  it('rejects an unknown node_type with 400 naming the allowed set', async () => {
    const mapId = await seedMap();
    const { status, json } = await call('POST', `/maps/${mapId}/articles`, {
      title: 'T',
      content_md: '',
      node_type: 'diagram',
    });

    expect(status).toBe(400);
    expect(json.error).toContain('architecture-item');
    expect(json.error).toContain('code-structure');
  });

  it('rejects a missing title or non-string content_md with 400', async () => {
    const mapId = await seedMap();
    expect((await call('POST', `/maps/${mapId}/articles`, { content_md: 'x' })).status).toBe(400);
    expect((await call('POST', `/maps/${mapId}/articles`, { title: 'T' })).status).toBe(400);
    expect((await call('POST', `/maps/${mapId}/articles`, {
      title: 'T',
      content_md: 42,
    })).status).toBe(400);
  });

  it('404s when the map does not exist', async () => {
    const { status } = await call('POST', '/maps/km-map-nope/articles', {
      title: 'T',
      content_md: 'x',
    });
    expect(status).toBe(404);
  });
});

describe('GET/PATCH /api/km/articles/:articleId', () => {
  it('returns the full body plus exchanges', async () => {
    const mapId = await seedMap();
    const articleId = await seedArticle(mapId);
    await call('POST', `/articles/${articleId}/exchanges`, {
      quote: 'body',
      question: 'why?',
    });

    const { status, json } = await call('GET', `/articles/${articleId}`);
    expect(status).toBe(200);
    expect(json.article.content_md).toBe('# body');
    expect(json.exchanges).toHaveLength(1);
    expect(json.exchanges[0].answer_md).toBeNull();
  });

  it('updates title, body, type and pins', async () => {
    const mapId = await seedMap();
    const articleId = await seedArticle(mapId);

    const { status, json } = await call('PATCH', `/articles/${articleId}`, {
      title: 'Renamed',
      content_md: 'new body',
      node_type: 'concept',
      pinned_x: 100.25,
      pinned_y: -40,
    });

    expect(status).toBe(200);
    expect(json.article).toMatchObject({
      title: 'Renamed',
      content_md: 'new body',
      node_type: 'concept',
      pinned_x: 100.25,
      pinned_y: -40,
    });
  });

  it('accepts a pin-only patch without disturbing the body', async () => {
    const mapId = await seedMap();
    const articleId = await seedArticle(mapId);

    const { json } = await call('PATCH', `/articles/${articleId}`, { pinned_x: 1, pinned_y: 2 });
    expect(json.article.content_md).toBe('# body');
    expect(json.article.pinned_x).toBe(1);
  });

  it('rejects an empty patch and a bad node_type with 400', async () => {
    const mapId = await seedMap();
    const articleId = await seedArticle(mapId);

    const empty = await call('PATCH', `/articles/${articleId}`, {});
    expect(empty.status).toBe(400);
    expect(empty.json.error).toMatch(/At least one/);

    const badType = await call('PATCH', `/articles/${articleId}`, { node_type: 'nope' });
    expect(badType.status).toBe(400);

    const badPin = await call('PATCH', `/articles/${articleId}`, { pinned_x: 'left' });
    expect(badPin.status).toBe(400);
  });

  it('writes tooltips straight through, no model involved', async () => {
    const mapId = await seedMap();
    const articleId = await seedArticle(mapId);

    const tooltips = { EventLog: '### Event log\n\nAppend-only.' };
    const { status, json } = await call('PATCH', `/articles/${articleId}`, { tooltips });

    expect(status).toBe(200);
    expect(json.article.tooltips).toEqual(tooltips);
    expect(tooltipCalls).toHaveLength(0);
    expect((await call('GET', `/articles/${articleId}`)).json.article.tooltips).toEqual(tooltips);
  });

  it('rejects a tooltips value that is not an object of strings', async () => {
    const mapId = await seedMap();
    const articleId = await seedArticle(mapId);

    for (const bad of [['a'], 'a string', null, { concept: 42 }]) {
      const { status, json } = await call('PATCH', `/articles/${articleId}`, { tooltips: bad });
      expect(status).toBe(400);
      expect(json.error).toMatch(/tooltips must be an object/);
    }
  });

  it('404s on unknown article ids', async () => {
    expect((await call('GET', '/articles/km-art-nope')).status).toBe(404);
    expect((await call('PATCH', '/articles/km-art-nope', { title: 'T' })).status).toBe(404);
  });
});

describe('POST /api/km/articles/:articleId/tooltips', () => {
  it('explains every bold term and persists the result', async () => {
    const mapId = await seedMap();
    const articleId = await seedBoldArticle(mapId);

    const { status, json } = await call('POST', `/articles/${articleId}/tooltips`);
    expect(status).toBe(200);
    expect(json).toEqual({
      tooltips: { EventLog: '### EventLog', daemon: '### daemon' },
      generated: 2,
      failed: 0,
    });

    // Persisted, not just returned.
    expect((await call('GET', `/articles/${articleId}`)).json.article.tooltips)
      .toEqual({ EventLog: '### EventLog', daemon: '### daemon' });
  });

  it('passes the article body and title to the generator as context', async () => {
    const mapId = await seedMap();
    await seedBoldArticle(mapId, 'Only **one** term.').then((id) =>
      call('POST', `/articles/${id}/tooltips`));

    expect(tooltipCalls).toHaveLength(1);
    expect(tooltipCalls[0]).toEqual({
      concepts: ['one'],
      title: 'Harness',
      content_md: 'Only **one** term.',
    });
  });

  it('never calls the model for an article with no bold text', async () => {
    const mapId = await seedMap();
    const articleId = await seedArticle(mapId);

    const { status, json } = await call('POST', `/articles/${articleId}/tooltips`);
    expect(status).toBe(200);
    expect(json).toEqual({ tooltips: {}, generated: 0, failed: 0 });
    expect(tooltipCalls).toHaveLength(0);
  });

  it('asks only for the concepts it does not already have', async () => {
    const mapId = await seedMap();
    const articleId = await seedBoldArticle(mapId);

    await call('POST', `/articles/${articleId}/tooltips`);
    expect(tooltipCalls[0].concepts).toEqual(['EventLog', 'daemon']);

    // Edit the body so one term is new and the other is already explained.
    await call('PATCH', `/articles/${articleId}`, {
      content_md: 'The **EventLog** feeds the **PTY**.',
    });
    const { json } = await call('POST', `/articles/${articleId}/tooltips`);

    expect(tooltipCalls).toHaveLength(2);
    expect(tooltipCalls[1].concepts).toEqual(['PTY']);
    // The tooltip for the dropped term is kept, not pruned.
    expect(json).toEqual({
      tooltips: { EventLog: '### EventLog', daemon: '### daemon', PTY: '### PTY' },
      generated: 1,
      failed: 0,
    });
  });

  it('answers from storage without a call when nothing is missing', async () => {
    const mapId = await seedMap();
    const articleId = await seedBoldArticle(mapId);

    await call('POST', `/articles/${articleId}/tooltips`);
    const { status, json } = await call('POST', `/articles/${articleId}/tooltips`);

    expect(status).toBe(200);
    expect(json.generated).toBe(0);
    expect(json.tooltips).toEqual({ EventLog: '### EventLog', daemon: '### daemon' });
    expect(tooltipCalls).toHaveLength(1);
  });

  it('re-explains everything when force is set', async () => {
    const mapId = await seedMap();
    const articleId = await seedBoldArticle(mapId);

    await call('POST', `/articles/${articleId}/tooltips`);
    const { status, json } = await call('POST', `/articles/${articleId}/tooltips`, { force: true });

    expect(status).toBe(200);
    expect(json.generated).toBe(2);
    expect(tooltipCalls).toHaveLength(2);
    expect(tooltipCalls[1].concepts).toEqual(['EventLog', 'daemon']);
  });

  it('rejects a non-boolean force with 400 and no call', async () => {
    const mapId = await seedMap();
    const articleId = await seedBoldArticle(mapId);

    const { status, json } = await call('POST', `/articles/${articleId}/tooltips`, { force: 'yes' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/force must be a boolean/);
    expect(tooltipCalls).toHaveLength(0);
  });

  it('404s an unknown article before reaching the model', async () => {
    const { status, json } = await call('POST', '/articles/km-art-nope/tooltips');
    expect(status).toBe(404);
    expect(json.error).toContain('km-art-nope');
    expect(tooltipCalls).toHaveLength(0);
  });
});

describe('POST /api/km/articles/:articleId/tooltips — partial and missing-key paths', () => {
  it('keeps the concepts that worked and counts the ones that did not', async () => {
    await restartServerWith(new FakeTooltipGenerator((input) => ({
      tooltips: { [input.concepts[0]]: '### only the first' },
      failed: input.concepts.slice(1),
    })));

    const mapId = await seedMap();
    const articleId = await seedBoldArticle(mapId);
    const { status, json } = await call('POST', `/articles/${articleId}/tooltips`);

    expect(status).toBe(200);
    expect(json).toEqual({
      tooltips: { EventLog: '### only the first' },
      generated: 1,
      failed: 1,
    });

    // A later request retries only the concept that failed.
    await call('POST', `/articles/${articleId}/tooltips`);
    expect(tooltipCalls[1].concepts).toEqual(['daemon']);
  });

  it('fails loudly when there is no way to call a model', async () => {
    await restartServerWith(new FakeTooltipGenerator(() => {
      throw new LatticeError('ANTHROPIC_API_KEY_MISSING', 'Anthropic API key not configured', 400);
    }));

    const mapId = await seedMap();
    const articleId = await seedBoldArticle(mapId);
    const { status, json } = await call('POST', `/articles/${articleId}/tooltips`);

    expect(status).toBe(400);
    expect(json.code).toBe('ANTHROPIC_API_KEY_MISSING');
    expect((await call('GET', `/articles/${articleId}`)).json.article.tooltips).toEqual({});
  });
});

describe('POST /api/km/articles/:articleId/follow', () => {
  it('creates the child node and the edge carrying the question', async () => {
    const mapId = await seedMap();
    const parent = await seedArticle(mapId, 'Event log');

    const { status, json } = await call('POST', `/articles/${parent}/follow`, {
      question: 'Tell me more about append-only',
      concept: 'append-only',
      created_by_conv: 'conv-parent',
    });

    expect(status).toBe(201);
    expect(json.article).toMatchObject({
      map_id: mapId,
      title: 'append-only',
      content_md: '',
      node_type: 'concept',
      created_from: parent,
      created_by_conv: 'conv-parent',
    });
    expect(json.edge).toMatchObject({
      map_id: mapId,
      from_article_id: parent,
      to_article_id: json.article.id,
      kind: 'follow',
      label: 'Tell me more about append-only',
    });

    const map = await call('GET', `/maps/${mapId}`);
    expect(map.json.edges).toHaveLength(1);
    expect(map.json.articles.find((a: any) => a.id === json.article.id).has_content).toBe(false);
  });

  it('falls back to the question as the title', async () => {
    const mapId = await seedMap();
    const parent = await seedArticle(mapId);
    const { json } = await call('POST', `/articles/${parent}/follow`, {
      question: 'Why does it restart?',
    });
    expect(json.article.title).toBe('Why does it restart?');
    expect(json.article.created_by_conv).toBeNull();
  });

  it('rejects a missing question with 400', async () => {
    const mapId = await seedMap();
    const parent = await seedArticle(mapId);
    const { status, json } = await call('POST', `/articles/${parent}/follow`, { concept: 'x' });
    expect(status).toBe(400);
    expect(json.error).toBe('question is required and must be a non-empty string');
  });

  it('404s on an unknown parent article', async () => {
    const { status, json } = await call('POST', '/articles/km-art-nope/follow', {
      question: 'anything?',
    });
    expect(status).toBe(404);
    expect(json.error).toContain('km-art-nope');
  });
});

describe('POST /api/km/maps/:mapId/edges', () => {
  it('creates both edge kinds', async () => {
    const mapId = await seedMap();
    const from = await seedArticle(mapId, 'From');
    const to = await seedArticle(mapId, 'To');

    for (const kind of ['follow', 'related']) {
      const { status, json } = await call('POST', `/maps/${mapId}/edges`, {
        from_article_id: from,
        to_article_id: to,
        kind,
      });
      expect(status).toBe(201);
      expect(json.edge).toMatchObject({ map_id: mapId, from_article_id: from, kind });
    }
  });

  it('rejects an unknown kind with 400 naming the allowed set', async () => {
    const mapId = await seedMap();
    const from = await seedArticle(mapId);
    const { status, json } = await call('POST', `/maps/${mapId}/edges`, {
      from_article_id: from,
      to_article_id: from,
      kind: 'answers',
    });
    expect(status).toBe(400);
    expect(json.error).toBe('kind must be one of: follow, related');
  });

  it('404s naming the endpoint that does not exist', async () => {
    const mapId = await seedMap();
    const real = await seedArticle(mapId);

    const missingTo = await call('POST', `/maps/${mapId}/edges`, {
      from_article_id: real,
      to_article_id: 'km-art-nope',
      kind: 'related',
    });
    expect(missingTo.status).toBe(404);
    expect(missingTo.json.error).toContain('km-art-nope');
  });

  it('404s when the endpoint belongs to another map', async () => {
    const mapA = await seedMap('a');
    const mapB = await seedMap('b');
    const inA = await seedArticle(mapA);
    const inB = await seedArticle(mapB);

    const { status } = await call('POST', `/maps/${mapA}/edges`, {
      from_article_id: inA,
      to_article_id: inB,
      kind: 'related',
    });
    expect(status).toBe(404);
  });
});

describe('exchanges', () => {
  it('creates an unanswered exchange then answers it', async () => {
    const mapId = await seedMap();
    const articleId = await seedArticle(mapId);

    const created = await call('POST', `/articles/${articleId}/exchanges`, {
      quote: 'Events flow through EventLog',
      quote_start: 128,
      question: 'What buffers them across a restart?',
    });
    expect(created.status).toBe(201);
    expect(created.json.exchange).toMatchObject({
      article_id: articleId,
      quote_start: 128,
      answer_md: null,
    });

    const answered = await call('PATCH', `/exchanges/${created.json.exchange.id}`, {
      answer_md: 'Nothing does — the in-flight turn is lost.',
    });
    expect(answered.status).toBe(200);
    expect(answered.json.exchange.answer_md).toBe('Nothing does — the in-flight turn is lost.');
    expect(answered.json.exchange.quote).toBe('Events flow through EventLog');
  });

  it('rejects a missing quote, question, or bad quote_start with 400', async () => {
    const mapId = await seedMap();
    const articleId = await seedArticle(mapId);

    expect((await call('POST', `/articles/${articleId}/exchanges`, {
      question: 'q?',
    })).status).toBe(400);
    expect((await call('POST', `/articles/${articleId}/exchanges`, {
      quote: 'q',
    })).status).toBe(400);
    expect((await call('POST', `/articles/${articleId}/exchanges`, {
      quote: 'q',
      question: 'q?',
      quote_start: -1,
    })).status).toBe(400);
    expect((await call('POST', `/articles/${articleId}/exchanges`, {
      quote: 'q',
      question: 'q?',
      quote_start: 1.5,
    })).status).toBe(400);
  });

  it('rejects a non-string answer_md with 400', async () => {
    const mapId = await seedMap();
    const articleId = await seedArticle(mapId);
    const created = await call('POST', `/articles/${articleId}/exchanges`, {
      quote: 'q',
      question: 'q?',
    });

    const { status, json } = await call('PATCH', `/exchanges/${created.json.exchange.id}`, {});
    expect(status).toBe(400);
    expect(json.error).toMatch(/answer_md is required/);
  });

  it('404s on unknown article and exchange ids', async () => {
    expect((await call('POST', '/articles/km-art-nope/exchanges', {
      quote: 'q',
      question: 'q?',
    })).status).toBe(404);
    expect((await call('PATCH', '/exchanges/km-exch-nope', { answer_md: 'a' })).status).toBe(404);
  });
});
