import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { CONFIG_DIR } from '../../utils/constants.js';
import type { JsonWebKey } from 'node:crypto';
import { parseJson } from '../../utils/json.js';
import { LatticeError } from '../../types/index.js';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';
export const CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const TERMINAL_REFRESH_ERRORS = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

export class PlanError extends LatticeError {
  constructor(public readonly code: string, public readonly status = 400, public readonly requestId?: string, public readonly bodyShape?: string) {
    super(code, `ChatGPT plan: ${code}${requestId ? ` (request ${requestId})` : ''}`, status);
    this.name = 'PlanError';
  }
}

export interface PlanRegistration {
  client_id: string;
  subject: string;
  email?: string;
  issuer: string;
  ext_agent_host_id: string;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scopes: string[];
  expires_at: number;
  earliest_refresh_at?: number;
  paused?: string;
  verified_model?: string;
  welcomed?: boolean;
}

export function parsePlanJson(text: string): unknown {
  try { return parseJson(text); } catch { throw new PlanError('invalid_json_payload'); }
}

export interface PlanAuthStatus {
  active: string | null;
  accounts: Array<{ id: string; label: string; connected: boolean; planEnabled: boolean; paused: string | null; verifiedModel: string | null; welcomed: boolean }>;
  usageUrl: string;
}

interface SavedState { hostId: string; active?: string; accounts: PlanRegistration[] }
interface TokenSet { access_token: string; refresh_token: string; id_token?: string; token_type: string; expires_in: number; scope?: string; earliest_refresh_at?: number }
interface Identity { iss: string; sub: string; aud: string | string[]; azp?: string; exp: number; iat: number; nbf?: number; nonce?: string; email?: string; client_id?: string; scope?: string }
interface PendingLogin { id: string; state: string; nonce: string; verifier: string; redirectUri: string; account?: PlanRegistration; expiresAt: number; server: Server; timer: NodeJS.Timeout; phase: 'pending' | 'exchanging' | 'complete' | 'failed'; error?: string; url: string }

export async function planHttpJson(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown;
  try { body = parseJson(text); } catch { throw new PlanError('invalid_server_response', response.status); }
  if (!response.ok) {
    const record = body as { error?: { code?: string } | string; detail?: unknown };
    const code = typeof record?.error === 'string' ? record.error : record?.error?.code;
    throw new PlanError(typeof code === 'string' && /^[a-z0-9_]+$/.test(code) ? code : `http_${response.status}`, response.status,
      response.headers.get('x-request-id') ?? response.headers.get('openai-request-id') ?? undefined,
      record?.detail !== undefined ? 'detail' : record?.error !== undefined ? 'error' : 'other');
  }
  return body;
}

export class ChatGPTPlanAuth {
  readonly directory: string;
  private pending = new Map<string, PendingLogin>();
  private jwks?: { keys: Array<JsonWebKey & { kid?: string; alg?: string }>; savedAt: number };

  constructor(directory = path.join(CONFIG_DIR, 'chatgpt-plan'), private readonly http: typeof fetch = fetch, private readonly now = Date.now) {
    this.directory = directory;
  }

