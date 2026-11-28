import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findStaleServers, forgetRunningServer, recordRunningServer, runningServersDir } from '../../src/server/running-server-code.js';

let checkout: string;
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(checkout, rel)), { recursive: true });
  fs.writeFileSync(path.join(checkout, rel), text);
};
const alive = () => true;

beforeEach(() => {
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-skew-'));
  write('src/services/gemini-spend.ts', 'export const shape = { today: 0 };');
  write('src/web/PlanUsageControl.tsx', 'export {};');
  recordRunningServer(checkout, 3045, 4242);
});
afterEach(() => fs.rmSync(checkout, { recursive: true, force: true }));

describe('client builds against a running server', () => {
  it('a server whose source is unchanged is not stale, whatever the client does', () => {
    write('src/web/PlanUsageControl.tsx', 'export const reads = "budget.usd";');
    expect(findStaleServers(checkout, alive)).toEqual([]);
  });

  it('names the server-side files changed, added or removed since the server started', () => {
    write('src/services/gemini-spend.ts', 'export const shape = { today: 0, budget: 0 };');
    write('src/routes/plan-usage.routes.ts', 'export {};');
    const [server] = findStaleServers(checkout, alive);
    expect(server).toMatchObject({ pid: 4242, port: 3045, changed: ['routes/plan-usage.routes.ts', 'services/gemini-spend.ts'] });
    fs.rmSync(path.join(checkout, 'src/services/gemini-spend.ts'));
    expect(findStaleServers(checkout, alive)[0].changed).toEqual(['routes/plan-usage.routes.ts', 'services/gemini-spend.ts']);
  });

  it('drops the record of a server that is no longer running, or stopped cleanly', () => {
    write('src/services/gemini-spend.ts', 'changed');
    expect(findStaleServers(checkout, () => false)).toEqual([]);
    expect(fs.readdirSync(runningServersDir(checkout))).toEqual([]);
    recordRunningServer(checkout, 3045, 4243);
    forgetRunningServer(checkout, 4243);
    expect(findStaleServers(checkout, alive)).toEqual([]);
  });
});
