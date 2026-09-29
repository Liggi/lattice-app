import path from 'path';
import { fileURLToPath } from 'url';

/**
 * True when this server is a source checkout run as TypeScript. A built or
 * installed server is never local development, whatever NODE_ENV says.
 */
export const runsFromSource = import.meta.url.endsWith('.ts');

/**
 * True when the server should hand the frontend to Vite: only a source
 * checkout has Vite and the client source, so a built or installed server
 * serves dist/web. `LATTICE_CLIENT=built` makes a source checkout serve its
 * built client too, as an everyday instance should: Vite's dev client sends
 * hundreds of unbundled modules per page load and reloads the page whenever
 * its socket to the server drops.
 */
export const servesViteDevClient =
  process.env.NODE_ENV === 'development' && runsFromSource && process.env.LATTICE_CLIENT !== 'built';

/**
 * Where the built client lives: next to the compiled server (dist/web), or in
 * the checkout's dist/web when the server runs from source. Read from disk on
 * every request, so a rebuilt client is served without restarting.
 */
export const builtClientDir = runsFromSource
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web')
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
