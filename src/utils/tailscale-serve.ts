import { execFile } from 'child_process';
import { parseJson } from './json.js';

/** The parts of `tailscale serve status --json` read here. */
export interface TailscaleServeStatus {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

export interface TailscaleServeAdvice {
  /** The command that serves this port, or null when it is already served. */
  command: string | null;
  /** The https address it is (or will be) at, when the tailnet name is known. */
  url: string | null;
}

/** Reads what Tailscale already serves; null when the CLI can't say. */
export function readTailscaleServeStatus(cli: string): Promise<TailscaleServeStatus | null> {
  return new Promise((resolve) => {
    execFile(cli, ['serve', 'status', '--json'], { timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const parsed = parseJson(stdout.trim() || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed as TailscaleServeStatus : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * How to serve `port` on the tailnet without replacing anything already
 * served there. A plain `tailscale serve --bg <port>` takes over HTTPS 443,
 * which on a machine with the npm Lattice is usually that install's phone
 * address, so once 443 is taken this picks the next free port from 8443.
 * When the status is unknown it assumes 443 is taken.
 */
export function tailscaleServeAdvice(
  status: TailscaleServeStatus | null,
  cli: string,
  port: number,
): TailscaleServeAdvice {
  const web = Object.entries(status?.Web ?? {}).map(([hostPort, entry]) => {
    const colon = hostPort.lastIndexOf(':');
    return { host: hostPort.slice(0, colon), httpsPort: Number(hostPort.slice(colon + 1)), proxy: entry.Handlers?.['/']?.Proxy };
  });
  const host = web[0]?.host ?? null;
  const urlFor = (httpsPort: number) =>
    host ? `https://${host}${httpsPort === 443 ? '' : `:${httpsPort}`}` : null;

  const ours = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}/?$`);
  const served = web.find((entry) => entry.proxy && ours.test(entry.proxy));
  if (served) return { command: null, url: urlFor(served.httpsPort) };

  const taken = new Set(Object.keys(status?.TCP ?? {}).map(Number));
  let httpsPort = 443;
  if (!status || taken.has(443)) {
    httpsPort = 8443;
    while (taken.has(httpsPort)) httpsPort++;
  }
  const flag = httpsPort === 443 ? '' : `--https=${httpsPort} `;
  return { command: `${cli} serve --bg ${flag}${port}`, url: urlFor(httpsPort) };
}
