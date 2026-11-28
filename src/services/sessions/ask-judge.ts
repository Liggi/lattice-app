/**
 * The cold-read judge for agent asks: a model reads the card as the Inbox
 * shows it and says whether the user could decide from it alone. How much
 * context a card needs scales with the decision. Calibrated against the
 * user's ratings with `scripts/judge-inbox-cold-read.ts`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { parseJson } from '../../utils/json.js';
import type { DecisionOptionData } from '../../types/decisions.js';
import type { InboxArtifact } from '../../types/inbox-feed.js';

export const JUDGE_MODEL = 'claude-opus-5-5';
export const JUDGE_EFFORT = 'high' as const;
const PRICE_PER_MTOK = { input: 4, output: 20 };

/** Each item is phrased so "yes" is the good answer; "n/a" only where the precondition says so. */
export const JUDGE_ITEMS = [
  { id: 'O1', area: 'orientation', q: 'Given the knowledge level you estimated, does the card (question, context, options, and any attached screenshot or diagram) tell a reader who does not remember the project as much about what the work is as this decision needs? A low-need decision passes on a few words.' },
  { id: 'O2', area: 'orientation', q: 'Given that level, does the card say why the call is needed now (what waits on it or what changes) to the extent this decision needs?' },
  { id: 'O3', area: 'orientation', q: 'Is every name, ID, codename, earlier choice or term that the decision turns on either one this reader would know cold, or explained on the card in words or by an attached image? Terms that do not affect the choice do not count against it.' },
  { id: 'A1', area: 'artifacts', q: 'Does the card ask the reader to judge something they must see or read to decide (a message, wording, a result, or anything about how something looks or is laid out, whatever words the card uses)? Answer yes or no; this item is not good or bad.' },
  { id: 'A2', area: 'artifacts', q: 'If A1 is yes: is that thing on the card itself? Wording or a result must be quoted or attached in full; a choice about how something looks or is laid out needs an attached image of each option, and a description in words does not count. If A1 is no, answer n/a.' },
  { id: 'A3', area: 'artifacts', q: 'Does the card avoid sending the reader somewhere else (the chat, a report, an earlier message, a link) for information they need to decide?' },
  { id: 'S1', area: 'single-call', q: 'Does the card ask for exactly one decision?' },
  { id: 'S2', area: 'single-call', q: 'Does every option say what will happen if it is chosen?' },
  { id: 'S3', area: 'single-call', q: 'Are the options different enough that the reader can pick one without asking a follow-up question?' },
] as const;
export type JudgeItemId = typeof JUDGE_ITEMS[number]['id'];
type Answer = 'yes' | 'no' | 'n/a';

export interface JudgeCard {
  question: string;
  options: DecisionOptionData[];
  meta?: { requestKind?: string; context?: string[]; artifact?: InboxArtifact };
}

export interface JudgeVerdict {
  pass: boolean;
  knowledgeNeeded: { what: string; level: string };
  items: Record<JudgeItemId, Answer>;
  evidence: Record<JudgeItemId, string>;
  /** Images sent to the model as pictures, out of those on the card. */
  imagesSent: number;
  model: string;
  effort: string;
  usage: { input: number; output: number };
  costUsd: number;
  ms: number;
}

const SYSTEM = `You review cards that an AI agent puts in a person's Inbox to ask them for a decision.
The reader is the person the agent works for. They are busy, switching in from other work, and have NOT read the agent's chat.
They run many projects at once and may not remember this one at all.
How much context a card needs scales with the decision: first estimate how much hidden knowledge deciding it depends on (project history, earlier choices, what something looks like, jargon). "Delete the unused staging database? It costs about $40 a month" needs almost nothing; a choice between three layouts for a screen the reader has never seen needs what the project is, what each option looks like, and why it matters now. Then judge whether the card supplies that much. Attached screenshots and diagrams count as context, not only the written lines: a complex card can be enough with a good diagram and a short line.
They do not know what the agent did in this session, nor the IDs, hashes, ticket numbers, PR numbers, codenames or file paths it used unless the card explains them.
Any choice about how something looks or is laid out (a screen, a layout, a style, an icon, a chart) needs a picture of each option attached, even when the question names nothing visual.
You see the card as the Inbox shows it. Attached images follow the card when they could be loaded; an image described only by its caption could not be, so judge it from the caption.
Answer each item about this card only. Give one short line of evidence quoted or paraphrased from the card, then the answer. Answer every item before the overall verdict.`;

export function renderJudgeCard(card: JudgeCard): string {
  const m = card.meta ?? {};
  const lines = [`Question: ${card.question}`];
  if (m.requestKind) lines.push(`Kind of request: ${m.requestKind}`);
  if (m.context?.length) lines.push('Context:', ...m.context.map((c) => `  - ${c}`));
  lines.push('Options:', ...card.options.map((o) => `  - ${o.label}${o.recommended ? ' (recommended)' : ''}: ${o.consequence}`));
  const a = m.artifact;
  if (!a) lines.push('Attachment: none');
  else if (a.kind === 'image') lines.push(`Attachment: ${a.images?.length ?? 0} image(s) "${a.label}"`, ...(a.images ?? []).map((img, i) => `  - image ${i + 1}: ${img.caption ? `captioned "${img.caption}"` : 'no caption'}`));
  else if (a.kind === 'table') lines.push(`Attachment: table "${a.label}" with ${a.table?.rows.length ?? 0} rows`);
  else lines.push(`Attachment: ${a.kind} "${a.label}"${a.meta ? ` (${a.meta})` : ''}`, `  ${a.body?.trim() ? a.body : '(empty)'}`);
  return lines.join('\n');
}

