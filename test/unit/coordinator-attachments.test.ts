/**
 * An image attached to a coordinator's message is written to disk unchanged
 * and the path travels with the message, so a worker can be given the file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SessionManager } from '@liggi/agent-ui-harness/server';
import { DatabaseProvider } from '../../src/services/infrastructure/database-provider.js';
import { ConversationService } from '../../src/services/sessions/conversation-service.js';
import { SessionInfoService } from '../../src/services/sessions/session-info-service.js';
import { createHarnessRoutes } from '../../src/harness/routes.js';
import { persistCoordinatorImages } from '../../src/services/sessions/coordinator-attachments.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } } as const;

let dir: string;
let previousConfigDir: string | undefined;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-attachments-'));
  previousConfigDir = process.env.LATTICE_CONFIG_DIR;
  process.env.LATTICE_CONFIG_DIR = dir;
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
  await new SessionInfoService(':memory:').initialize();
});
afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = previousConfigDir;
  fs.rmSync(dir, { recursive: true, force: true });
  ConversationService.resetInstance();
  DatabaseProvider.resetInstance();
});

describe('persistCoordinatorImages', () => {
  it('writes the bytes unchanged and appends a text block naming the file', () => {
    const now = new Date('2026-09-20T08:30:00.000Z');
    const blocks = persistCoordinatorImages('conv-c', [image], { configDir: dir, now });
    const file = path.join(dir, 'attachments', 'conv-c', '2026-09-20T08-30-00-000Z-1.png');
    expect(fs.readFileSync(file)).toEqual(PNG);
    expect(blocks).toEqual([image, { type: 'text', text: `Attached image saved at ${file} — give a worker this path if it needs the image.` }]);
  });

  it('leaves a message with no image alone', () => {
    const blocks = [{ type: 'text', text: 'hello' } as const];
    expect(persistCoordinatorImages('conv-c', blocks, { configDir: dir })).toBe(blocks);
    expect(fs.existsSync(path.join(dir, 'attachments'))).toBe(false);
  });
});

describe('send route', () => {
  function build(sendImpl: SessionManager['send']) {
    const send = vi.fn(sendImpl);
    const sessionManager = {
      send,
      getLog: () => ({ latest: () => null, append: () => ({}) }),
      inspect: () => ({ processAlive: true, status: 'idle', runId: 'run-1' }),
    } as unknown as SessionManager;
    const app = express();
    app.use(express.json());
    app.use('/api/harness', createHarnessRoutes(sessionManager, {
      resolveResumeSessionId: (id) => id,
      resolveProvider: () => 'codex',
      resolveWorkingDirectory: () => '/tmp',
    }));
    return { app, send };
  }

  it('hands a coordinator the saved path alongside the image, and a plain session only the image', async () => {
    const service = ConversationService.getInstance();
    const coordinator = service.createConversation({ workingDirectory: '/tmp', provider: 'codex', providerSessionId: 'p-1', coordinator: true }).conversationId;
    const plain = service.createConversation({ workingDirectory: '/tmp', provider: 'codex', providerSessionId: 'p-2' }).conversationId;
    const { app, send } = build(async () => {});

    await request(app).post(`/api/harness/${coordinator}/send`).send({ input: 'look', attachments: [image] }).expect(200);
    const extra = send.mock.calls[0][2] as { attachments: Array<{ type: string; text?: string }> };
    expect(extra.attachments.map((block) => block.type)).toEqual(['image', 'text']);
    expect(extra.attachments[1].text).toMatch(new RegExp(`^Attached image saved at ${path.join(dir, 'attachments', coordinator)}/`));

    await request(app).post(`/api/harness/${plain}/send`).send({ input: 'look', attachments: [image] }).expect(200);
    expect((send.mock.calls[1][2] as { attachments: unknown[] }).attachments).toEqual([image]);
    expect(fs.existsSync(path.join(dir, 'attachments', plain))).toBe(false);
  });
});
