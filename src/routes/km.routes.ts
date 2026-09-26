/**
 * Learning map routes — the agent write path for the knowledge map.
 *
 * Any Lattice session can draw on a map as part of answering, so this surface
 * is addressed by hand from a session rather than by a typed frontend client.
 * Bodies and responses are snake_case to match the column names an agent reads
 * about in docs/learning-map-api.md.
 *
 * Endpoints (mounted at /api/km):
 * - GET    /maps                        - list maps with article counts
 * - POST   /maps                        - upsert a map by name
 * - GET    /maps/:mapId                 - map, article headers (no bodies), edges
 * - PATCH  /maps/:mapId                 - set the map's default responder conversation
 * - POST   /maps/:mapId/articles        - create an article node
 * - POST   /maps/:mapId/edges           - link two articles
 * - GET    /articles/:articleId         - full article + its exchanges
 * - PATCH  /articles/:articleId         - update title/body/type/pins/tooltips
 * - POST   /articles/:articleId/follow    - follow a question to a new article
 * - POST   /articles/:articleId/tooltips  - explain the article's bold terms
 * - POST   /articles/:articleId/exchanges - ask about a highlighted span
 * - PATCH  /exchanges/:exchangeId       - fill in the answer
 */

import { Router } from 'express';
import { RequestWithRequestId } from '@/types/express.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { asyncHandler } from '@/middleware/error-handler.js';
import {
  KnowledgeMapService,
  KM_EDGE_KINDS,
  KM_NODE_TYPES,
  isKmEdgeKind,
  isKmNodeType,
  type KmEdgeKind,
  type KmNodeType,
  type UpdateArticleInput,
} from '@/services/km/knowledge-map-service.js';
import { extractBoldConcepts } from '@/services/km/extract-bold-concepts.js';
import {
  AnthropicTooltipGenerator,
  type TooltipGenerator,
} from '@/services/km/tooltip-generator.js';

interface CreateMapBody {
  name?: unknown;
}

interface UpdateMapBody {
  default_conv?: unknown;
}

interface CreateArticleBody {
  title?: unknown;
  content_md?: unknown;
  summary?: unknown;
  takeaways?: unknown;
  node_type?: unknown;
  created_from?: unknown;
  created_by_conv?: unknown;
}

interface UpdateArticleBody {
  title?: unknown;
  content_md?: unknown;
  summary?: unknown;
  takeaways?: unknown;
  tooltips?: unknown;
  node_type?: unknown;
  created_by_conv?: unknown;
  pinned_x?: unknown;
  pinned_y?: unknown;
}

interface FollowArticleBody {
  question?: unknown;
  concept?: unknown;
  created_by_conv?: unknown;
}

interface GenerateTooltipsBody {
  force?: unknown;
}

interface CreateEdgeBody {
  from_article_id?: unknown;
  to_article_id?: unknown;
  kind?: unknown;
  label?: unknown;
}

interface CreateExchangeBody {
  quote?: unknown;
  quote_start?: unknown;
  question?: unknown;
}

interface AnswerExchangeBody {
  answer_md?: unknown;
}