const itemSchema = (id: string) => ({
  type: 'object',
  properties: { evidence: { type: 'string' }, answer: { type: 'string', enum: id === 'A2' ? ['yes', 'no', 'n/a'] : ['yes', 'no'] } },
  required: ['evidence', 'answer'],
  additionalProperties: false,
});
const SCHEMA = {
  type: 'object',
  properties: {
    knowledge_needed: {
      type: 'object',
      description: 'Before the items: what hidden knowledge deciding this depends on, and how much.',
      properties: { what: { type: 'string' }, level: { type: 'string', enum: ['low', 'medium', 'high'] } },
      required: ['what', 'level'],
      additionalProperties: false,
    },
    ...Object.fromEntries(JUDGE_ITEMS.map((item) => [item.id, itemSchema(item.id)])),
    cold_readable: { type: 'string', enum: ['yes', 'no'], description: 'Could this reader make the call from the Inbox alone, without opening the chat?' },
  },
  required: ['knowledge_needed', ...JUDGE_ITEMS.map((item) => item.id), 'cold_readable'],
  additionalProperties: false,
};

const IMAGE_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** A card image as the model takes it: a local file `lattice ask --image` named, or a public URL. */
async function imageBlock(src: string): Promise<Anthropic.ImageBlockParam | null> {
  if (/^https?:\/\//i.test(src)) return { type: 'image', source: { type: 'url', url: src } };
  const file = src.startsWith('/api/images?') ? new URLSearchParams(src.slice(src.indexOf('?') + 1)).get('path') : null;
  const mediaType = file ? IMAGE_TYPES[path.extname(file).toLowerCase()] : undefined;
  if (!file || !mediaType) return null;
  try {
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_IMAGE_BYTES) return null;
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } };
  } catch {
    return null;
  }
}

export async function judgeCard(
  client: Anthropic,
  card: JudgeCard,
  opts: { model?: string; effort?: 'low' | 'medium' | 'high'; images?: boolean; signal?: AbortSignal } = {},
): Promise<JudgeVerdict> {
  const model = opts.model ?? JUDGE_MODEL;
  const effort = opts.effort ?? JUDGE_EFFORT;
  const started = Date.now();
  const images = opts.images === false ? [] : card.meta?.artifact?.kind === 'image' ? card.meta.artifact.images ?? [] : [];
  const content: Anthropic.ContentBlockParam[] = [{
    type: 'text',
    text: `First estimate the hidden knowledge this decision needs (knowledge_needed). Items:\n${JUDGE_ITEMS.map((item) => `${item.id}. ${item.q}`).join('\n')}\n\nThen: could this reader make the call from the Inbox alone, without opening the chat?\n\n<card>\n${renderJudgeCard(card)}\n</card>`,
  }];
  let imagesSent = 0;
  for (const [i, img] of images.entries()) {
    const block = await imageBlock(img.src);
    if (!block) continue;
    content.push({ type: 'text', text: `Attached image ${i + 1}${img.caption ? ` ("${img.caption}")` : ''}:` }, block);
    imagesSent++;
  }
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort, format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  }, { signal: opts.signal });
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  if (response.stop_reason !== 'end_turn' || !text) throw new Error(`The judge stopped with ${response.stop_reason}`);
  const parsed = parseJson(text) as Record<JudgeItemId, { evidence: string; answer: Answer }> & { cold_readable: 'yes' | 'no'; knowledge_needed: { what: string; level: string } };
  const usage = { input: response.usage.input_tokens, output: response.usage.output_tokens };
  return {
    pass: parsed.cold_readable === 'yes',
    knowledgeNeeded: parsed.knowledge_needed,
    items: Object.fromEntries(JUDGE_ITEMS.map((item) => [item.id, parsed[item.id].answer])) as Record<JudgeItemId, Answer>,
    evidence: Object.fromEntries(JUDGE_ITEMS.map((item) => [item.id, parsed[item.id].evidence])) as Record<JudgeItemId, string>,
    imagesSent,
    model,
    effort,
    usage,
    costUsd: (usage.input * PRICE_PER_MTOK.input + usage.output * PRICE_PER_MTOK.output) / 1e6,
    ms: Date.now() - started,
  };
}

const FIX_HINT: Record<JudgeItemId, string> = {
  O1: 'Say in plain words what the work is (a --context line, or a screenshot or diagram).',
  O2: 'Say why the call is needed now: what waits on it or what changes.',
  O3: 'Explain the names, IDs or earlier choices the decision turns on, or drop them.',
  A1: '',
  A2: 'Put what the user must see on the card: --draft for wording, one captioned --image per option for anything visual.',
  A3: 'Put the information on the card instead of pointing to the chat or a report.',
  S1: 'Ask one decision per card.',
  S2: 'Say in each option what will happen if it is chosen.',
  S3: 'Make the options distinct enough to pick without a follow-up question.',
};

/** The refusal the agent reads: what the decision needs, what the card lacks, and how to fix each gap. */
export function bounceMessage(verdict: JudgeVerdict): string {
  const gaps = JUDGE_ITEMS.filter((item) => item.id !== 'A1' && verdict.items[item.id] === 'no')
    .map((item) => `- ${verdict.evidence[item.id]} ${FIX_HINT[item.id]}`);
  return [
    'The cold-read judge thinks the user could not decide this from the Inbox alone, without your chat.',
    `What deciding it needs (${verdict.knowledgeNeeded.level}): ${verdict.knowledgeNeeded.what}`,
    ...(gaps.length ? ['What the card is missing:', ...gaps] : []),
    'Fix the card and ask again. Your next ask in this session is put up whatever the judge says.',
  ].join('\n');
}
