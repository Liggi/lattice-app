/**
 * KnowledgeMapService — storage for the learning map.
 *
 * Owns km_maps / km_articles / km_edges / km_exchanges (DDL lives in
 * session-info-migrations.ts). Any Lattice session can write typed article
 * nodes here over plain HTTP as a way of answering; see km.routes.ts for the
 * surface and docs/learning-map-api.md for the agent-facing contract.
 *
 * Field names stay snake_case end to end. The consumer is an agent composing
 * JSON bodies from the doc, so the column name and the wire name being the
 * same thing is the point.
 *
 * Lookups return null for a missing parent row rather than throwing, because
 * "which id was wrong" is the route layer's problem to turn into a 404. This
 * database does not enable `PRAGMA foreign_keys`, so parent existence is
 * checked here rather than by the engine.
 */

import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { parseJson } from '../../utils/json.js';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import type Database from 'better-sqlite3';

export const KM_NODE_TYPES = [
  'article',
  'concept',
  'entity',
  'code-structure',
  'architecture-item',
] as const;

export type KmNodeType = (typeof KM_NODE_TYPES)[number];

/**
 * An edge is a move the reader made, not a relationship someone asserted.
 * `follow` means "I asked this question here and it took me there", and the
 * question itself travels on the edge's `label`. `related` is the only other
 * kind: a link nobody asked for, carrying no label.
 */
export const KM_EDGE_KINDS = ['follow', 'related'] as const;

export type KmEdgeKind = (typeof KM_EDGE_KINDS)[number];

export function isKmNodeType(value: unknown): value is KmNodeType {
  return typeof value === 'string' && (KM_NODE_TYPES as readonly string[]).includes(value);
}

export function isKmEdgeKind(value: unknown): value is KmEdgeKind {
  return typeof value === 'string' && (KM_EDGE_KINDS as readonly string[]).includes(value);
}

export interface KmMap {
  id: string;
  name: string;
  /**
   * Conversation that answers inline highlight→ask questions for articles with
   * no `created_by_conv` of their own. Null until the first such ask creates
   * one; the article surface then saves it here so later asks reuse it.
   */
  default_conv: string | null;
  created_at: number;
}

export interface KmMapSummary extends KmMap {
  article_count: number;
}

