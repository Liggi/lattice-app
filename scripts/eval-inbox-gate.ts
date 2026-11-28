/**
 * Per-rule eval of the Inbox cold-read gate (`checkColdReadQuality`) against a
 * labelled golden set. The gate throws on the first rule a card breaks, so each
 * card is re-run with that rule's trigger neutralised until it passes; every rule
 * that fired along the way counts as flagged.
 *
 *   npx tsx scripts/eval-inbox-gate.ts [fixture.json] [--json]
 *   npx tsx scripts/eval-inbox-gate.ts --scan cards.jsonl   # rules fired per raw card, no labels
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkColdReadQuality, DecisionError } from '../src/services/sessions/decisions.js';
import type { DecisionAskedData, DecisionOptionData } from '../src/types/decisions.js';

export const RULES = [
  'kind', 'context', 'one-question', 'raw-id', 'chat-pointer', 'draft-permission',
  'send-without-draft', 'image-captions', 'visual-without-image', 'visual-image-count',
] as const;
type Rule = typeof RULES[number];

export interface GoldenCard {
  id: string;
  source: 'history' | 'hand-written';
  question: string;
  options: DecisionOptionData[];
  meta?: Partial<DecisionAskedData>;
  /** true = a cold reader needs this rule to refuse the card; false = it should pass; absent = not scored. */
  labels: Partial<Record<Rule, boolean>>;
  /** Rules whose label the labeller was unsure of, with why. */
  unsure?: Partial<Record<Rule, string>>;
  note?: string;
}

const RULE_BY_MESSAGE: [RegExp, Rule][] = [
  [/^Missing --kind/, 'kind'],
  [/^Missing orientation/, 'context'],
  [/^Ask one decision per card/, 'one-question'],
  [/^Remove raw IDs/, 'raw-id'],
  [/^Do not point the user back to chat/, 'chat-pointer'],
  [/^Do not ask permission to draft/, 'draft-permission'],
  [/no draft is attached/, 'send-without-draft'],
  [/give each one a caption/, 'image-captions'],
  [/no image is attached/, 'visual-without-image'],
  [/visual options, but only/, 'visual-image-count'],
];

const QUESTION_MARK = /\?(?![\w=&])/g;
const quoted = (message: string) => /\("([^"]+)"\)/.exec(message)?.[1] ?? '';

/** Returns the rules the gate refuses this card for, in the order it reaches them. */
export function rulesFired(question: string, options: DecisionOptionData[], meta: Partial<DecisionAskedData> = {}): Rule[] {
  const fired: Rule[] = [];
  let q = question;
  let opts = options.map((o) => ({ ...o }));
  let m: Partial<DecisionAskedData> = { ...meta };
  const scrub = (needle: string, replacement: string) => {
    if (!needle) return;
    const swap = (s: string) => s.split(needle).join(replacement);
    q = swap(q);
    opts = opts.map((o) => ({ ...o, label: swap(o.label), consequence: swap(o.consequence) }));
    m = { ...m, context: m.context?.map(swap), priorityReason: m.priorityReason && swap(m.priorityReason), ifUnanswered: m.ifUnanswered && swap(m.ifUnanswered) };
  };
  for (let guard = 0; guard < 40; guard++) {
    let error: unknown;
    try { checkColdReadQuality(q, opts, m); return fired; } catch (e) { error = e; }
    if (!(error instanceof DecisionError)) throw error;
    const rule = RULE_BY_MESSAGE.find(([re]) => re.test(error.message))?.[1];
    if (!rule) throw new Error(`Unmapped gate message: ${error.message}`);
    if (!fired.includes(rule)) fired.push(rule);
    switch (rule) {
      case 'kind': m = { ...m, requestKind: 'decision' }; break;
      case 'context': m = { ...m, context: [...(m.context ?? []), 'Neutral orientation line added by the eval runner.'] }; break;
      case 'one-question': {
        const marks = [...q.matchAll(QUESTION_MARK)];
        const last = marks[marks.length - 1]?.index ?? -1;
        q = q.replace(QUESTION_MARK, (mark, at: number) => (at === last ? mark : '.')).replace(/,\s+and\s+/g, ' plus ');
        break;
      }
      case 'raw-id': scrub(quoted(error.message), 'the record'); break;
      case 'chat-pointer': scrub(quoted(error.message), 'here'); break;
      case 'draft-permission': scrub(quoted(error.message), 'asks'); break;
      case 'send-without-draft': m = { ...m, artifact: { kind: 'text', label: 'eval', body: 'Draft added by the eval runner.' } }; break;
      case 'image-captions': m = { ...m, artifact: { ...m.artifact!, images: m.artifact!.images!.map((img, i) => ({ ...img, caption: img.caption || `image ${i + 1}` })) } }; break;
      case 'visual-without-image':
      case 'visual-image-count':
        return fired; // last rules the gate checks
    }
  }
  throw new Error(`Gate never passed after peeling: ${question}`);
}

interface RuleScore { rule: Rule; scored: number; labelledBad: number; flagged: number; agree: number; falsePositives: GoldenCard[]; falseNegatives: GoldenCard[] }

export function score(cards: GoldenCard[]): RuleScore[] {
  const fired = new Map(cards.map((c) => [c.id, rulesFired(c.question, c.options, c.meta)]));
  return RULES.map((rule) => {
    const scored = cards.filter((c) => c.labels[rule] !== undefined);
    const flaggedCards = scored.filter((c) => fired.get(c.id)!.includes(rule));
    return {
      rule,
      scored: scored.length,
      labelledBad: scored.filter((c) => c.labels[rule]).length,
      flagged: flaggedCards.length,
      agree: flaggedCards.filter((c) => c.labels[rule]).length,
      falsePositives: flaggedCards.filter((c) => !c.labels[rule]),
      falseNegatives: scored.filter((c) => c.labels[rule] && !fired.get(c.id)!.includes(rule)),
    };
  });
}

function main(argv: string[]) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (argv[0] === '--scan') {
    for (const line of fs.readFileSync(argv[1], 'utf8').split('\n').filter(Boolean)) {
      const card = JSON.parse(line) as { key: string; question: string; options: DecisionOptionData[]; meta?: Partial<DecisionAskedData> };
      console.log(JSON.stringify({ key: card.key, fired: rulesFired(card.question, card.options, card.meta) }));
    }
    return;
  }
  const file = argv.find((a) => !a.startsWith('--')) ?? path.join(here, '../test/fixtures/inbox-gate-golden.json');
  const cards = JSON.parse(fs.readFileSync(file, 'utf8')) as GoldenCard[];
  const scores = score(cards);
  if (argv.includes('--json')) { console.log(JSON.stringify(scores, null, 2)); return; }
  const show = (c: GoldenCard) => `      [${c.id}] ${c.question}${c.unsure ? '  (labeller unsure)' : ''}`;
  console.log(`${cards.length} cards (${cards.filter((c) => c.source === 'history').length} history, ${cards.filter((c) => c.source === 'hand-written').length} hand-written). Labels are agent-written.\n`);
  for (const s of scores) {
    console.log(`${s.rule}: ${s.scored} cards scored, ${s.labelledBad} labelled should-refuse; gate flagged ${s.flagged}, labels agree on ${s.agree}, labels say it missed ${s.falseNegatives.length}`);
    if (s.falsePositives.length) console.log(`    flagged, label says pass:\n${s.falsePositives.map(show).join('\n')}`);
    if (s.falseNegatives.length) console.log(`    missed, label says refuse:\n${s.falseNegatives.map(show).join('\n')}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
