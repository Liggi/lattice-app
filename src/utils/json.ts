/**
 * Safe JSON.parse wrapper that returns `unknown` instead of `any`.
 * Forces callers to narrow the type before use.
 */
export function parseJson(text: string): unknown {
  // eslint-disable-next-line no-restricted-syntax -- this IS the safe wrapper
  return JSON.parse(text);
}
