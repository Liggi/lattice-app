/** Safe JSON.parse wrapper that returns `unknown` instead of `any`. */
export function parseJson(text: string): unknown {
  return JSON.parse(text);
}
