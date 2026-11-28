/**
 * Layer 2 of the Inbox ask eval: an LLM judge that reads a `lattice ask` card as
 * the Inbox shows it and answers atomic yes/no items before an overall verdict.
 * Explore-mode tooling: it writes raw judgments, `--analyse` describes them.
 *
 *   LATTICE_CONFIG_DIR=<dir> npx tsx scripts/judge-inbox-cold-read.ts --run <out.jsonl> [fixture.json]
 *   npx tsx scripts/judge-inbox-cold-read.ts --analyse <run1.jsonl> <run2.jsonl> [fixture.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import { ConfigService } from '../src/services/infrastructure/config-service.js';
import { anthropicClientFactory } from '../src/services/infrastructure/anthropic-client-factory.js';
import type { GoldenCard } from './eval-inbox-gate.js';
import { JUDGE_ITEMS, JUDGE_MODEL, judgeCard, renderJudgeCard, type JudgeItemId } from '../src/services/sessions/ask-judge.js';

const MODEL = JUDGE_MODEL;
const ITEMS = JUDGE_ITEMS;
const PRICE_PER_MTOK = { input: 4, output: 20 };
type ItemId = JudgeItemId;
export interface Judgment { id: string; items: Record<ItemId, string>; evidence: Record<ItemId, string>; coldReadable: 'yes' | 'no'; knowledgeNeeded?: { what: string; level: string }; usage: { input: number; output: number } }
const renderCard = (card: GoldenCard) => renderJudgeCard(card);

async function judge(client: Anthropic, card: GoldenCard): Promise<Judgment> {
  const v = await judgeCard(client, card);
  return { id: card.id, items: v.items, evidence: v.evidence, coldReadable: v.pass ? 'yes' : 'no', knowledgeNeeded: v.knowledgeNeeded, usage: v.usage };
}

async function run(out: string, cards: GoldenCard[]) {
  await ConfigService.getInstance().initialize();
  const client = anthropicClientFactory.getClient();
  if (!client) throw new Error('No Anthropic API key configured (config anthropic.apiKey or ANTHROPIC_API_KEY).');
  const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as Judgment).id) : []);
  const queue = cards.filter((c) => !done.has(c.id));
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let card = queue.shift(); card; card = queue.shift()) {
      const result = await judge(client, card);
      fs.appendFileSync(out, `${JSON.stringify(result)}\n`);
      console.log(`${card.id} cold_readable=${result.coldReadable}`);
    }
  }));
}

const readRun = (file: string) => new Map(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l) as Judgment; return [j.id, j]; }));
const failed = (j: Judgment) => ITEMS.filter((item) => item.id !== 'A1' && j.items[item.id] === 'no').length;

/** Spearman rank correlation. */
function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]) => { const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); for (let i = 0; i < order.length;) { let j = i; while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++; for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2; i = j + 1; } return r as number[]; };
  const [rx, ry] = [rank(xs), rank(ys)];
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const [mx, my] = [mean(rx), mean(ry)];
  const cov = rx.reduce((s, x, i) => s + (x - mx) * (ry[i] - my), 0);
  return cov / Math.sqrt(rx.reduce((s, x) => s + (x - mx) ** 2, 0) * ry.reduce((s, y) => s + (y - my) ** 2, 0));
}

function analyse(files: string[], cards: GoldenCard[]) {
  const runs = files.map(readRun);
  const [a, b] = runs;
  const ids = cards.map((c) => c.id).filter((id) => runs.every((r) => r.has(id)));
  const cost = runs.flatMap((r) => [...r.values()]).reduce((s, j) => s + j.usage.input * PRICE_PER_MTOK.input / 1e6 + j.usage.output * PRICE_PER_MTOK.output / 1e6, 0);
  console.log(`${ids.length} cards judged in ${runs.length} runs by ${MODEL}; total cost $${cost.toFixed(2)}\n`);
  console.log('Self-consistency (same answer in both runs), and how often run 1 answered "no":');
  for (const item of ITEMS) {
    const same = ids.filter((id) => a.get(id)!.items[item.id] === b.get(id)!.items[item.id]).length;
    const no = ids.filter((id) => a.get(id)!.items[item.id] === 'no').length;
    console.log(`  ${item.id} ${item.area.padEnd(18)} agree ${same}/${ids.length}   "no" ${no}/${ids.length}`);
  }
  const vSame = ids.filter((id) => a.get(id)!.coldReadable === b.get(id)!.coldReadable).length;
  console.log(`  verdict              agree ${vSame}/${ids.length}   "not cold-readable" ${ids.filter((id) => a.get(id)!.coldReadable === 'no').length}/${ids.length}`);

  const byId = new Map(cards.map((c) => [c.id, c]));
  const length = ids.map((id) => renderCard(byId.get(id)!).length);
  console.log(`\nLength confound (Spearman, card characters vs score, run 1, n=${ids.length}):`);
  console.log(`  items answered "no": ${spearman(length, ids.map((id) => failed(a.get(id)!))).toFixed(2)}`);
  console.log(`  verdict not cold-readable (1/0): ${spearman(length, ids.map((id) => (a.get(id)!.coldReadable === 'no' ? 1 : 0))).toFixed(2)}`);

  // Known groups from the Layer 1 labels: a confident should-refuse label, against no should-refuse label and nothing unsure.
  const bad = ids.filter((id) => { const c = byId.get(id)!; return Object.entries(c.labels).some(([rule, v]) => v && !c.unsure?.[rule as keyof typeof c.unsure]); });
  const good = ids.filter((id) => { const c = byId.get(id)!; return !Object.values(c.labels).some(Boolean) && !c.unsure; });
  const share = (group: string[]) => `${group.filter((id) => a.get(id)!.coldReadable === 'no').length}/${group.length} judged not cold-readable, mean items "no" ${(group.reduce((s, id) => s + failed(a.get(id)!), 0) / group.length).toFixed(1)}`;
  console.log(`\nKnown groups (Layer 1 agent labels, run 1):\n  clearly bad: ${share(bad)}\n  clearly good: ${share(good)}`);
}

function main(argv: string[]) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixtureArg = argv.find((x) => x.endsWith('.json') && !x.endsWith('.jsonl'));
  const cards = JSON.parse(fs.readFileSync(fixtureArg ?? path.join(here, '../test/fixtures/inbox-gate-golden.json'), 'utf8')) as GoldenCard[];
  if (argv[0] === '--run') return run(argv[1], cards).then(() => process.exit(0));
  if (argv[0] === '--analyse') return analyse(argv.filter((x) => x.endsWith('.jsonl')), cards);
  console.error('Usage: --run <out.jsonl> | --analyse <run1.jsonl> <run2.jsonl>');
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void main(process.argv.slice(2));
