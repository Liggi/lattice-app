import { describe, expect, it } from 'vitest';
import { tailscaleServeAdvice } from '../../src/utils/tailscale-serve.js';

const host = 'box.tail1.ts.net';

describe('tailscaleServeAdvice', () => {
  it('uses 443 when nothing is served', () => {
    expect(tailscaleServeAdvice({}, 'tailscale', 3101)).toEqual({ command: 'tailscale serve --bg 3101', url: null });
  });

  // The npm Lattice's phone address is usually a plain `serve --bg 3001` on 443.
  it('leaves an existing 443 alone and takes the next free port from 8443', () => {
    const status = {
      TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
      Web: {
        [`${host}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3001' } } },
        [`${host}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4000' } } },
      },
    };
    expect(tailscaleServeAdvice(status, 'tailscale', 3101)).toEqual({
      command: 'tailscale serve --bg --https=8444 3101',
      url: `https://${host}:8444`,
    });
  });

  it('gives the address when this port is already served', () => {
    const status = {
      TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
      Web: {
        [`${host}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3001' } } },
        [`${host}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3101' } } },
      },
    };
    expect(tailscaleServeAdvice(status, 'tailscale', 3101)).toEqual({ command: null, url: `https://${host}:8443` });
  });

  it('assumes 443 is taken when the status is unknown', () => {
    expect(tailscaleServeAdvice(null, 'tailscale', 3101).command).toBe('tailscale serve --bg --https=8443 3101');
  });
});