  private async protectDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) {
      throw new PlanError('credential_directory_not_owner_only');
    }
  }

  private async readProtected(file: string): Promise<string> {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new PlanError('credential_file_not_owner_only');
      return await handle.readFile('utf8');
    } finally { await handle.close(); }
  }

  private async writeState(state: SavedState): Promise<void> {
    const temporary = path.join(this.directory, `accounts-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, path.join(this.directory, 'accounts.json'));
    const directory = await fs.open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async readState(): Promise<SavedState> {
    try {
      const state = parsePlanJson(await this.readProtected(path.join(this.directory, 'accounts.json'))) as SavedState;
      if (!state || typeof state.hostId !== 'string' || !state.hostId.startsWith('urn:uuid:') || !Array.isArray(state.accounts) || state.accounts.some((account) => !account || typeof account.client_id !== 'string' || typeof account.subject !== 'string' || !Array.isArray(account.scopes) || account.scopes.some((scope) => typeof scope !== 'string'))) throw new PlanError('invalid_credential_record');
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
    }
  }

  private async locked<T>(action: (state: SavedState) => Promise<T>): Promise<T> {
    await this.protectDirectory();
    const lock = path.join(this.directory, 'accounts.lock');
    const deadline = Date.now() + 15000;
    for (;;) {
      try { await fs.mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() > deadline) throw new PlanError('credential_lock_busy', 409);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      const state = await this.readState();
      await this.writeState(state);
      return await action(state);
    } finally { await fs.rmdir(lock); }
  }

  async status(): Promise<PlanAuthStatus> {
    return this.locked(async (state) => ({
      active: state.active ?? null,
      accounts: state.accounts.map((account) => ({
        id: account.client_id, label: `${account.email ?? 'ChatGPT account'} · ${account.client_id}`,
        connected: Boolean(account.access_token && account.refresh_token), planEnabled: account.scopes.includes(DIRECT_SCOPE) && account.scopes.includes('resource.invoke'),
        paused: account.paused ?? null, verifiedModel: account.verified_model ?? null, welcomed: account.welcomed === true,
      })),
      usageUrl: CHATGPT_USAGE_URL,
    }));
  }

  private async keys(force = false) {
    if (force || !this.jwks || this.now() - this.jwks.savedAt > 3600000) {
      const body = await planHttpJson(await this.http(`${CHATGPT_ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(15000) })) as { keys?: Array<JsonWebKey & { kid?: string; alg?: string }> };
      if (!body || !Array.isArray(body.keys)) throw new PlanError('invalid_signing_keys');
      this.jwks = { keys: body.keys, savedAt: this.now() };
    }
    return this.jwks!.keys;
  }

  async validateToken(token: string, audience: string, nonce?: string, allowExpired = false): Promise<Identity> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new PlanError('invalid_signed_token');
    const header = parsePlanJson(Buffer.from(parts[0], 'base64url').toString()) as { alg?: string; kid?: string };
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) throw new PlanError('unsupported_signing_algorithm');
    let key = (await this.keys()).find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA');
    if (!key) key = (await this.keys(true)).find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA');
    if (!key || (key.alg && key.alg !== 'RS256') || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) {
      throw new PlanError('invalid_token_signature');
    }
    const identity = parsePlanJson(Buffer.from(parts[1], 'base64url').toString()) as Identity;
    if (!identity) throw new PlanError('invalid_token_identity');
    const time = this.now() / 1000;
    const audiences = Array.isArray(identity.aud) ? identity.aud : [identity.aud];
    if (identity.iss !== CHATGPT_ISSUER || !audiences.includes(audience) || typeof identity.sub !== 'string' || !identity.sub ||
      !Number.isFinite(identity.exp) || !Number.isFinite(identity.iat) || identity.iat > time + 5 || (!allowExpired && identity.exp < time - 5) ||
      (identity.nbf !== undefined && (!Number.isFinite(identity.nbf) || identity.nbf > time + 5)) || (nonce !== undefined && identity.nonce !== nonce) ||
      (audiences.length > 1 && !identity.azp) || (identity.azp !== undefined && identity.azp !== audience)) throw new PlanError('invalid_token_identity');
    return identity;
  }

  private async tokenRequest(fields: Record<string, string>): Promise<TokenSet> {
    const tokens = await planHttpJson(await this.http(`${CHATGPT_ISSUER}/api/accounts/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), signal: AbortSignal.timeout(15000),
    })) as TokenSet;
    if (typeof tokens?.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || (tokens.scope !== undefined && typeof tokens.scope !== 'string')) throw new PlanError('incomplete_token_response');
    return tokens;
  }

  private async validateAccess(tokens: TokenSet, clientId: string, subject: string, oldScopes?: string[]) {
    const identity = await this.validateToken(tokens.access_token, CHATGPT_RESOURCE);
    const scopes = tokens.scope === undefined ? oldScopes : tokens.scope.split(/\s+/).filter(Boolean);
    if (identity.sub !== subject || identity.client_id !== clientId || !scopes || !scopes.every((scope) => identity.scope?.split(/\s+/).includes(scope))) throw new PlanError('invalid_token_binding');
    return scopes;
  }

  async startLogin(clientId?: string, enablePlan = false): Promise<{ id: string; launchPath: string }> {
    const prepared = await this.locked(async (state) => {
      const account = clientId ? state.accounts.find((candidate) => candidate.client_id === clientId) : undefined;
      if (clientId && !account) throw new PlanError('account_not_found');
      return { account, hostId: state.hostId };
    });
    for (const earlier of [...this.pending.values()]) if (earlier.phase === 'pending') this.cancelLogin(earlier.id);
    const id = randomBytes(24).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const server = createServer((request, response) => {
      const expectedHost = new URL(this.pending.get(id)?.redirectUri ?? 'http://127.0.0.1').host;
      if (request.method !== 'GET' || request.headers.host !== expectedHost || new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/auth/callback') {
        response.writeHead(400); response.end('Invalid callback.'); return;
      }
      void this.completeLogin(id, new URL(request.url!, 'http://127.0.0.1').searchParams).then(() => {
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        response.end('ChatGPT connected to Lattice. Return to Settings to choose and test a model.');
      }, () => { response.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('Sign-in did not complete. Return to Lattice and start again.'); });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new PlanError('callback_listener_unavailable');
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const url = new URL(`${CHATGPT_ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({ client_id: prepared.account?.client_id ?? 'dynamic_agent_client',
      ext_agent_host_id: prepared.hostId, redirect_uri: redirectUri, response_type: 'code', resource: CHATGPT_RESOURCE,
      scope: CHATGPT_SCOPES, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      ...(!prepared.account ? { agent_name_hint: 'Lattice' } : {}),
      ...(prepared.account?.email ? { login_hint: prepared.account.email } : {}), ...(enablePlan ? { prompt: 'consent' } : {}),
    }).toString();
    const timer = setTimeout(() => this.cancelLogin(id), 10 * 60 * 1000);
    timer.unref();
    this.pending.set(id, { id, state, nonce, verifier, redirectUri, account: prepared.account, expiresAt: this.now() + 600000, server, timer, phase: 'pending', url: url.toString() });
    return { id, launchPath: `/api/chatgpt-plan/login/${id}/launch` };
  }

  authorizationUrl(id: string): string {
    const pending = this.pending.get(id);
    if (!pending || pending.phase !== 'pending' || pending.expiresAt < this.now()) throw new PlanError('login_expired');
    return pending.url;
  }

  loginStatus(id: string): { phase: 'pending' | 'complete' | 'failed'; error?: string } {
    const pending = this.pending.get(id);
    if (!pending) return { phase: 'failed', error: 'login_expired' };
    // A callback being exchanged is still unfinished to anyone polling; it is not offered again.
    return { phase: pending.phase === 'exchanging' ? 'pending' : pending.phase, error: pending.error };
  }

  /** The sign-in still waiting for approval, so a reloaded page can offer its paste step again. */
  pendingLogin(): { id: string; launchPath: string; expiresAt: number } | null {
    const pending = [...this.pending.values()].find((login) => login.phase === 'pending' && login.expiresAt >= this.now());
    return pending ? { id: pending.id, launchPath: `/api/chatgpt-plan/login/${pending.id}/launch`, expiresAt: pending.expiresAt } : null;
  }

  cancelLogin(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer); pending.server.close(); this.pending.delete(id);
  }

  /** Completes a sign-in from the callback address the user copied out of a browser on another device. Never log `pasted`. */
  async completePastedCallback(id: string, pasted: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || pending.phase !== 'pending' || pending.expiresAt < this.now()) throw new PlanError('login_expired');
    const text = pasted.trim();
    let address: URL;
    try { address = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`); } catch { throw new PlanError('invalid_callback_address'); }
    if (address.pathname !== '/auth/callback' || !address.searchParams.has('state')) throw new PlanError('invalid_callback_address');
    await this.completeLogin(id, address.searchParams);
  }

  async completeLogin(id: string, callback: URLSearchParams): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || pending.phase !== 'pending' || pending.expiresAt < this.now()) throw new PlanError('login_expired');
    const returnedState = callback.get('state') ?? '';
    if (Buffer.byteLength(returnedState) !== Buffer.byteLength(pending.state) || !timingSafeEqual(Buffer.from(returnedState), Buffer.from(pending.state))) throw new PlanError('invalid_oauth_state');
    pending.phase = 'exchanging';
    clearTimeout(pending.timer);
    pending.server.close();
    try {
      if (callback.has('error')) throw new PlanError('authorization_declined');
      if (['state', 'code', 'client_id', 'error'].some((key) => callback.getAll(key).length > 1)) throw new PlanError('invalid_callback');
      const clientId = callback.get('client_id') ?? pending.account?.client_id;
      if (!clientId || !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId) || (pending.account && pending.account.client_id !== clientId) || !callback.get('code')) throw new PlanError('invalid_issued_client');
      const tokens = await this.tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code: callback.get('code')!, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: CHATGPT_RESOURCE });
      if (!tokens.id_token) throw new PlanError('missing_id_token');
      const identity = await this.validateToken(tokens.id_token, clientId, pending.nonce);
      if (pending.account && pending.account.subject !== identity.sub) throw new PlanError('wrong_account');
      const scopes = await this.validateAccess(tokens, clientId, identity.sub);
      await this.locked(async (saved) => {
        const existing = saved.accounts.find((account) => account.client_id === clientId);
        if (existing && existing.subject !== identity.sub) throw new PlanError('wrong_account');
        const account: PlanRegistration = { ...existing, issuer: CHATGPT_ISSUER, subject: identity.sub, email: identity.email, client_id: clientId, ext_agent_host_id: saved.hostId,
          access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token, scopes, expires_at: this.now() + tokens.expires_in * 1000,
          earliest_refresh_at: tokens.earliest_refresh_at, paused: undefined, verified_model: undefined };
        saved.accounts = saved.accounts.filter((candidate) => candidate.client_id !== clientId).concat(account);
        if (!saved.active) saved.active = clientId;
        await this.writeState(saved);
      });
      pending.phase = 'complete';
    } catch (error) {
      pending.phase = 'failed';
      pending.error = error instanceof PlanError ? error.code : 'sign_in_failed';
      throw new PlanError(pending.error);
    } finally {
      pending.url = ''; pending.verifier = ''; pending.nonce = ''; pending.account = undefined;
      const cleanup = setTimeout(() => this.pending.delete(id), 60000); cleanup.unref();
    }
  }

  async accessToken(verifiedModel?: string): Promise<string> {
    return this.locked(async (state) => {
      const account = state.accounts.find((candidate) => candidate.client_id === state.active);
      if (!account?.access_token || !account.refresh_token) throw new PlanError('sign_in_required', 401);
      if (!account.scopes.includes(DIRECT_SCOPE) || !account.scopes.includes('resource.invoke')) throw new PlanError('plan_permission_required', 403);
      if (account.paused) throw new PlanError(account.paused, 429);
      if (verifiedModel !== undefined && account.verified_model !== verifiedModel) throw new PlanError('test_model_before_activation', 409);
      if (account.expires_at > this.now() + 60000) return account.access_token;
      if (account.earliest_refresh_at && account.earliest_refresh_at * 1000 > this.now()) {
        if (account.expires_at > this.now()) return account.access_token;
        throw new PlanError('refresh_not_yet_available', 503);
      }
      try {
        const tokens = await this.tokenRequest({ grant_type: 'refresh_token', client_id: account.client_id, refresh_token: account.refresh_token, resource: CHATGPT_RESOURCE });
        const scopes = await this.validateAccess(tokens, account.client_id, account.subject, account.scopes);
        if (tokens.id_token) {
          const identity = await this.validateToken(tokens.id_token, account.client_id);
          if (identity.sub !== account.subject) throw new PlanError('wrong_account');
        }
        Object.assign(account, { access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token ?? account.id_token,
          scopes, expires_at: this.now() + tokens.expires_in * 1000, earliest_refresh_at: tokens.earliest_refresh_at });
        await this.writeState(state);
        if (!scopes.includes(DIRECT_SCOPE) || !scopes.includes('resource.invoke')) throw new PlanError('plan_permission_required', 403);
        return account.access_token!;
      } catch (error) {
        if (error instanceof PlanError && TERMINAL_REFRESH_ERRORS.has(error.code)) {
          account.access_token = undefined; account.refresh_token = undefined; account.id_token = undefined; account.verified_model = undefined;
          await this.writeState(state);
        }
        throw error;
      }
    });
  }

  async updateActive(update: Partial<Pick<PlanRegistration, 'paused' | 'verified_model' | 'welcomed'>>, expectedClientId?: string): Promise<void> {
    await this.locked(async (state) => {
      const account = state.accounts.find((candidate) => candidate.client_id === (expectedClientId ?? state.active));
      if (!account) throw new PlanError('sign_in_required', 401);
      Object.assign(account, update); await this.writeState(state);
    });
  }

  async selectAccount(clientId: string): Promise<void> {
    await this.locked(async (state) => {
      const account = state.accounts.find((candidate) => candidate.client_id === clientId);
      if (!account?.access_token) throw new PlanError('sign_in_required', 401);
      state.active = clientId; account.verified_model = undefined; await this.writeState(state);
    });
  }

  async verifyModel(model: string, clientId: string): Promise<void> {
    await this.locked(async (state) => {
      const account = state.accounts.find((candidate) => candidate.client_id === state.active);
      if (!account?.access_token || account.client_id !== clientId || account.paused || !account.scopes.includes(DIRECT_SCOPE)) throw new PlanError('account_changed_during_verification', 409);
      account.verified_model = model; await this.writeState(state);
    });
  }

  async requireVerifiedModel(model: string): Promise<void> {
    await this.locked(async (state) => {
      const account = state.accounts.find((candidate) => candidate.client_id === state.active);
      if (account?.verified_model !== model) throw new PlanError('test_model_before_activation', 409);
    });
  }

  async importCredentials(file: string): Promise<void> {
    const imported = parsePlanJson(await this.readProtected(path.resolve(file))) as PlanRegistration;
    if (!imported || typeof imported.client_id !== 'string' || !/^oaiapp_[A-Za-z0-9_-]+$/.test(imported.client_id) || typeof imported.id_token !== 'string' || typeof imported.access_token !== 'string' || typeof imported.refresh_token !== 'string' || !imported.id_token || !imported.access_token || !imported.refresh_token || !Array.isArray(imported.scopes) || imported.scopes.some((scope) => typeof scope !== 'string') || imported.issuer !== CHATGPT_ISSUER) throw new PlanError('invalid_credential_record');
    const identity = await this.validateToken(imported.id_token, imported.client_id, undefined, true);
    if (identity.sub !== imported.subject) throw new PlanError('wrong_account');
    const access = await this.validateToken(imported.access_token, CHATGPT_RESOURCE);
    const scopes = await this.validateAccess({ ...imported, token_type: 'Bearer', expires_in: 3600, scope: imported.scopes.join(' ') } as TokenSet, imported.client_id, identity.sub);
    await this.locked(async (state) => {
      const existing = state.accounts.find((candidate) => candidate.client_id === imported.client_id);
      if (existing && existing.subject !== identity.sub) throw new PlanError('wrong_account');
      const account: PlanRegistration = { issuer: CHATGPT_ISSUER, subject: identity.sub, email: identity.email, client_id: imported.client_id,
        access_token: imported.access_token, refresh_token: imported.refresh_token, id_token: imported.id_token, scopes,
        expires_at: access.exp * 1000, ext_agent_host_id: state.hostId, earliest_refresh_at: imported.earliest_refresh_at, welcomed: existing?.welcomed };
      state.accounts = state.accounts.filter((candidate) => candidate.client_id !== imported.client_id).concat(account);
      state.active = account.client_id; await this.writeState(state);
    });
  }

  async exportCredentials(file: string): Promise<void> {
    await this.locked(async (state) => {
      const account = state.accounts.find((candidate) => candidate.client_id === state.active);
      if (!account?.refresh_token) throw new PlanError('sign_in_required', 401);
      const handle = await fs.open(path.resolve(file), 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(account)); await handle.sync(); } finally { await handle.close(); }
      account.access_token = undefined; account.refresh_token = undefined; account.id_token = undefined; account.verified_model = undefined;
      await this.writeState(state);
    });
  }

  async disconnect(): Promise<{ revoked: boolean }> {
    return this.locked(async (state) => {
      const account = state.accounts.find((candidate) => candidate.client_id === state.active);
      if (!account) return { revoked: true };
      let revoked = !account.refresh_token;
      if (account.refresh_token) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
          const discovery = await planHttpJson(await this.http(`${CHATGPT_ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000) })) as { revocation_endpoint: string };
          const endpoint = new URL(discovery.revocation_endpoint);
          if (endpoint.origin !== CHATGPT_ISSUER) throw new PlanError('invalid_revocation_endpoint');
          const response = await this.http(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: account.refresh_token, token_type_hint: 'refresh_token', client_id: account.client_id }), signal: AbortSignal.timeout(15000) });
          revoked = response.status === 200;
          if (revoked || response.status < 500) break;
          } catch { revoked = false; }
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      account.access_token = undefined; account.refresh_token = undefined; account.id_token = undefined; account.verified_model = undefined;
      await this.writeState(state);
      return { revoked };
    });
  }
}

export const chatgptPlanAuth = new ChatGPTPlanAuth();
