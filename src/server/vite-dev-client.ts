/**
 * True when this server is a source checkout run as TypeScript. A built or
 * installed server is never local development, whatever NODE_ENV says.
 */
export const runsFromSource = import.meta.url.endsWith('.ts');

/**
 * True when the server should hand the frontend to Vite: only a source
 * checkout has Vite and the client source, so a built or installed server
 * serves dist/web.
 */
export const servesViteDevClient =
  process.env.NODE_ENV === 'development' && runsFromSource;
