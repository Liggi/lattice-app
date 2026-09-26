#!/usr/bin/env -S npx tsx
import path from 'node:path';
import { SessionInfoService } from '@/services/sessions/session-info-service.js';
import { CONFIG_DIR_NAME } from '@/utils/constants.js';

async function main(): Promise<void> {
  const targetRoot = process.argv[2] ?? '/tmp/lattice-ci-verify';
  const rootPath = path.resolve(targetRoot);

  SessionInfoService.resetInstance();
  const service = new SessionInfoService(rootPath);
  await service.initialize();

  const dbPath = path.join(rootPath, CONFIG_DIR_NAME, 'session-info.db');
  console.log(dbPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
