/**
 * KnowledgeMapService against the real migration, on an in-memory DB.
 *
 * These run the actual session-info bootstrap rather than hand-rolled DDL, so
 * a column the service writes but the migration never creates fails here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { createLogger } from '../../src/services/infrastructure/logger.js';
import { runSessionInfoSchemaBootstrap } from '../../src/services/sessions/session-info-migrations.js';
import {
  KM_EDGE_KINDS,
  KM_NODE_TYPES,
  KnowledgeMapService,
  isKmEdgeKind,
  isKmNodeType,
} from '../../src/services/km/knowledge-map-service.js';

/**
 * `getInstance(':memory:')` closes and rebuilds the connection on every call,
 * so the db handle has to be captured once and passed around — calling
 * getInstance again mid-test would silently hand back an empty database.
 */
function freshDb(): Database.Database {
  DatabaseProvider.resetInstance();
  const db = DatabaseProvider.getInstance(':memory:').getDb();
  runSessionInfoSchemaBootstrap(db, createLogger('KmServiceTest'));
  return db;
}

describe('KnowledgeMapService', () => {
  let db: Database.Database;
  let service: KnowledgeMapService;

  beforeEach(() => {
    db = freshDb();
    service = new KnowledgeMapService(db);
  });

  afterEach(() => {
    DatabaseProvider.resetInstance();
    KnowledgeMapService.resetInstance();
  });

  it('creates the km tables through the session-info bootstrap', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'km_%' ORDER BY name"
    ).all() as Array<{ name: string }>;

    expect(tables.map(t => t.name)).toEqual([
      'km_articles',
      'km_edges',
      'km_exchanges',
      'km_maps',
    ]);
  });

  it('starts a map with no default responder conversation', () => {
    const { map } = service.createMap('no-default');
    expect(map.default_conv).toBeNull();
    expect(service.getMap(map.id)?.default_conv).toBeNull();
    expect(service.getMapByName('no-default')?.default_conv).toBeNull();
  });

  it('sets, reads back and clears the default responder conversation', () => {
    const map = service.createMap('with-default').map;

    const set = service.updateMap(map.id, { default_conv: 'conv-responder' })!;
    expect(set.default_conv).toBe('conv-responder');
    expect(service.getMap(map.id)?.default_conv).toBe('conv-responder');
    expect(service.listMaps().find(m => m.id === map.id)?.default_conv).toBe('conv-responder');
    expect(service.getMapDetail(map.id)?.map.default_conv).toBe('conv-responder');

    const cleared = service.updateMap(map.id, { default_conv: null })!;
    expect(cleared.default_conv).toBeNull();
  });

  it('leaves the default alone for an empty update, and 404s an unknown map', () => {
    const map = service.createMap('empty-update').map;
    service.updateMap(map.id, { default_conv: 'conv-keep' });

    expect(service.updateMap(map.id, {})?.default_conv).toBe('conv-keep');
    expect(service.updateMap('km-map-nope', { default_conv: 'conv-x' })).toBeNull();
  });

  it('returns the existing map when a name is created twice', () => {
    const first = service.createMap('lattice-internals');
    const second = service.createMap('lattice-internals');

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.map.id).toBe(first.map.id);
    expect(service.listMaps()).toHaveLength(1);
  });

  it('counts articles per map in the list', () => {
    const a = service.createMap('map-a').map;
    const b = service.createMap('map-b').map;
    service.createArticle(a.id, { title: 'One', content_md: '#1' });
    service.createArticle(a.id, { title: 'Two', content_md: '#2' });

    const byId = new Map(service.listMaps().map(m => [m.id, m.article_count]));
    expect(byId.get(a.id)).toBe(2);
    expect(byId.get(b.id)).toBe(0);
  });

  it("defaults node_type to 'article' and records provenance", () => {
    const map = service.createMap('provenance').map;
    const article = service.createArticle(map.id, {
      title: 'Event log',
      content_md: 'body',
      created_from: 'asked while tracing a hang',
      created_by_conv: 'conv-abc123',
    });

    expect(article?.node_type).toBe('article');
    expect(article?.created_from).toBe('asked while tracing a hang');
    expect(article?.created_by_conv).toBe('conv-abc123');
    expect(article?.pinned_x).toBeNull();
    expect(article?.pinned_y).toBeNull();
  });

  it('persists every declared node type', () => {
    const map = service.createMap('types').map;
    for (const nodeType of KM_NODE_TYPES) {
      const created = service.createArticle(map.id, {
        title: nodeType,
        content_md: 'x',
        node_type: nodeType,
      });
      expect(service.getArticle(created!.id)?.node_type).toBe(nodeType);
    }
  });

  it('returns null when creating an article on a map that does not exist', () => {
    expect(service.createArticle('km-map-nope', { title: 'T', content_md: 'B' })).toBeNull();
  });

  it('omits article bodies from the map detail but keeps titles, types and pins', () => {
    const map = service.createMap('detail').map;
    const article = service.createArticle(map.id, {
      title: 'Pinned node',
      content_md: 'a very long body that must not ride along',
      node_type: 'concept',
    })!;
    service.updateArticle(article.id, { pinned_x: 12.5, pinned_y: -3 });

    const detail = service.getMapDetail(map.id)!;
    expect(detail.articles).toHaveLength(1);
    expect(detail.articles[0]).toMatchObject({
      id: article.id,
      title: 'Pinned node',
      node_type: 'concept',
      pinned_x: 12.5,
      pinned_y: -3,
    });
    expect(detail.articles[0]).not.toHaveProperty('content_md');
  });

  it('starts an article with no tooltips and reads the column back as an object', () => {
    const map = service.createMap('tooltips-default').map;
    const article = service.createArticle(map.id, { title: 'T', content_md: '**a**' })!;

    expect(article.tooltips).toEqual({});
    expect(service.getArticle(article.id)!.tooltips).toEqual({});
  });

  it('round-trips tooltips through the JSON column', () => {
    const map = service.createMap('tooltips-write').map;
    const article = service.createArticle(map.id, { title: 'T', content_md: '' })!;

    const tooltips = {
      EventLog: '### Event log\n\nThe **append-only** stream of session events.',
      'quote_start': '### Offsets\n\nWhere a highlight begins.',
    };
    const updated = service.updateArticle(article.id, { tooltips })!;

    expect(updated.tooltips).toEqual(tooltips);
    expect(service.getArticle(article.id)!.tooltips).toEqual(tooltips);
  });

  it('accepts tooltips at creation, so a session can write them without a model call', () => {
    const map = service.createMap('tooltips-create').map;
    const article = service.createArticle(map.id, {
      title: 'T',
      content_md: '**daemon**',
      tooltips: { daemon: '### The daemon\n\nOwns the PTYs.' },
    })!;

    expect(service.getArticle(article.id)!.tooltips)
      .toEqual({ daemon: '### The daemon\n\nOwns the PTYs.' });
  });

  it('replaces the whole tooltips object rather than merging into it', () => {
    const map = service.createMap('tooltips-replace').map;
    const article = service.createArticle(map.id, {
      title: 'T',
      content_md: '',
      tooltips: { one: 'first', two: 'second' },
    })!;

    // Merging is the route's job — storage takes what it is given, so a caller
    // that wants to drop a stale concept can.
    const updated = service.updateArticle(article.id, { tooltips: { one: 'rewritten' } })!;
    expect(updated.tooltips).toEqual({ one: 'rewritten' });
  });

  it('reads a corrupt or wrongly-shaped tooltips column as empty', () => {
    const map = service.createMap('tooltips-corrupt').map;
    const article = service.createArticle(map.id, { title: 'T', content_md: '' })!;

    for (const stored of ['not json at all', '["an","array"]', 'null', '17']) {
      db.prepare('UPDATE km_articles SET tooltips = ? WHERE id = ?').run(stored, article.id);
      expect(service.getArticle(article.id)!.tooltips).toEqual({});
    }
  });

  it('drops non-string tooltip values but keeps the usable entries', () => {
    const map = service.createMap('tooltips-mixed').map;
    const article = service.createArticle(map.id, { title: 'T', content_md: '' })!;

    db.prepare('UPDATE km_articles SET tooltips = ? WHERE id = ?')
      .run('{"good":"### Fine","bad":42,"alsoBad":null}', article.id);

    expect(service.getArticle(article.id)!.tooltips).toEqual({ good: '### Fine' });
  });

  it('keeps tooltips out of the map payload', () => {
    const map = service.createMap('tooltips-map-payload').map;
    const article = service.createArticle(map.id, {
      title: 'T',
      content_md: '**a**',
      tooltips: { a: 'a long explanation that must not ride along with the map' },
    })!;

    const detail = service.getMapDetail(map.id)!;
    expect(detail.articles[0]).not.toHaveProperty('tooltips');
    expect(service.getArticle(article.id)!.tooltips).toEqual({
      a: 'a long explanation that must not ride along with the map',
    });
  });

  it('returns null map detail for an unknown map id', () => {
    expect(service.getMapDetail('km-map-nope')).toBeNull();
  });

  it('moves updated_at forward on update and leaves untouched fields alone', () => {
    const map = service.createMap('updates').map;
    const article = service.createArticle(map.id, { title: 'Old', content_md: 'body' })!;

    const updated = service.updateArticle(article.id, { title: 'New' })!;
    expect(updated.title).toBe('New');
    expect(updated.content_md).toBe('body');
    expect(updated.updated_at).toBeGreaterThanOrEqual(article.updated_at);
  });

  it('clears a pin when pinned_x is explicitly null', () => {
    const map = service.createMap('unpin').map;
    const article = service.createArticle(map.id, { title: 'T', content_md: 'B' })!;
    service.updateArticle(article.id, { pinned_x: 4, pinned_y: 5 });

    const cleared = service.updateArticle(article.id, { pinned_x: null })!;
    expect(cleared.pinned_x).toBeNull();
    expect(cleared.pinned_y).toBe(5);
  });

  it('refuses an edge whose endpoint lives in a different map', () => {
    const a = service.createMap('edge-a').map;
    const b = service.createMap('edge-b').map;
    const inA = service.createArticle(a.id, { title: 'A', content_md: '' })!;
    const inB = service.createArticle(b.id, { title: 'B', content_md: '' })!;

    const result = service.createEdge(a.id, {
      from_article_id: inA.id,
      to_article_id: inB.id,
      kind: 'related',
    });

    expect(result).toEqual({ missing: 'to_article_id' });
  });

  it('names which endpoint is missing', () => {
    const map = service.createMap('edge-missing').map;
    const article = service.createArticle(map.id, { title: 'A', content_md: '' })!;

    expect(service.createEdge(map.id, {
      from_article_id: 'km-art-nope',
      to_article_id: article.id,
      kind: 'follow',
    })).toEqual({ missing: 'from_article_id' });

    expect(service.createEdge('km-map-nope', {
      from_article_id: article.id,
      to_article_id: article.id,
      kind: 'follow',
    })).toEqual({ missing: 'map' });
  });

  it('returns edges in the map detail', () => {
    const map = service.createMap('edges').map;
    const from = service.createArticle(map.id, { title: 'Q', content_md: '', node_type: 'concept' })!;
    const to = service.createArticle(map.id, { title: 'A', content_md: '' })!;

    for (const kind of KM_EDGE_KINDS) {
      service.createEdge(map.id, { from_article_id: from.id, to_article_id: to.id, kind });
    }

    const detail = service.getMapDetail(map.id)!;
    expect(detail.edges.map(e => e.kind)).toEqual([...KM_EDGE_KINDS]);
  });

  it('creates an exchange with a null answer and fills it in later', () => {
    const map = service.createMap('exchanges').map;
    const article = service.createArticle(map.id, { title: 'T', content_md: 'body' })!;

    const exchange = service.createExchange(article.id, {
      quote: 'the daemon owns the PTY',
      quote_start: 42,
      question: 'what happens on server restart?',
    })!;

    expect(exchange.answer_md).toBeNull();
    expect(exchange.quote_start).toBe(42);

    const answered = service.answerExchange(exchange.id, 'The session survives; the turn does not.')!;
    expect(answered.answer_md).toBe('The session survives; the turn does not.');
    expect(answered.quote).toBe('the daemon owns the PTY');

    const detail = service.getArticleDetail(article.id)!;
    expect(detail.exchanges).toHaveLength(1);
    expect(detail.exchanges[0].answer_md).toBe('The session survives; the turn does not.');
    expect(detail.article.content_md).toBe('body');
  });

  it('accepts a null quote_start for an unambiguous quote', () => {
    const map = service.createMap('nullable-start').map;
    const article = service.createArticle(map.id, { title: 'T', content_md: '' })!;
    const exchange = service.createExchange(article.id, { quote: 'q', question: 'why?' })!;
    expect(exchange.quote_start).toBeNull();
  });

  it('returns null for exchanges and answers against unknown ids', () => {
    expect(service.createExchange('km-art-nope', { quote: 'q', question: 'q?' })).toBeNull();
    expect(service.answerExchange('km-exch-nope', 'answer')).toBeNull();
    expect(service.getArticleDetail('km-art-nope')).toBeNull();
  });
});

