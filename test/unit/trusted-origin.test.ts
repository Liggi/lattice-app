import { describe, expect, it } from 'vitest';
import { isTrustedOrigin } from '../../src/middleware/trusted-origin.js';

describe('isTrustedOrigin', () => {
  it('trusts the page itself, a typed address, and non-browser callers', () => {
    expect(isTrustedOrigin({ 'sec-fetch-site': 'same-origin' }).trusted).toBe(true);
    expect(isTrustedOrigin({ 'sec-fetch-site': 'none' }).trusted).toBe(true);
    expect(isTrustedOrigin({ host: '100.64.0.1:3045', origin: 'http://100.64.0.1:3045' }).trusted).toBe(true);
    expect(isTrustedOrigin({ host: 'mini.tailnet.ts.net' }).trusted).toBe(true);
  });

  it('refuses another site, whichever header the browser used to say so', () => {
    expect(isTrustedOrigin({ 'sec-fetch-site': 'cross-site' }).trusted).toBe(false);
    expect(isTrustedOrigin({ 'sec-fetch-site': 'same-site' }).trusted).toBe(false);
    expect(isTrustedOrigin({ host: '100.64.0.1:3045', origin: 'https://evil.example' }).trusted).toBe(false);
    expect(isTrustedOrigin({ host: '100.64.0.1:3045', origin: 'not a url' }).trusted).toBe(false);
  });
});
