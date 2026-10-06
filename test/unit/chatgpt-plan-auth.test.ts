import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatGPTPlanAuth, CHATGPT_ISSUER, CHATGPT_RESOURCE, CHATGPT_SCOPES } from '../../src/services/infrastructure/chatgpt-plan-auth.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' };
const now = Date.now();
const directories: string[] = [];
const pending: Array<{ auth: ChatGPTPlanAuth; id: string }> = [];

function jwt(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: CHATGPT_ISSUER, sub: 'test-subject', iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, ...claims })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.privateKey).toString('base64url')}`;
}

async function setup(overrides: { nonce?: string; subject?: string; scope?: string; audience?: string; clientId?: string } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-plan-auth-'));
  directories.push(directory);
  let nonce = '';
  const http = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    if (String(url).endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    if (String(url).endsWith('/openid-configuration')) return Response.json({ revocation_endpoint: `${CHATGPT_ISSUER}/revoke` });
    if (String(url).endsWith('/revoke')) return new Response(null, { status: 200 });
    const form = options!.body as URLSearchParams;
    const clientId = form.get('client_id')!;
    const scope = overrides.scope ?? CHATGPT_SCOPES;
    return Response.json({ token_type: 'Bearer', expires_in: 3600, refresh_token: `refresh-${http.mock.calls.length}`, scope,
      access_token: jwt({ aud: CHATGPT_RESOURCE, client_id: overrides.clientId ?? clientId, scope, sub: overrides.subject ?? 'test-subject' }),
      id_token: jwt({ aud: overrides.audience ?? clientId, nonce: overrides.nonce ?? nonce, sub: overrides.subject ?? 'test-subject', email: 'fixture@example.invalid' }) });
  });
  const auth = new ChatGPTPlanAuth(directory, http as typeof fetch, () => now);
  const login = await auth.startLogin();
  pending.push({ auth, id: login.id });
  const authorization = new URL(auth.authorizationUrl(login.id));
  nonce = authorization.searchParams.get('nonce')!;
  const callback = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'synthetic-code', client_id: 'oaiapp_fixture' });
  return { directory, http, auth, login, authorization, callback, setNonce: (value: string) => { nonce = value; } };
}

afterEach(async () => {
  for (const login of pending.splice(0)) login.auth.cancelLogin(login.id);
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe('loopback OAuth contract', () => {
  it('binds state, nonce, PKCE, issued client, exact redirect and resource; never activates routing', async () => {
    const { auth, login, authorization, callback, http, directory } = await setup();
    expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorization.searchParams.get('agent_name_hint')).toBe('Lattice');
    expect(authorization.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(authorization.searchParams.get('scope')).toBe(CHATGPT_SCOPES);
    await auth.completeLogin(login.id, callback);
    const exchange = http.mock.calls.find(([url]) => String(url).endsWith('/oauth/token'))![1]!.body as URLSearchParams;
    expect(exchange.get('client_id')).toBe('oaiapp_fixture');
    expect(exchange.get('resource')).toBe(CHATGPT_RESOURCE);
    expect(exchange.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'));
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
    expect((await auth.status()).accounts[0]).toMatchObject({ planEnabled: true, verifiedModel: null });
    expect((await fs.stat(path.join(directory, 'accounts.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    const publicStatus = JSON.stringify(await auth.status());
    expect(publicStatus).not.toContain('refresh-');
    expect(publicStatus).not.toContain('access_token');
    await expect(auth.completeLogin(login.id, callback)).rejects.toThrow('login_expired');
  });

  it('completes from a pasted callback address with the same redirect and verifier, then refuses the loopback', async () => {
    const { auth, login, authorization, callback, http } = await setup();
    const redirect = authorization.searchParams.get('redirect_uri')!;
    expect(auth.pendingLogin()).toEqual({ id: login.id, launchPath: login.launchPath, expiresAt: expect.any(Number) });
    await expect(auth.completePastedCallback(login.id, 'https://chatgpt.com/')).rejects.toThrow('invalid_callback_address');
    await expect(auth.completePastedCallback(login.id, `${redirect}?${new URLSearchParams({ state: 'wrong', code: 'c' })}`)).rejects.toThrow('invalid_oauth_state');
    expect(http).not.toHaveBeenCalled();
    await auth.completePastedCallback(login.id, `  ${redirect.replace('http://', '')}?${callback}\n`);
    const exchange = http.mock.calls.find(([url]) => String(url).endsWith('/oauth/token'))![1]!.body as URLSearchParams;
    expect(exchange.get('redirect_uri')).toBe(redirect);
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
    expect(auth.loginStatus(login.id).phase).toBe('complete');
    expect(auth.pendingLogin()).toBeNull();
    expect((await fetch(`${redirect}?${callback}`).catch(() => null))?.ok ?? false).toBe(false);
    await expect(auth.completePastedCallback(login.id, `${redirect}?${callback}`)).rejects.toThrow('login_expired');
  });

  it('reports a sign-in as pending while its code is exchanged, and consumed for a second callback', async () => {
    const { auth, login, callback, http } = await setup();
    const exchange = http.getMockImplementation()!;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    http.mockImplementation(async (url, options) => { if (String(url).endsWith('/oauth/token')) await gate; return exchange(url, options); });
    const completing = auth.completeLogin(login.id, callback);
    await vi.waitFor(() => expect(http).toHaveBeenCalled());
    expect(auth.loginStatus(login.id)).toEqual({ phase: 'pending', error: undefined });
    expect(auth.pendingLogin()).toBeNull();
    await expect(auth.completeLogin(login.id, callback)).rejects.toThrow('login_expired');
    release();
    await completing;
    expect(auth.loginStatus(login.id).phase).toBe('complete');
  });

  it('keeps one pending sign-in, so a reloaded page resumes the newest', async () => {
    const { auth, login } = await setup();
    const again = await auth.startLogin(); pending.push({ auth, id: again.id });
    expect(auth.loginStatus(login.id)).toEqual({ phase: 'failed', error: 'login_expired' });
    expect(auth.pendingLogin()?.id).toBe(again.id);
    auth.cancelLogin(again.id);
    expect(auth.pendingLogin()).toBeNull();
  });

  it('rejects wrong state without exchanging a code, and consumes a declined consent', async () => {
    const { auth, login, callback, http } = await setup();
    callback.set('state', 'wrong');
    await expect(auth.completeLogin(login.id, callback)).rejects.toThrow('invalid_oauth_state');
    expect(http).not.toHaveBeenCalled();
    callback.set('state', new URL(auth.authorizationUrl(login.id)).searchParams.get('state')!);
    callback.set('error', 'access_denied');
    await expect(auth.completeLogin(login.id, callback)).rejects.toThrow('authorization_declined');
    expect(http).not.toHaveBeenCalled();
    expect(auth.loginStatus(login.id)).toEqual({ phase: 'failed', error: 'authorization_declined' });
  });

  it.each([{ nonce: 'wrong' }, { audience: 'oaiapp_wrong' }, { clientId: 'oaiapp_wrong' }])('rejects token binding mismatch %j', async (override) => {
    const { auth, login, callback } = await setup(override);
    await expect(auth.completeLogin(login.id, callback)).rejects.toThrow();
    expect((await auth.status()).accounts).toEqual([]);
  });

  it.each(['openid email offline_access', 'openid email offline_access chatgpt.tokens.use.direct'])('stores sign-in but refuses inference with incomplete scope: %s', async (scope) => {
    const { auth, login, callback } = await setup({ scope });
    await auth.completeLogin(login.id, callback);
    expect((await auth.status()).accounts[0].planEnabled).toBe(false);
    await expect(auth.accessToken()).rejects.toThrow('plan_permission_required');
  });

  it('reuses host/client identity and rejects a returning callback changing issued client', async () => {
    const { auth, login, authorization, callback, setNonce } = await setup();
    await auth.completeLogin(login.id, callback);
    const again = await auth.startLogin('oaiapp_fixture'); pending.push({ auth, id: again.id });
    const returning = new URL(auth.authorizationUrl(again.id));
    expect(returning.searchParams.get('ext_agent_host_id')).toBe(authorization.searchParams.get('ext_agent_host_id'));
    expect(returning.searchParams.get('agent_name_hint')).toBeNull();
    expect(returning.searchParams.get('id_token_hint')).toBeNull();
    expect(returning.searchParams.get('login_hint')).toBe('fixture@example.invalid');
    expect(returning.searchParams.get('client_id')).toBe('oaiapp_fixture');
    setNonce(returning.searchParams.get('nonce')!);
    await expect(auth.completeLogin(again.id, new URLSearchParams({ state: returning.searchParams.get('state')!, client_id: 'oaiapp_other', code: 'code' }))).rejects.toThrow('invalid_issued_client');
  });
  it('signs in again to a saved account from a pasted address, using login_hint and no ID token', async () => {
    const { auth, login, callback, setNonce } = await setup();
    await auth.completeLogin(login.id, callback);
    const again = await auth.startLogin('oaiapp_fixture'); pending.push({ auth, id: again.id });
    const returning = new URL(auth.authorizationUrl(again.id)); setNonce(returning.searchParams.get('nonce')!);
    expect(returning.toString()).not.toContain('eyJ');
    await auth.completePastedCallback(again.id, `${returning.searchParams.get('redirect_uri')}?${new URLSearchParams({ state: returning.searchParams.get('state')!, code: 'again' })}`);
    expect(auth.loginStatus(again.id).phase).toBe('complete');
    expect((await auth.status()).accounts).toEqual([expect.objectContaining({ id: 'oaiapp_fixture', connected: true, planEnabled: true })]);
  });
  it('rejects a returning identity with a different subject on the same issued client', async () => {
    const override = { subject: 'test-subject' };
    const { auth, login, callback, setNonce } = await setup(override);
    await auth.completeLogin(login.id, callback);
    const again = await auth.startLogin('oaiapp_fixture'); pending.push({ auth, id: again.id });
    const returning = new URL(auth.authorizationUrl(again.id)); setNonce(returning.searchParams.get('nonce')!);
    override.subject = 'different-subject';
    await expect(auth.completeLogin(again.id, new URLSearchParams({ state: returning.searchParams.get('state')!, code: 'code' }))).rejects.toThrow('wrong_account');
    expect((await auth.status()).accounts).toHaveLength(1);
  });

  it('checks signatures, issuer, expiry and not-before', async () => {
    const { auth } = await setup();
    for (const claims of [{ iss: 'https://example.invalid' }, { exp: 1 }, { nbf: now / 1000 + 1000 }]) {
      await expect(auth.validateToken(jwt({ aud: 'oaiapp_fixture', ...claims }), 'oaiapp_fixture')).rejects.toThrow('invalid_token_identity');
    }
    const signed = jwt({ aud: 'oaiapp_fixture' });
    await expect(auth.validateToken(`${signed.split('.').slice(0, 2).join('.')}.invalid`, 'oaiapp_fixture')).rejects.toThrow('invalid_token_signature');
    await expect(auth.validateToken(jwt({ aud: ['oaiapp_fixture', 'other'] }), 'oaiapp_fixture')).rejects.toThrow('invalid_token_identity');
    await expect(auth.validateToken(jwt({ aud: ['oaiapp_fixture', 'other'], azp: 'oaiapp_fixture' }), 'oaiapp_fixture')).resolves.toMatchObject({ sub: 'test-subject' });
  });
});

describe('protected credentials and refresh', () => {
  it('serializes rotating refresh across two runtime instances and atomically replaces the token set', async () => {
    const { auth, login, callback, directory, http } = await setup();
    await auth.completeLogin(login.id, callback);
    const file = path.join(directory, 'accounts.json');
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    state.accounts[0].expires_at = now - 1;
    await fs.writeFile(file, JSON.stringify(state), { mode: 0o600 });
    const other = new ChatGPTPlanAuth(directory, http as typeof fetch, () => now);
    const responses = await Promise.all([auth.accessToken(), other.accessToken(), auth.accessToken()]);
    expect(new Set(responses).size).toBe(1);
    const refreshes = http.mock.calls.filter(([_url, options]) => (options?.body as URLSearchParams)?.get('grant_type') === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    expect((refreshes[0][1]!.body as URLSearchParams).get('scope')).toBeNull();
    expect((refreshes[0][1]!.body as URLSearchParams).get('client_id')).toBe('oaiapp_fixture');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(saved.accounts[0].refresh_token).not.toBe(state.accounts[0].refresh_token);
    expect(saved.accounts[0].expires_at).toBeGreaterThan(now);
  });

  it.each([{ code: 'invalid_grant', status: 400, connected: false }, { code: 'temporarily_unavailable', status: 503, connected: true }])('handles refresh error $code without API fallback or unwanted credential loss', async ({ code, status, connected }) => {
    const { auth, login, callback, directory, http } = await setup();
    await auth.completeLogin(login.id, callback);
    const file = path.join(directory, 'accounts.json');
    const state = JSON.parse(await fs.readFile(file, 'utf8')); state.accounts[0].expires_at = now - 1;
    await fs.writeFile(file, JSON.stringify(state), { mode: 0o600 });
    http.mockResolvedValueOnce(Response.json({ error: code }, { status }));
    await expect(auth.accessToken()).rejects.toThrow(code);
    expect((await auth.status()).accounts[0].connected).toBe(connected);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(Boolean(saved.accounts[0].refresh_token)).toBe(connected);
  });

  it('preserves destination host identity on secure import, refuses symlinks/insecure files, and redacts malformed credentials', async () => {
    const { auth, login, callback, directory, http } = await setup();
    await auth.completeLogin(login.id, callback);
    const exportFile = path.join(directory, 'transfer.json'); await auth.exportCredentials(exportFile);
    expect((await auth.status()).accounts[0].connected).toBe(false);
    expect((await fs.stat(exportFile)).mode & 0o777).toBe(0o600);
    const remoteDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-plan-vm-')); directories.push(remoteDirectory);
    const remote = new ChatGPTPlanAuth(remoteDirectory, http as typeof fetch, () => now);
    await remote.status();
    const before = JSON.parse(await fs.readFile(path.join(remoteDirectory, 'accounts.json'), 'utf8'));
    await remote.importCredentials(exportFile);
    const after = JSON.parse(await fs.readFile(path.join(remoteDirectory, 'accounts.json'), 'utf8'));
    expect(after.hostId).toBe(before.hostId);
    expect(after.accounts[0].ext_agent_host_id).toBe(before.hostId);
    expect(after.accounts[0].verified_model).toBeUndefined();
    await fs.chmod(exportFile, 0o644);
    await expect(remote.importCredentials(exportFile)).rejects.toThrow('credential_file_not_owner_only');
    await fs.chmod(exportFile, 0o600);
    await fs.symlink(exportFile, path.join(directory, 'link'));
    await expect(remote.importCredentials(path.join(directory, 'link'))).rejects.toThrow();
    await fs.writeFile(exportFile, '{PRIVATE_CREDENTIAL_DO_NOT_PRINT');
    await expect(remote.importCredentials(exportFile)).rejects.toThrow('invalid_json_payload');
  });

  it('disconnects only the selected session, retains client mapping, and reports unconfirmed revocation', async () => {
    const { auth, login, callback, http } = await setup();
    await auth.completeLogin(login.id, callback);
    http.mockImplementation(async () => { throw new Error('network unavailable'); });
    expect(await auth.disconnect()).toEqual({ revoked: false });
    expect((await auth.status()).accounts[0]).toMatchObject({ id: 'oaiapp_fixture', connected: false });
    await expect(auth.accessToken()).rejects.toThrow('sign_in_required');
  });
});