export interface KmArticle {
  id: string;
  map_id: string;
  title: string;
  content_md: string;
  /**
   * The sentence or two a map node shows. Nodes read as cards, not chips, so a
   * node without a summary falls back to its title and looks thinner.
   */
  summary: string | null;
  /** Short bullets under the summary on the node. Stored as a JSON array. */
  takeaways: string[];
  /**
   * Hover explanations for the bold terms in `content_md`, keyed by the bold
   * text exactly as it appears. Stored as a JSON object; `{}` when none have
   * been generated. Only present on the full article, never on the map payload
   * — a map of twenty nodes does not need twenty articles' worth of tooltips.
   */
  tooltips: Record<string, string>;
  node_type: KmNodeType;
  created_from: string | null;
  created_by_conv: string | null;
  pinned_x: number | null;
  pinned_y: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * An article as it appears in the map view: no body, enough to draw the node.
 *
 * `has_content` stands in for the body the map payload deliberately does not
 * carry. A node created by following a question exists before its article is
 * written, and the canvas has to be able to draw that node as pending rather
 * than as an article with a blank body.
 */
export type KmArticleSummary = Omit<KmArticle, 'content_md' | 'tooltips'> & {
  has_content: boolean;
};

export interface KmEdge {
  id: string;
  map_id: string;
  from_article_id: string;
  to_article_id: string;
  kind: KmEdgeKind;
  /**
   * The question that produced this move, shown on the line on the canvas.
   * Null for a `related` link, and for `follow` edges written before edges
   * carried their question.
   */
  label: string | null;
  created_at: number;
}

export interface KmExchange {
  id: string;
  article_id: string;
  quote: string;
  quote_start: number | null;
  question: string;
  answer_md: string | null;
  created_at: number;
}

export interface KmMapDetail {
  map: KmMap;
  articles: KmArticleSummary[];
  edges: KmEdge[];
}

export interface KmArticleDetail {
  article: KmArticle;
  exchanges: KmExchange[];
}

export interface CreateArticleInput {
  title: string;
  content_md: string;
  summary?: string | null;
  takeaways?: string[];
  tooltips?: Record<string, string>;
  node_type?: KmNodeType;
  created_from?: string | null;
  created_by_conv?: string | null;
}

export interface UpdateArticleInput {
  title?: string;
  content_md?: string;
  summary?: string | null;
  takeaways?: string[];
  tooltips?: Record<string, string>;
  node_type?: KmNodeType;
  /**
   * Writable because an article can be created empty and filled in later by a
   * session that did not exist when the node was made — the writer records
   * which conversation actually wrote the body.
   */
  created_by_conv?: string | null;
  pinned_x?: number | null;
  pinned_y?: number | null;
}

export interface UpdateMapInput {
  default_conv?: string | null;
}

export interface CreateEdgeInput {
  from_article_id: string;
  to_article_id: string;
  kind: KmEdgeKind;
  /** The question this move was made by. Kept verbatim; never truncated. */
  label?: string | null;
}

/** Following a question out of an article: the child node and the edge to it. */
export interface FollowArticleInput {
  question: string;
  /** The bold term the question was raised on. Titles the child article. */
  concept?: string | null;
  created_by_conv?: string | null;
}

export interface FollowArticleResult {
  article: KmArticle;
  edge: KmEdge;
}

export interface CreateExchangeInput {
  quote: string;
  quote_start?: number | null;
  question: string;
}

const MAP_COLUMNS = 'id, name, default_conv, created_at';

const ARTICLE_COLUMNS = `
  id, map_id, title, content_md, summary, takeaways, tooltips, node_type,
  created_from, created_by_conv, pinned_x, pinned_y, created_at, updated_at
`;

const ARTICLE_SUMMARY_COLUMNS = `
  id, map_id, title, summary, takeaways, node_type, created_from,
  created_by_conv, pinned_x, pinned_y, created_at, updated_at,
  (content_md <> '') AS has_content
`;

const EDGE_COLUMNS = 'id, map_id, from_article_id, to_article_id, kind, label, created_at';

/** `takeaways` is stored as a JSON array; anything unparseable reads as empty. */
function parseTakeaways(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed = parseJson(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/**
 * `tooltips` is stored as a JSON object of concept → markdown; anything
 * unparseable, or any non-string value inside it, reads as absent rather than
 * throwing. The column is NULL for every article written before tooltips
 * existed, so "no tooltips" has to be the quiet default.
 */
function parseTooltips(value: unknown): Record<string, string> {
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = parseJson(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const tooltips: Record<string, string> = {};
    for (const [concept, tooltip] of Object.entries(parsed)) {
      if (typeof tooltip === 'string') tooltips[concept] = tooltip;
    }
    return tooltips;
  } catch {
    return {};
  }
}

/**
 * The map payload's `has_content` arrives from SQLite as 0/1. Summaries are the
 * only rows that select it, so the conversion lives with them rather than in
 * the shared article hydration.
 */
function hydrateArticleSummaryRow(row: KmArticleSummary): KmArticleSummary {
  return { ...hydrateArticleRow(row), has_content: Boolean(row.has_content) };
}

/** Rows come back with `takeaways` as JSON text; callers want the array. */
function hydrateArticleRow<T extends { takeaways?: unknown }>(row: T): T {
  return { ...row, takeaways: parseTakeaways(row.takeaways) };
}

/**
 * The full article additionally carries `tooltips` as JSON text. Kept separate
 * from `hydrateArticleRow` because the map payload selects no tooltips column
 * at all, and hydrating a column that was never selected would invent a field.
 */
function hydrateFullArticleRow<T extends { takeaways?: unknown; tooltips?: unknown }>(row: T): T {
  return { ...hydrateArticleRow(row), tooltips: parseTooltips(row.tooltips) };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class KnowledgeMapService {
  private static instance: KnowledgeMapService;
  private logger: Logger;
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.logger = createLogger('KnowledgeMapService');
    this.db = db ?? DatabaseProvider.getInstance().getDb();
  }

  static getInstance(): KnowledgeMapService {
    if (!KnowledgeMapService.instance) {
      KnowledgeMapService.instance = new KnowledgeMapService();
    }
    return KnowledgeMapService.instance;
  }

  static resetInstance(): void {
    KnowledgeMapService.instance = null as unknown as KnowledgeMapService;
  }

  listMaps(): KmMapSummary[] {
    return this.db.prepare(`
      SELECT m.id, m.name, m.default_conv, m.created_at,
             COUNT(a.id) AS article_count
      FROM km_maps m
      LEFT JOIN km_articles a ON a.map_id = m.id
      GROUP BY m.id, m.name, m.default_conv, m.created_at
      ORDER BY m.created_at DESC
    `).all() as KmMapSummary[];
  }

  getMapByName(name: string): KmMap | null {
    const row = this.db.prepare(
      `SELECT ${MAP_COLUMNS} FROM km_maps WHERE name = ?`
    ).get(name) as KmMap | undefined;
    return row ?? null;
  }

  getMap(mapId: string): KmMap | null {
    const row = this.db.prepare(
      `SELECT ${MAP_COLUMNS} FROM km_maps WHERE id = ?`
    ).get(mapId) as KmMap | undefined;
    return row ?? null;
  }

  /**
   * Upsert by name. Agents address maps by name, not id, so asking for a map
   * that already exists has to hand back the existing one instead of failing
   * or forking a second map with the same name.
   */
  createMap(name: string): { map: KmMap; created: boolean } {
    const existing = this.getMapByName(name);
    if (existing) {
      return { map: existing, created: false };
    }

    const map: KmMap = {
      id: generateId('km-map'),
      name,
      default_conv: null,
      created_at: Date.now(),
    };
    this.db.prepare(
      'INSERT INTO km_maps (id, name, default_conv, created_at) VALUES (?, ?, ?, ?)'
    ).run(map.id, map.name, map.default_conv, map.created_at);
    this.logger.info('Knowledge map created', { id: map.id, name: map.name });
    return { map, created: true };
  }

  /**
   * Currently only `default_conv`. Returns null when the map does not exist;
   * an empty update is a no-op that still returns the current row, so a caller
   * that sends nothing gets the map back rather than an error.
   */
  updateMap(mapId: string, updates: UpdateMapInput): KmMap | null {
    if (!this.getMap(mapId)) return null;

    if (updates.default_conv !== undefined) {
      this.db.prepare('UPDATE km_maps SET default_conv = ? WHERE id = ?')
        .run(updates.default_conv, mapId);
      this.logger.info('Knowledge map default conversation set', {
        id: mapId,
        defaultConv: updates.default_conv,
      });
    }

    return this.getMap(mapId);
  }

  /** Map plus the shape of its graph: article headers without bodies, and edges. */
  getMapDetail(mapId: string): KmMapDetail | null {
    const map = this.getMap(mapId);
    if (!map) return null;

    const articles = (this.db.prepare(`
      SELECT ${ARTICLE_SUMMARY_COLUMNS}
      FROM km_articles WHERE map_id = ? ORDER BY created_at ASC
    `).all(mapId) as KmArticleSummary[]).map(hydrateArticleSummaryRow);

    const edges = this.db.prepare(`
      SELECT ${EDGE_COLUMNS}
      FROM km_edges WHERE map_id = ? ORDER BY created_at ASC
    `).all(mapId) as KmEdge[];

    return { map, articles, edges };
  }

  getArticle(articleId: string): KmArticle | null {
    const row = this.db.prepare(
      `SELECT ${ARTICLE_COLUMNS} FROM km_articles WHERE id = ?`
    ).get(articleId) as KmArticle | undefined;
    return row ? hydrateFullArticleRow(row) : null;
  }

  getArticleDetail(articleId: string): KmArticleDetail | null {
    const article = this.getArticle(articleId);
    if (!article) return null;
    return { article, exchanges: this.listExchanges(articleId) };
  }

  listExchanges(articleId: string): KmExchange[] {
    return this.db.prepare(`
      SELECT id, article_id, quote, quote_start, question, answer_md, created_at
      FROM km_exchanges WHERE article_id = ? ORDER BY created_at ASC
    `).all(articleId) as KmExchange[];
  }

  /** Returns null when the map does not exist. */
  createArticle(mapId: string, input: CreateArticleInput): KmArticle | null {
    if (!this.getMap(mapId)) return null;

    const now = Date.now();
    const article: KmArticle = {
      id: generateId('km-art'),
      map_id: mapId,
      title: input.title,
      content_md: input.content_md,
      summary: input.summary ?? null,
      takeaways: input.takeaways ?? [],
      tooltips: input.tooltips ?? {},
      node_type: input.node_type ?? 'article',
      created_from: input.created_from ?? null,
      created_by_conv: input.created_by_conv ?? null,
      pinned_x: null,
      pinned_y: null,
      created_at: now,
      updated_at: now,
    };

    this.db.prepare(`
      INSERT INTO km_articles (
        id, map_id, title, content_md, summary, takeaways, tooltips, node_type,
        created_from, created_by_conv, pinned_x, pinned_y, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      article.id,
      article.map_id,
      article.title,
      article.content_md,
      article.summary,
      JSON.stringify(article.takeaways),
      JSON.stringify(article.tooltips),
      article.node_type,
      article.created_from,
      article.created_by_conv,
      article.pinned_x,
      article.pinned_y,
      article.created_at,
      article.updated_at,
    );

    this.logger.info('Knowledge map article created', {
      id: article.id,
      mapId,
      nodeType: article.node_type,
      createdByConv: article.created_by_conv,
    });
    return article;
  }

  /** Returns null when the article does not exist. */
  updateArticle(articleId: string, updates: UpdateArticleInput): KmArticle | null {
    if (!this.getArticle(articleId)) return null;

    const assignments: string[] = [];
    const params: Array<string | number | null> = [];

    if (updates.title !== undefined) {
      assignments.push('title = ?');
      params.push(updates.title);
    }
    if (updates.content_md !== undefined) {
      assignments.push('content_md = ?');
      params.push(updates.content_md);
    }
    if (updates.summary !== undefined) {
      assignments.push('summary = ?');
      params.push(updates.summary);
    }
    if (updates.takeaways !== undefined) {
      assignments.push('takeaways = ?');
      params.push(JSON.stringify(updates.takeaways));
    }
    if (updates.tooltips !== undefined) {
      assignments.push('tooltips = ?');
      params.push(JSON.stringify(updates.tooltips));
    }
    if (updates.node_type !== undefined) {
      assignments.push('node_type = ?');
      params.push(updates.node_type);
    }
    if (updates.created_by_conv !== undefined) {
      assignments.push('created_by_conv = ?');
      params.push(updates.created_by_conv);
    }
    if (updates.pinned_x !== undefined) {
      assignments.push('pinned_x = ?');
      params.push(updates.pinned_x);
    }
    if (updates.pinned_y !== undefined) {
      assignments.push('pinned_y = ?');
      params.push(updates.pinned_y);
    }

    if (assignments.length > 0) {
      assignments.push('updated_at = ?');
      params.push(Date.now());
      this.db.prepare(`
        UPDATE km_articles SET ${assignments.join(', ')} WHERE id = ?
      `).run(...params, articleId);
      this.logger.debug('Knowledge map article updated', {
        id: articleId,
        updatedFields: Object.keys(updates),
      });
    }

    return this.getArticle(articleId);
  }

  /**
   * Returns a `missing` marker instead of null so the route can say which id
   * was wrong — an agent linking two nodes gets one of three ids wrong often
   * enough that "not found" alone is not a useful answer.
   */
  createEdge(
    mapId: string,
    input: CreateEdgeInput,
  ): { edge: KmEdge } | { missing: 'map' | 'from_article_id' | 'to_article_id' } {
    if (!this.getMap(mapId)) return { missing: 'map' };

    const from = this.getArticle(input.from_article_id);
    if (!from || from.map_id !== mapId) return { missing: 'from_article_id' };

    const to = this.getArticle(input.to_article_id);
    if (!to || to.map_id !== mapId) return { missing: 'to_article_id' };

    const edge: KmEdge = {
      id: generateId('km-edge'),
      map_id: mapId,
      from_article_id: input.from_article_id,
      to_article_id: input.to_article_id,
      kind: input.kind,
      label: input.label ?? null,
      created_at: Date.now(),
    };

    this.db.prepare(`
      INSERT INTO km_edges (id, map_id, from_article_id, to_article_id, kind, label, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      edge.id,
      edge.map_id,
      edge.from_article_id,
      edge.to_article_id,
      edge.kind,
      edge.label,
      edge.created_at,
    );

    this.logger.info('Knowledge map edge created', { id: edge.id, mapId, kind: edge.kind });
    return { edge };
  }

  /**
   * Follow a question out of an article: an empty child node on the same map,
   * plus the `follow` edge that carries the question that got you there.
   *
   * One transaction, because a child article with no edge into it is a node
   * that fell off the trail — it would render as an orphan with no record of
   * why it exists. Returns null when the parent article does not exist.
   */
  followArticle(parentArticleId: string, input: FollowArticleInput): FollowArticleResult | null {
    const parent = this.getArticle(parentArticleId);
    if (!parent) return null;

    const question = input.question;
    const concept = input.concept?.trim();

    return this.db.transaction((): FollowArticleResult => {
      const article = this.createArticle(parent.map_id, {
        title: concept && concept !== '' ? concept : question,
        content_md: '',
        node_type: 'concept',
        created_from: parent.id,
        created_by_conv: input.created_by_conv ?? null,
      });
      // The map exists — the parent is on it — so createArticle cannot be null
      // here, but the type says it can and the transaction must not swallow it.
      if (!article) throw new Error(`No map with id "${parent.map_id}"`);

      const result = this.createEdge(parent.map_id, {
        from_article_id: parent.id,
        to_article_id: article.id,
        kind: 'follow',
        label: question,
      });
      if ('missing' in result) throw new Error(`Could not link to "${result.missing}"`);

      this.logger.info('Knowledge map question followed', {
        parentArticleId: parent.id,
        articleId: article.id,
        edgeId: result.edge.id,
      });
      return { article, edge: result.edge };
    })();
  }

  /** Returns null when the article does not exist. */
  createExchange(articleId: string, input: CreateExchangeInput): KmExchange | null {
    if (!this.getArticle(articleId)) return null;

    const exchange: KmExchange = {
      id: generateId('km-exch'),
      article_id: articleId,
      quote: input.quote,
      quote_start: input.quote_start ?? null,
      question: input.question,
      answer_md: null,
      created_at: Date.now(),
    };

    this.db.prepare(`
      INSERT INTO km_exchanges (
        id, article_id, quote, quote_start, question, answer_md, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      exchange.id,
      exchange.article_id,
      exchange.quote,
      exchange.quote_start,
      exchange.question,
      exchange.answer_md,
      exchange.created_at,
    );

    this.logger.debug('Knowledge map exchange created', { id: exchange.id, articleId });
    return exchange;
  }

  getExchange(exchangeId: string): KmExchange | null {
    const row = this.db.prepare(`
      SELECT id, article_id, quote, quote_start, question, answer_md, created_at
      FROM km_exchanges WHERE id = ?
    `).get(exchangeId) as KmExchange | undefined;
    return row ?? null;
  }

  /** Returns null when the exchange does not exist. */
  answerExchange(exchangeId: string, answerMd: string): KmExchange | null {
    if (!this.getExchange(exchangeId)) return null;
    this.db.prepare('UPDATE km_exchanges SET answer_md = ? WHERE id = ?')
      .run(answerMd, exchangeId);
    this.logger.debug('Knowledge map exchange answered', { id: exchangeId });
    return this.getExchange(exchangeId);
  }
}