describe('km_maps.default_conv migration', () => {
  afterEach(() => {
    DatabaseProvider.resetInstance();
    KnowledgeMapService.resetInstance();
  });

  it('adds the column to a km_maps table created before it existed', () => {
    const db = freshDb();

    // The pre-default_conv shape, as an older database on disk still has it.
    db.exec(`
      DROP TABLE km_maps;
      CREATE TABLE km_maps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      INSERT INTO km_maps (id, name, created_at) VALUES ('km-map-old', 'legacy', 1);
    `);
    const before = (db.pragma('table_info(km_maps)') as Array<{ name: string }>).map(c => c.name);
    expect(before).not.toContain('default_conv');

    runSessionInfoSchemaBootstrap(db, createLogger('KmMigrationTest'));

    const after = (db.pragma('table_info(km_maps)') as Array<{ name: string }>).map(c => c.name);
    expect(after).toContain('default_conv');

    // The pre-existing row survives and reads as "no default set".
    const service = new KnowledgeMapService(db);
    expect(service.getMap('km-map-old')).toMatchObject({
      id: 'km-map-old',
      name: 'legacy',
      default_conv: null,
    });
  });
});

describe('km_articles.tooltips migration', () => {
  afterEach(() => {
    DatabaseProvider.resetInstance();
    KnowledgeMapService.resetInstance();
  });

  it('adds the column to a km_articles table created before it existed', () => {
    const db = freshDb();

    // The pre-tooltips shape, as an older database on disk still has it.
    db.exec(`
      DROP TABLE km_articles;
      CREATE TABLE km_articles (
        id TEXT PRIMARY KEY,
        map_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content_md TEXT NOT NULL,
        summary TEXT,
        takeaways TEXT,
        node_type TEXT NOT NULL DEFAULT 'article',
        created_from TEXT,
        created_by_conv TEXT,
        pinned_x REAL,
        pinned_y REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO km_maps (id, name, created_at) VALUES ('km-map-old', 'legacy', 1);
      INSERT INTO km_articles (id, map_id, title, content_md, created_at, updated_at)
        VALUES ('km-art-old', 'km-map-old', 'Legacy', '**bold**', 1, 1);
    `);
    const before = (db.pragma('table_info(km_articles)') as Array<{ name: string }>).map(c => c.name);
    expect(before).not.toContain('tooltips');

    runSessionInfoSchemaBootstrap(db, createLogger('KmTooltipsMigrationTest'));

    const after = (db.pragma('table_info(km_articles)') as Array<{ name: string }>).map(c => c.name);
    expect(after).toContain('tooltips');

    // The pre-existing row survives, and its NULL column reads as "none yet"
    // rather than blowing up the article fetch.
    const service = new KnowledgeMapService(db);
    const article = service.getArticle('km-art-old')!;
    expect(article.title).toBe('Legacy');
    expect(article.tooltips).toEqual({});

    // And it is writable straight after the ALTER.
    expect(service.updateArticle('km-art-old', { tooltips: { bold: '### Bold' } })!.tooltips)
      .toEqual({ bold: '### Bold' });
  });
});

