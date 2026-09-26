import { Logger } from '../services/infrastructure/logger.js';
import type { TailscaleServeAdvice } from './tailscale-serve.js';

export interface ServerStartupOptions {
  host: string;
  port: number;
  tailscaleIp?: string | null;
  tailscaleServe?: TailscaleServeAdvice | null;
  logger: Logger;
}

/** True for a bind address only this machine can reach. */
export function isLoopbackHost(host: string | undefined): boolean {
  return !host || host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/**
 * Display server startup information
 */
export function displayServerStartup(options: ServerStartupOptions): void {
  const { host, port, tailscaleIp, tailscaleServe, logger } = options;
  const serverUrl = `http://${host}:${port}`;
  logger.info(`🚀 Server listening on ${serverUrl}`);
  if (!tailscaleIp) return;
  if (isLoopbackHost(host) && tailscaleServe) {
    const then = tailscaleServe.url ? `, then open ${tailscaleServe.url}` : '';
    logger.info(tailscaleServe.command
      ? `📱 Phone access over Tailscale: run \`${tailscaleServe.command}\`${then} (this server only listens on this machine)`
      : `📱 Phone access over Tailscale: ${tailscaleServe.url ?? 'already served by tailscale serve'}`);
  } else if (!isLoopbackHost(host)) {
    logger.info(`📱 Remote access: http://${tailscaleIp}:${port}`);
  }
}
