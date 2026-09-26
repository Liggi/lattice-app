# Learning map API

The learning map is a knowledge map of typed article nodes. Any Lattice session
can write to it over plain HTTP, so drawing a node is a way of answering — peer
to writing prose in the chat, not a separate generator.

Base URL: `http://127.0.0.1:3001`. All paths below are under `/api/km`. There is
no auth; this is a local personal tool.

Field names in requests and responses are snake_case and match the column names.
Timestamps (`created_at`, `updated_at`) are integer epoch milliseconds.

## When to use it

You are drawing on a map when a piece of your answer is worth keeping and
linking rather than scrolling away: a concept the user will hit again, the shape
of a subsystem you just read, a question that opened up while you were working.

Set `created_by_conv` to your own `conv-*` id whenever you write an article. That
is what makes a drawn answer interrogable later — someone reading the node can
get back to the session that produced it. `created_from` is a free-text note
about the circumstance ("drawn while tracing a hang in the daemon"); it is for a
human reader, so write a sentence, not a code.

## Node types

`node_type` is one of:

- `article` — the default. Prose explaining something.
- `concept` — an idea or term ("backpressure", "eventual consistency").
- `entity` — a named thing in the world: a person, service, repo, product.
- `code-structure` — a specific structure in a codebase: a class, module, table, function.
- `architecture-item` — a component or boundary in a system's architecture.

Anything else is rejected with 400. The set is validated in code and stored as
text, so it can grow without a schema change.

Edge `kind` is either `follow` — someone asked something in the source article
and it took them to the target, with the question itself in the edge's `label` —
or `related`, an untyped association that carries no label.

An edge is a move through the map, not an assertion about it. The map is a trail
somebody walked, so a link is worth drawing when it records how a reader got
from one article to another.

## Maps

Maps are addressed by name. Creating a map that already exists returns the
existing one, so you can call `POST /maps` unconditionally at the start of a
write without checking first.

### List maps

```bash
curl http://127.0.0.1:3001/api/km/maps
```

Returns `{ "maps": [ { id, name, default_conv, created_at, article_count } ] }`.

### Create or fetch a map by name

```bash
curl -X POST http://127.0.0.1:3001/api/km/maps \
  -H 'Content-Type: application/json' \
  -d '{"name": "lattice-internals"}'
```

Returns `{ "map": { ... }, "created": true }` with 201 for a new map, or
`created: false` with 200 if the name already existed.

### Get a map with its graph

```bash
curl http://127.0.0.1:3001/api/km/maps/km-map-1788200782922-exh7hv
```

Returns `{ map, articles, edges }`. The articles here carry title, node_type,
pins and provenance but **not** `content_md` — this is the map view payload, and
bodies would make it large for no reason. They do carry `has_content`, so the
canvas can tell an article that has been written from a node that exists but is
still being written. Fetch a single article to get the body. 404 if the map id
is unknown.

Edges carry `label`: the question that made the move, for `follow` edges.

### The default responder conversation

`default_conv` on a map is the conversation that answers inline highlight→ask
questions raised on articles that have no `created_by_conv` of their own. The
article surface resolves a responder in this order: the article's
`created_by_conv`, then the map's `default_conv`, then a freshly created
conversation — which it writes back here, so the next ask on a provenance-less
article lands in the same session rather than starting another one.

It is null until something sets it. You rarely need to set it by hand; do so
when you want a specific session to field the questions on a map.

```bash
curl -X PATCH http://127.0.0.1:3001/api/km/maps/km-map-1788200782922-exh7hv \
  -H 'Content-Type: application/json' \
  -d '{"default_conv": "conv-abc123"}'
```

Returns `{ "map": { ... } }`. `default_conv` is required in the body; send
`null` to clear it, which makes the next ask create a new conversation. 404 if
the map id is unknown.

## Articles

### Create an article

```bash
curl -X POST http://127.0.0.1:3001/api/km/maps/km-map-1788200782922-exh7hv/articles \
  -H 'Content-Type: application/json' \
  -d '{
        "title": "The harness event log",
        "content_md": "# The harness event log\n\nEvents flow through EventLog to per-session SSE and SqliteEventStorage.",
        "node_type": "architecture-item",
        "created_from": "drawn while answering a question about server restarts",
        "created_by_conv": "conv-abc123"
      }'
```

`title` and `content_md` are required; `content_md` is markdown and may be empty.
`node_type` defaults to `article`. Returns 201 with `{ "article": { ... } }`.
404 if the map does not exist.

### Get one article with its exchanges

```bash
curl http://127.0.0.1:3001/api/km/articles/km-art-1788200782928-1394pk
```

Returns `{ article, exchanges }` — the full body plus every question asked about
a span inside it, oldest first.

### Update an article

```bash
curl -X PATCH http://127.0.0.1:3001/api/km/articles/km-art-1788200782928-1394pk \
  -H 'Content-Type: application/json' \
  -d '{"content_md": "# The harness event log\n\nRevised.", "node_type": "concept"}'
```

Any of `title`, `content_md`, `summary`, `takeaways`, `tooltips`, `node_type`,
`pinned_x`, `pinned_y`. Omitted fields are left alone; `updated_at` moves
forward. At least one field is required.

`pinned_x` / `pinned_y` are the node's frozen position in the map layout. Send
`null` to unpin a node and let the layout place it again.

