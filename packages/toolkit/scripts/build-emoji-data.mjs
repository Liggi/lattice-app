#!/usr/bin/env node
/**
 * Writes src/components/Reactions/emoji-data.json from an unpacked
 * emojibase-data package (MIT), so the toolkit ships a small table rather than a
 * dependency:
 *
 *   npm pack emojibase-data && tar xzf emojibase-data-*.tgz
 *   node packages/toolkit/scripts/build-emoji-data.mjs ./package
 *
 * Each row is [emoji, shortcodes, group, keywords]. Shortcodes are Slack's
 * (iamcal) first, then emojibase's, space-separated; skin-tone variants and
 * the component group are left out.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = process.argv[2];
if (!pkg) {
  console.error('usage: build-emoji-data.mjs <path to unpacked emojibase-data>');
  process.exit(1);
}
const read = (file) => JSON.parse(readFileSync(join(pkg, file), 'utf8'));
const compact = read('en/compact.json');
const slack = read('en/shortcodes/iamcal.json');
const emojibase = read('en/shortcodes/emojibase.json');
// Emojibase writes a presentation selector after characters that are already
// emoji by default (👍 + U+FE0F); dropping it keeps copied and compared text plain.
const plain = (emoji) => (/^\p{Emoji_Presentation}\uFE0F$/u.test(emoji) ? emoji.slice(0, -1) : emoji);
const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

const rows = [];
for (const entry of [...compact].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))) {
  if (entry.group == null || entry.group === 2) continue;
  const codes = [...new Set([...list(slack[entry.hexcode]), ...list(emojibase[entry.hexcode])])];
  if (codes.length === 0) continue;
  rows.push([plain(entry.unicode), codes.join(' '), entry.group, (entry.tags ?? []).join(' ')]);
}

const out = join(dirname(fileURLToPath(import.meta.url)), '../src/components/Reactions/emoji-data.json');
writeFileSync(out, JSON.stringify(rows));
console.log(`${rows.length} emoji → ${out}`);