describe('knowledge map vocabularies', () => {
  it('exposes the node types the plan names', () => {
    expect([...KM_NODE_TYPES]).toEqual([
      'article',
      'concept',
      'entity',
      'code-structure',
      'architecture-item',
    ]);
    expect(isKmNodeType('architecture-item')).toBe(true);
    expect(isKmNodeType('diagram')).toBe(false);
    expect(isKmNodeType(7)).toBe(false);
  });

  it('exposes exactly two edge kinds', () => {
    expect([...KM_EDGE_KINDS]).toEqual(['follow', 'related']);
    expect(isKmEdgeKind('related')).toBe(true);
    expect(isKmEdgeKind('question')).toBe(false);
    expect(isKmEdgeKind('answers')).toBe(false);
  });
});

describe('following a question out of an article', () => {
  let service: KnowledgeMapService;

  beforeEach(() => {
    service = new KnowledgeMapService(freshDb());
  });

  afterEach(() => {
    DatabaseProvider.resetInstance();
    KnowledgeMapService.resetInstance();
  });

  it('writes an empty child on the parent map and an edge carrying the question', () => {
    const map = service.createMap('trail').map;
    const parent = service.createArticle(map.id, {
      title: 'Event log',
      content_md: 'The **event log** is append-only.',
      created_by_conv: 'conv-parent',
    })!;

    const result = service.followArticle(parent.id, {
      question: 'Tell me more about append-only',
      concept: 'append-only',
      created_by_conv: 'conv-parent',
    })!;

    expect(result.article).toMatchObject({
      map_id: map.id,
      title: 'append-only',
      content_md: '',
      node_type: 'concept',
      created_from: parent.id,
      created_by_conv: 'conv-parent',
    });
    expect(result.edge).toMatchObject({
      map_id: map.id,
      from_article_id: parent.id,
      to_article_id: result.article.id,
      kind: 'follow',
      label: 'Tell me more about append-only',
    });

    const detail = service.getMapDetail(map.id)!;
    expect(detail.edges).toHaveLength(1);
    expect(detail.edges[0].label).toBe('Tell me more about append-only');
    // The child is on the map from the moment the question was followed, and
    // says its article has not been written yet.
    const child = detail.articles.find(a => a.id === result.article.id)!;
    expect(child.has_content).toBe(false);
    expect(detail.articles.find(a => a.id === parent.id)!.has_content).toBe(true);
  });

  it('titles the child with the question when no concept is given', () => {
    const map = service.createMap('trail-untitled').map;
    const parent = service.createArticle(map.id, { title: 'P', content_md: 'body' })!;

    const result = service.followArticle(parent.id, {
      question: 'What buffers these across a restart?',
    })!;

    expect(result.article.title).toBe('What buffers these across a restart?');
    expect(result.article.created_by_conv).toBeNull();
  });

  it('returns null for an unknown parent article', () => {
    expect(service.followArticle('km-art-nope', { question: 'why?' })).toBeNull();
  });
});
