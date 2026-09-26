/**
 * DevNotesService — quick issue/todo capture queue.
 *
 * Owns the dev_notes table (session-independent CRUD).
 * Single consumer: notes.routes.ts.
 */

import { DatabaseProvider } from '../infrastructure/database-provider.js';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import type Database from 'better-sqlite3';

export interface DevNote {
  id: string;
  content: string;
  priority: 'low' | 'normal' | 'high';
  status: 'pending' | 'done' | 'dismissed';
  projectPath: string | null;
  createdAt: string;
}

export class DevNotesService {
  private static instance: DevNotesService;
  private logger: Logger;
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.logger = createLogger('DevNotesService');
    this.db = db ?? DatabaseProvider.getInstance().getDb();
  }

  static getInstance(): DevNotesService {
    if (!DevNotesService.instance) {
      DevNotesService.instance = new DevNotesService();
    }
    return DevNotesService.instance;
  }

  static resetInstance(): void {
    DevNotesService.instance = null as unknown as DevNotesService;
  }

  async createDevNote(note: {
    content: string;
    priority?: 'low' | 'normal' | 'high';
    projectPath?: string | null;
  }): Promise<string> {
    const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(`
      INSERT INTO dev_notes (id, content, priority, status, project_path, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(
      id,
      note.content,
      note.priority || 'normal',
      note.projectPath ?? null,
      new Date().toISOString()
    );
    this.logger.debug('Dev note created', { id, priority: note.priority || 'normal' });
    return id;
  }

  async getPendingDevNotes(): Promise<DevNote[]> {
    const rows = this.db.prepare(`
      SELECT id, content, priority, status, project_path, created_at
      FROM dev_notes
      WHERE status = 'pending'
      ORDER BY
        CASE priority
          WHEN 'high' THEN 0
          WHEN 'normal' THEN 1
          WHEN 'low' THEN 2
        END,
        created_at DESC
    `).all() as Array<{
      id: string;
      content: string;
      priority: string;
      status: string;
      project_path: string | null;
      created_at: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      content: row.content,
      priority: row.priority as 'low' | 'normal' | 'high',
      status: row.status as 'pending' | 'done' | 'dismissed',
      projectPath: row.project_path,
      createdAt: row.created_at,
    }));
  }

  async updateDevNote(noteId: string, updates: {
    content?: string;
    priority?: 'low' | 'normal' | 'high';
    status?: 'pending' | 'done' | 'dismissed';
  }): Promise<void> {
    const assignments: string[] = [];
    const params: Array<string | null> = [];

    if (updates.content !== undefined) {
      assignments.push('content = ?');
      params.push(updates.content);
    }

    if (updates.priority !== undefined) {
      assignments.push('priority = ?');
      params.push(updates.priority);
    }

    if (updates.status !== undefined) {
      assignments.push('status = ?');
      params.push(updates.status);
      assignments.push('actioned_at = ?');
      params.push(updates.status === 'pending' ? null : new Date().toISOString());
    }

    if (assignments.length === 0) return;

    this.db.prepare(`
      UPDATE dev_notes
      SET ${assignments.join(', ')}
      WHERE id = ?
    `).run(...params, noteId);
    this.logger.debug('Dev note updated', { id: noteId, updatedFields: Object.keys(updates) });
  }

  async deleteDevNote(noteId: string): Promise<void> {
    this.db.prepare('DELETE FROM dev_notes WHERE id = ?').run(noteId);
    this.logger.debug('Dev note deleted', { id: noteId });
  }

  async markAllDevNotesAsDone(noteIds: string[]): Promise<void> {
    if (noteIds.length === 0) return;
    const stmt = this.db.prepare(`
      UPDATE dev_notes SET status = 'done', actioned_at = ?
      WHERE id = ?
    `);
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      for (const id of noteIds) {
        stmt.run(now, id);
      }
    });
    transaction();
    this.logger.debug('Dev notes marked as done', { count: noteIds.length });
  }
}
