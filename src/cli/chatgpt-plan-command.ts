import { execFile } from 'node:child_process';
import { chatgptPlanAuth } from '../services/infrastructure/chatgpt-plan-auth.js';
import { chatgptPlanClient } from '../services/infrastructure/chatgpt-plan-client.js';

export const CHATGPT_PLAN_USAGE = `  lattice chatgpt-plan login [--account <issued-client-id>] [--enable-plan]
  lattice chatgpt-plan status | models | disconnect
  lattice chatgpt-plan export <new-protected-file>
  lattice chatgpt-plan import <protected-file>
      Import/export credentials only over SSH, never in chat or browser storage.
      Sign-in and import do not activate background routing or feature opt-ins.
`;

export async function runChatGPTPlanCommand(args: string[]): Promise<void> {
  const [verb, file] = args;
  if (verb === 'login') {
    const accountIndex = args.indexOf('--account');
    if (accountIndex >= 0 && !/^oaiapp_[A-Za-z0-9_-]+$/.test(args[accountIndex + 1] ?? '')) throw new Error('--account requires an issued OpenAI client ID.');
    const login = await chatgptPlanAuth.startLogin(accountIndex >= 0 ? args[accountIndex + 1] : undefined, args.includes('--enable-plan'));
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const url = chatgptPlanAuth.authorizationUrl(login.id);
    try {
      await new Promise<void>((resolve, reject) => execFile(command, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { timeout: 10000 }, (error) => error ? reject(new Error('Could not open the local browser; run this command on the browser computer.')) : resolve()));
      process.stdout.write('Complete Continue with ChatGPT in your local browser. No background routing is enabled yet.\n');
      for (;;) {
        const status = chatgptPlanAuth.loginStatus(login.id);
        if (status.phase === 'failed') throw new Error(`ChatGPT sign-in: ${status.error}`);
        if (status.phase === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      process.stdout.write('ChatGPT connected. Choose and test a discovered model in Lattice Settings before activation.\n');
    } finally { chatgptPlanAuth.cancelLogin(login.id); }
    return;
  }
  if (verb === 'status') { process.stdout.write(`${JSON.stringify(await chatgptPlanAuth.status(), null, 2)}\n`); return; }
  if (verb === 'models') { process.stdout.write(`${JSON.stringify(await chatgptPlanClient.models(), null, 2)}\n`); return; }
  if (verb === 'export' && file) { await chatgptPlanAuth.exportCredentials(file); process.stdout.write('Protected credential file written. Source tokens cleared without revoking the transferred session. Transfer with SSH; the destination runtime owns refresh afterwards.\n'); return; }
  if (verb === 'import' && file) { await chatgptPlanAuth.importCredentials(file); process.stdout.write('Credentials imported; server host ID preserved. Routing is unchanged. Do not refresh the transferred session on the source computer.\n'); return; }
  if (verb === 'disconnect') {
    const result = await chatgptPlanAuth.disconnect();
    process.stdout.write(result.revoked ? 'ChatGPT disconnected.\n' : 'Local credentials cleared. Remote revocation was not confirmed; disconnect Lattice in ChatGPT Settings.\n'); return;
  }
  process.stdout.write(CHATGPT_PLAN_USAGE);
}