`tooltips` here replaces the whole object rather than merging into it, so this
is the path to take when you already know what the bold terms mean and want to
write the explanations yourself. Generating them is a separate endpoint.

### Link two articles

```bash
curl -X POST http://127.0.0.1:3001/api/km/maps/km-map-1788200782922-exh7hv/edges \
  -H 'Content-Type: application/json' \
  -d '{
        "from_article_id": "km-art-1788200782929-p06w09",
        "to_article_id": "km-art-1788200782928-1394pk",
        "kind": "follow",
        "label": "what buffers these across a server restart?"
      }'
```

Both endpoints must exist **and belong to the map in the URL** — a cross-map edge
comes back 404 naming which endpoint was wrong.

### Follow a question out of an article

One call for the common move: a new empty article on the parent's map, plus the
`follow` edge into it carrying the question. Both are written in a single
transaction, so a child node never exists without the question that produced it.

```bash
curl -X POST http://127.0.0.1:3001/api/km/articles/km-art-1788200782929-p06w09/follow \
  -H 'Content-Type: application/json' \
  -d '{
        "question": "Tell me more about backpressure",
        "concept": "backpressure"
      }'
```

Returns `{ article, edge }` with 201. The child is `node_type: "concept"`, its
`created_from` is the parent article id, and its `title` is `concept` when you
send one and the question text otherwise. Its `content_md` is empty: whoever is
answering writes the body afterwards with `PATCH /articles/:articleId`, which
also accepts `created_by_conv` so the article records the session that wrote it.
404 if the parent article id is unknown.

## Concept tooltips

Bold terms in an article get a hover explanation. The bold text is the index:
whatever `**you bold**` in `content_md` is a concept, and each concept gets one
short markdown explanation written in the context of that article.

They live on the article as `tooltips`, an object keyed by the bold text
**exactly as it appears**, including case — `**Event Log**` and `**event log**`
are two different keys. It is `{}` on an article nothing has explained yet, and
it comes back on `GET /articles/:articleId` but deliberately **not** in the map
payload, which would otherwise carry every article's explanations to draw nodes.

### Generate the missing ones

```bash
curl -X POST http://127.0.0.1:3001/api/km/articles/km-art-1788200782928-1394pk/tooltips \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Returns `{ "tooltips": { ... }, "generated": 2, "failed": 0 }` — the full stored
object, plus how many concepts were newly explained and how many the model
failed on. `generated` is the number of calls that produced something, not the
number of tooltips you now have.

Only concepts with no tooltip yet are sent to the model. That makes this safe to
call unconditionally after editing an article: the terms you left alone cost
nothing, and only the new ones are generated. An article with no bold text at all
never reaches a model — it comes straight back as `{ "tooltips": {}, "generated": 0, "failed": 0 }`.

Explanations for terms you have since un-bolded are kept rather than pruned, so
a term that comes back after an edit does not have to be paid for twice.

Send `{"force": true}` to re-explain every bold term, including the ones that
already have a tooltip.

A concept the model fails on is counted in `failed` and simply left out — the
rest of the article still gets its tooltips, and the next call retries the gap.
A missing Anthropic key is different: that fails the whole request with 400 and
`code: "ANTHROPIC_API_KEY_MISSING"`, rather than quietly returning nothing.

## Exchanges (marginalia)

An exchange is a question about a highlighted span inside an article, and the
answer to it. It is created unanswered and filled in later, which is what lets an
answer stream in while the row already exists.

`quote` is the highlighted text, never truncated. `quote_start` is the character
offset of the highlight within `content_md`; it disambiguates a quote that
appears more than once and can be omitted when the quote is unique.

### Ask about a span

```bash
curl -X POST http://127.0.0.1:3001/api/km/articles/km-art-1788200782928-1394pk/exchanges \
  -H 'Content-Type: application/json' \
  -d '{
        "quote": "Events flow through EventLog",
        "quote_start": 33,
        "question": "What buffers these across a server restart?"
      }'
```

Returns 201 with the exchange, `answer_md` null.

### Answer it

```bash
curl -X PATCH http://127.0.0.1:3001/api/km/exchanges/km-exch-1788200782931-omtfe7 \
  -H 'Content-Type: application/json' \
  -d '{"answer_md": "Nothing does — the in-flight turn is lost on restart."}'
```

## Errors

- **400** — bad input, with a message naming what was wrong. A rejected
  `node_type` or `kind` lists the allowed values back to you.
- **404** — an id in the path or body does not resolve. The message includes the
  id that failed, so on an edge you can tell which of the three was wrong.
- **400 with a `code`** — a model-backed endpoint could not run at all.
  `ANTHROPIC_API_KEY_MISSING` on tooltip generation means there is no configured
  key and no hosted proxy to fall back to.

## Where this lives

Routes: `src/routes/km.routes.ts`. Storage: `src/services/km/knowledge-map-service.ts`.
Tooltips: `src/services/km/extract-bold-concepts.ts` finds the concepts,
`src/services/km/tooltip-generator.ts` explains them (Haiku-tier, one call per
concept, following the `anthropic.models.quickCheck` config override).
Tables `km_maps` / `km_articles` / `km_edges` / `km_exchanges` are created by
`src/services/sessions/session-info-migrations.ts` in `~/.lattice/session-info.db`.