const NODE_TYPE_LIST = KM_NODE_TYPES.join(', ');
const EDGE_KIND_LIST = KM_EDGE_KINDS.join(', ');

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Optional free-text provenance: a string, or explicitly null, or absent. */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Node bullets: absent, or an array of strings. */
function isTakeaways(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Concept → markdown. A plain object of strings; arrays and null are not it. */
function isTooltips(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

export interface KnowledgeMapRouteDependencies {
  service?: KnowledgeMapService;
  /** Injectable so the tooltip endpoint can be driven without a model. */
  tooltipGenerator?: TooltipGenerator;
}

export function createKnowledgeMapRoutes(
  dependencies: KnowledgeMapRouteDependencies = {},
): Router {
  const router = Router();
  const logger = createLogger('KnowledgeMapRoutes');
  const service = dependencies.service ?? KnowledgeMapService.getInstance();
  const tooltipGenerator = dependencies.tooltipGenerator ?? new AnthropicTooltipGenerator();

  // GET /api/km/maps
  router.get('/maps', asyncHandler(async (req: RequestWithRequestId, res) => {
    const maps = service.listMaps();
    logger.debug('Listed knowledge maps', { requestId: req.requestId, count: maps.length });
    res.json({ maps });
  }));

  // POST /api/km/maps — upsert by name, because agents address maps by name.
  router.post('/maps', asyncHandler(async (req: RequestWithRequestId, res) => {
    const body = req.body as CreateMapBody;

    if (!isNonEmptyString(body.name)) {
      res.status(400).json({ error: 'name is required and must be a non-empty string' });
      return;
    }

    const { map, created } = service.createMap(body.name.trim());
    res.status(created ? 201 : 200).json({ map, created });
  }));

  // GET /api/km/maps/:mapId
  router.get('/maps/:mapId', asyncHandler(async (req: RequestWithRequestId, res) => {
    const detail = service.getMapDetail(req.params.mapId);
    if (!detail) {
      res.status(404).json({ error: `No map with id "${req.params.mapId}"` });
      return;
    }
    res.json(detail);
  }));

  // PATCH /api/km/maps/:mapId — currently only the default responder session.
  router.patch('/maps/:mapId', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { mapId } = req.params;
    const body = req.body as UpdateMapBody;

    if (body.default_conv === undefined) {
      res.status(400).json({ error: 'default_conv is required' });
      return;
    }
    if (!isNullableString(body.default_conv)) {
      res.status(400).json({ error: 'default_conv must be a string or null' });
      return;
    }

    const map = service.updateMap(mapId, {
      default_conv: body.default_conv === null ? null : body.default_conv.trim() || null,
    });
    if (!map) {
      res.status(404).json({ error: `No map with id "${mapId}"` });
      return;
    }

    logger.debug('Knowledge map updated', { requestId: req.requestId, id: mapId });
    res.json({ map });
  }));

  // POST /api/km/maps/:mapId/articles
  router.post('/maps/:mapId/articles', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { mapId } = req.params;
    const body = req.body as CreateArticleBody;

    if (!isNonEmptyString(body.title)) {
      res.status(400).json({ error: 'title is required and must be a non-empty string' });
      return;
    }
    if (typeof body.content_md !== 'string') {
      res.status(400).json({ error: 'content_md is required and must be a string' });
      return;
    }
    if (body.node_type !== undefined && !isKmNodeType(body.node_type)) {
      res.status(400).json({ error: `node_type must be one of: ${NODE_TYPE_LIST}` });
      return;
    }
    if (body.summary !== undefined && !isNullableString(body.summary)) {
      res.status(400).json({ error: 'summary must be a string or null' });
      return;
    }
    if (body.takeaways !== undefined && !isTakeaways(body.takeaways)) {
      res.status(400).json({ error: 'takeaways must be an array of strings' });
      return;
    }
    if (body.created_from !== undefined && !isNullableString(body.created_from)) {
      res.status(400).json({ error: 'created_from must be a string or null' });
      return;
    }
    if (body.created_by_conv !== undefined && !isNullableString(body.created_by_conv)) {
      res.status(400).json({ error: 'created_by_conv must be a string or null' });
      return;
    }

    const article = service.createArticle(mapId, {
      title: body.title.trim(),
      content_md: body.content_md,
      summary: body.summary as string | null | undefined,
      takeaways: body.takeaways as string[] | undefined,
      node_type: body.node_type as KmNodeType | undefined,
      created_from: body.created_from as string | null | undefined,
      created_by_conv: body.created_by_conv as string | null | undefined,
    });

    if (!article) {
      res.status(404).json({ error: `No map with id "${mapId}"` });
      return;
    }

    logger.info('Knowledge map article created', {
      requestId: req.requestId,
      id: article.id,
      mapId,
    });
    res.status(201).json({ article });
  }));

  // POST /api/km/maps/:mapId/edges
  router.post('/maps/:mapId/edges', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { mapId } = req.params;
    const body = req.body as CreateEdgeBody;

    if (!isNonEmptyString(body.from_article_id)) {
      res.status(400).json({ error: 'from_article_id is required and must be a non-empty string' });
      return;
    }
    if (!isNonEmptyString(body.to_article_id)) {
      res.status(400).json({ error: 'to_article_id is required and must be a non-empty string' });
      return;
    }
    if (!isKmEdgeKind(body.kind)) {
      res.status(400).json({ error: `kind must be one of: ${EDGE_KIND_LIST}` });
      return;
    }
    if (body.label !== undefined && !isNullableString(body.label)) {
      res.status(400).json({ error: 'label must be a string or null' });
      return;
    }

    const result = service.createEdge(mapId, {
      from_article_id: body.from_article_id,
      to_article_id: body.to_article_id,
      kind: body.kind as KmEdgeKind,
      label: body.label as string | null | undefined,
    });

    if ('missing' in result) {
      const message = result.missing === 'map'
        ? `No map with id "${mapId}"`
        : `No article with id "${result.missing === 'from_article_id'
            ? body.from_article_id
            : body.to_article_id}" in map "${mapId}"`;
      res.status(404).json({ error: message });
      return;
    }

    res.status(201).json({ edge: result.edge });
  }));

  // GET /api/km/articles/:articleId
  router.get('/articles/:articleId', asyncHandler(async (req: RequestWithRequestId, res) => {
    const detail = service.getArticleDetail(req.params.articleId);
    if (!detail) {
      res.status(404).json({ error: `No article with id "${req.params.articleId}"` });
      return;
    }
    res.json(detail);
  }));

  // PATCH /api/km/articles/:articleId
  router.patch('/articles/:articleId', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { articleId } = req.params;
    const body = req.body as UpdateArticleBody;

    if (body.title !== undefined && !isNonEmptyString(body.title)) {
      res.status(400).json({ error: 'title must be a non-empty string' });
      return;
    }
    if (body.content_md !== undefined && typeof body.content_md !== 'string') {
      res.status(400).json({ error: 'content_md must be a string' });
      return;
    }
    if (body.node_type !== undefined && !isKmNodeType(body.node_type)) {
      res.status(400).json({ error: `node_type must be one of: ${NODE_TYPE_LIST}` });
      return;
    }
    if (body.summary !== undefined && !isNullableString(body.summary)) {
      res.status(400).json({ error: 'summary must be a string or null' });
      return;
    }
    if (body.takeaways !== undefined && !isTakeaways(body.takeaways)) {
      res.status(400).json({ error: 'takeaways must be an array of strings' });
      return;
    }
    if (body.tooltips !== undefined && !isTooltips(body.tooltips)) {
      res.status(400).json({
        error: 'tooltips must be an object mapping each concept to a markdown string',
      });
      return;
    }
    if (body.created_by_conv !== undefined && !isNullableString(body.created_by_conv)) {
      res.status(400).json({ error: 'created_by_conv must be a string or null' });
      return;
    }
    if (body.pinned_x !== undefined && !isNullableFiniteNumber(body.pinned_x)) {
      res.status(400).json({ error: 'pinned_x must be a number or null' });
      return;
    }
    if (body.pinned_y !== undefined && !isNullableFiniteNumber(body.pinned_y)) {
      res.status(400).json({ error: 'pinned_y must be a number or null' });
      return;
    }

    const updates: UpdateArticleInput = {
      ...(body.title !== undefined && { title: (body.title as string).trim() }),
      ...(body.content_md !== undefined && { content_md: body.content_md as string }),
      ...(body.summary !== undefined && { summary: body.summary as string | null }),
      ...(body.takeaways !== undefined && { takeaways: body.takeaways as string[] }),
      ...(body.tooltips !== undefined && { tooltips: body.tooltips as Record<string, string> }),
      ...(body.node_type !== undefined && { node_type: body.node_type as KmNodeType }),
      ...(body.created_by_conv !== undefined && {
        created_by_conv: body.created_by_conv as string | null,
      }),
      ...(body.pinned_x !== undefined && { pinned_x: body.pinned_x as number | null }),
      ...(body.pinned_y !== undefined && { pinned_y: body.pinned_y as number | null }),
    };

    if (Object.keys(updates).length === 0) {
      res.status(400).json({
        error: 'At least one of title, content_md, summary, takeaways, tooltips, node_type, created_by_conv, pinned_x, pinned_y is required',
      });
      return;
    }

    const article = service.updateArticle(articleId, updates);
    if (!article) {
      res.status(404).json({ error: `No article with id "${articleId}"` });
      return;
    }

    logger.debug('Knowledge map article updated', { requestId: req.requestId, id: articleId });
    res.json({ article });
  }));

  // POST /api/km/articles/:articleId/follow
  //
  // The reader asked something inside this article and went somewhere new. That
  // move is the edge: an empty child node on the same map, and a `follow` edge
  // into it whose label is the question. The child's body is written afterwards
  // by whoever is answering — this endpoint only records the move.
  router.post('/articles/:articleId/follow', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { articleId } = req.params;
    const body = (req.body ?? {}) as FollowArticleBody;

    if (!isNonEmptyString(body.question)) {
      res.status(400).json({ error: 'question is required and must be a non-empty string' });
      return;
    }
    if (body.concept !== undefined && !isNullableString(body.concept)) {
      res.status(400).json({ error: 'concept must be a string or null' });
      return;
    }
    if (body.created_by_conv !== undefined && !isNullableString(body.created_by_conv)) {
      res.status(400).json({ error: 'created_by_conv must be a string or null' });
      return;
    }

    const result = service.followArticle(articleId, {
      question: body.question.trim(),
      concept: body.concept as string | null | undefined,
      created_by_conv: body.created_by_conv as string | null | undefined,
    });

    if (!result) {
      res.status(404).json({ error: `No article with id "${articleId}"` });
      return;
    }

    logger.info('Knowledge map question followed', {
      requestId: req.requestId,
      parentArticleId: articleId,
      articleId: result.article.id,
      edgeId: result.edge.id,
    });
    res.status(201).json(result);
  }));

  // POST /api/km/articles/:articleId/tooltips
  //
  // Explains the article's bold terms. Only concepts with no tooltip yet go to
  // the model, so editing an article and re-posting pays for the new terms
  // alone; `force` re-explains all of them. Tooltips for terms that are no
  // longer bold are kept rather than pruned — a term that comes back after an
  // edit should not have to be paid for twice.
  router.post('/articles/:articleId/tooltips', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { articleId } = req.params;
    const body = (req.body ?? {}) as GenerateTooltipsBody;

    if (body.force !== undefined && typeof body.force !== 'boolean') {
      res.status(400).json({ error: 'force must be a boolean' });
      return;
    }

    const article = service.getArticle(articleId);
    if (!article) {
      res.status(404).json({ error: `No article with id "${articleId}"` });
      return;
    }

    const concepts = extractBoldConcepts(article.content_md);
    const force = body.force === true;
    const missing = force
      ? concepts
      : concepts.filter((concept) => article.tooltips[concept] === undefined);

    // Nothing to explain, or nothing new: answer from storage without spending
    // a call. An article with no bold text never reaches the model at all,
    // which is what makes this safe to post unconditionally after an edit.
    if (missing.length === 0) {
      res.json({ tooltips: article.tooltips, generated: 0, failed: 0 });
      return;
    }

    // Missing credentials throw out of the generator and land as a 400 naming
    // the problem. Returning an empty object instead would be indistinguishable
    // from an article the model had nothing to say about.
    const result = await tooltipGenerator.generate({
      concepts: missing,
      title: article.title,
      content_md: article.content_md,
    });

    const tooltips = { ...article.tooltips, ...result.tooltips };
    const updated = service.updateArticle(articleId, { tooltips });

    logger.info('Knowledge map tooltips generated', {
      requestId: req.requestId,
      id: articleId,
      requested: missing.length,
      generated: Object.keys(result.tooltips).length,
      failed: result.failed.length,
      force,
    });

    res.json({
      tooltips: updated?.tooltips ?? tooltips,
      generated: Object.keys(result.tooltips).length,
      failed: result.failed.length,
    });
  }));

  // POST /api/km/articles/:articleId/exchanges
  router.post('/articles/:articleId/exchanges', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { articleId } = req.params;
    const body = req.body as CreateExchangeBody;

    if (!isNonEmptyString(body.quote)) {
      res.status(400).json({ error: 'quote is required and must be a non-empty string' });
      return;
    }
    if (!isNonEmptyString(body.question)) {
      res.status(400).json({ error: 'question is required and must be a non-empty string' });
      return;
    }
    if (
      body.quote_start !== undefined
      && !(body.quote_start === null
        || (typeof body.quote_start === 'number' && Number.isInteger(body.quote_start) && body.quote_start >= 0))
    ) {
      res.status(400).json({ error: 'quote_start must be a non-negative integer or null' });
      return;
    }

    const exchange = service.createExchange(articleId, {
      quote: body.quote,
      quote_start: body.quote_start as number | null | undefined,
      question: body.question.trim(),
    });

    if (!exchange) {
      res.status(404).json({ error: `No article with id "${articleId}"` });
      return;
    }

    res.status(201).json({ exchange });
  }));

  // PATCH /api/km/exchanges/:exchangeId
  router.patch('/exchanges/:exchangeId', asyncHandler(async (req: RequestWithRequestId, res) => {
    const { exchangeId } = req.params;
    const body = req.body as AnswerExchangeBody;

    if (typeof body.answer_md !== 'string') {
      res.status(400).json({ error: 'answer_md is required and must be a string' });
      return;
    }

    const exchange = service.answerExchange(exchangeId, body.answer_md);
    if (!exchange) {
      res.status(404).json({ error: `No exchange with id "${exchangeId}"` });
      return;
    }

    res.json({ exchange });
  }));

  return router;
}
