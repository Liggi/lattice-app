/**
 * Refuses a client build when a server running from this checkout started
 * before server-side source changed: the new client may read API fields that
 * server does not send. Run by build-web.sh and safe-build.sh.
 * LATTICE_ALLOW_STALE_SERVER=1 builds anyway.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findStaleServers } from '../src/server/running-server-code.js';

const checkoutDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stale = findStaleServers(checkoutDir);

if (stale.length === 0) process.exit(0);

const allowed = process.env.LATTICE_ALLOW_STALE_SERVER === '1';
const lines: string[] = [];
for (const server of stale) {
  const shown = server.changed.slice(0, 12).map((file) => `    src/${file}`);
  if (server.changed.length > shown.length) shown.push(`    and ${server.changed.length - shown.length} more`);
  lines.push(
    `The server on port ${server.port ?? '?'} (pid ${server.pid}, started ${server.startedAt}) is running older server code than this checkout.`,
    `Server-side files changed since it started:`,
    ...shown,
  );
}
lines.push(
  '',
  'A client built now is served to that server at once, and may read API fields it does not send yet',
  '(22 Nov 2026: a header widget read a new field and took the whole UI down).',
  'Either restart that server with the new code first (it runs from source, so pnpm deploy does not restart it),',
  'or, if this client works against the running server, build anyway with LATTICE_ALLOW_STALE_SERVER=1.',
);

if (allowed) {
  console.warn(['LATTICE_ALLOW_STALE_SERVER=1: building anyway.', ...lines].join('\n'));
  process.exit(0);
}
console.error(['Refusing the client build.', ...lines].join('\n'));
process.exit(1);
