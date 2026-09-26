/**
 * Frontend client for the learning-map API (/api/km).
 *
 * Types mirror the wire format exactly — snake_case, matching the column names
 * documented in docs/learning-map-api.md — rather than the camelCase mapping
 * other services use, because the same shapes are what agents hand-compose
 * when they draw on a map. Kept self-contained (no imports from the server's
 * KnowledgeMapService) so the web typecheck never reaches into server code.
 */

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
 * question travels on the edge's `label`. `related` carries no label.
 */
export const KM_EDGE_KINDS = ['follow', 'related'] as const;
export type KmEdgeKind = (typeof KM_EDGE_KINDS)[number];

export interface KmMap {
  id: string;
  name: string;
  /**
   * Conversation that answers highlight→ask questions on articles with no
   * `created_by_conv`. Null until the article surface creates one and saves it.
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
  /** Sentence or two shown on the node itself; falls back to the title. */
  summary: string | null;
  /** Concept → markdown explanation, shown when hovering a bold term. */
  tooltips: Record<string, string>;
  /** Short bullets under the summary on the node. */
  takeaways: string[];
  node_type: KmNodeType;
  created_from: string | null;
  created_by_conv: string | null;
  pinned_x: number | null;
  pinned_y: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Map detail carries article headers without bodies. `has_content` stands in
 * for the body it does not carry, so the canvas can draw a node whose article
 * is still being written as pending rather than as a blank article.
 */
export type KmArticleSummary = Omit<KmArticle, 'content_md'> & {
  has_content: boolean;
};

export interface KmEdge {
  id: string;
  map_id: string;
  from_article_id: string;
  to_article_id: string;
  kind: KmEdgeKind;
  /** The question that produced this move. Null on a `related` link. */
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

async function kmRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/km${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    let message = `km request failed: ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; keep the status message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export function listMaps(): Promise<{ maps: KmMapSummary[] }> {
  return kmRequest('/maps');
}

/** Upsert by name: returns the existing map when the name is already taken. */
export function createMap(name: string): Promise<{ map: KmMap; created: boolean }> {
  return kmRequest('/maps', { method: 'POST', body: JSON.stringify({ name }) });
}

export function getMapDetail(mapId: string): Promise<KmMapDetail> {
  return kmRequest(`/maps/${encodeURIComponent(mapId)}`);
}

/** Set (or clear, with null) the map's default responder conversation. */
export function updateMap(
  mapId: string,
  updates: { default_conv: string | null },
): Promise<{ map: KmMap }> {
  return kmRequest(`/maps/${encodeURIComponent(mapId)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function createArticle(
  mapId: string,
  input: {
    title: string;
    content_md: string;
    summary?: string | null;
    takeaways?: string[];
    node_type?: KmNodeType;
    created_from?: string | null;
    created_by_conv?: string | null;
  },
): Promise<{ article: KmArticle }> {
  return kmRequest(`/maps/${encodeURIComponent(mapId)}/articles`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getArticleDetail(articleId: string): Promise<KmArticleDetail> {
  return kmRequest(`/articles/${encodeURIComponent(articleId)}`);
}

export function updateArticle(
  articleId: string,
  updates: {
    title?: string;
    content_md?: string;
    summary?: string | null;
    takeaways?: string[];
    node_type?: KmNodeType;
    /** The session that wrote the body, recorded once it has. */
    created_by_conv?: string | null;
    pinned_x?: number | null;
    pinned_y?: number | null;
  },
): Promise<{ article: KmArticle }> {
  return kmRequest(`/articles/${encodeURIComponent(articleId)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function createEdge(
  mapId: string,
  input: {
    from_article_id: string;
    to_article_id: string;
    kind: KmEdgeKind;
    label?: string | null;
  },
): Promise<{ edge: KmEdge }> {
  return kmRequest(`/maps/${encodeURIComponent(mapId)}/edges`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Follow a question out of an article: an empty child node on the same map plus
 * the `follow` edge carrying the question, written in one transaction. The
 * child's body is written afterwards by whoever answers.
 */
export function followArticle(
  articleId: string,
  input: { question: string; concept?: string | null; created_by_conv?: string | null },
): Promise<{ article: KmArticle; edge: KmEdge }> {
  return kmRequest(`/articles/${encodeURIComponent(articleId)}/follow`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createExchange(
  articleId: string,
  input: { quote: string; quote_start?: number | null; question: string },
): Promise<{ exchange: KmExchange }> {
  return kmRequest(`/articles/${encodeURIComponent(articleId)}/exchanges`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Explain the article's bold terms, generating only the ones not already
 * stored (or all of them with `force`). Returns the full tooltip map.
 */
export function generateTooltips(
  articleId: string,
  force = false,
): Promise<{ tooltips: Record<string, string>; generated: number; failed: number }> {
  return kmRequest(`/articles/${encodeURIComponent(articleId)}/tooltips`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  });
}

export function answerExchange(
  exchangeId: string,
  answer_md: string,
): Promise<{ exchange: KmExchange }> {
  return kmRequest(`/exchanges/${encodeURIComponent(exchangeId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ answer_md }),
  });
}
