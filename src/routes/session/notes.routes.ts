/**
 * Dev Notes routes - quick issue/todo capture queue.
 *
 * Endpoints:
 * - GET /api/notes - List pending notes
 * - POST /api/notes - Create a new note
 * - PATCH /api/notes/:id - Update note content/priority/status
 * - DELETE /api/notes/:id - Delete a note
 * - POST /api/notes/batch-done - Mark multiple notes as done
 */

import { Router } from 'express';
import { RequestWithRequestId } from '@/types/express.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { asyncHandler } from '@/middleware/error-handler.js';
import { DevNotesService } from '@/services/notes/dev-notes-service.js';

interface CreateNoteBody {
  content: string;
  priority?: 'low' | 'normal' | 'high';
  projectPath?: string;
}

interface UpdateNoteStatusBody {
  status?: 'pending' | 'done' | 'dismissed';
  content?: string;
  priority?: 'low' | 'normal' | 'high';
}

export function createNotesRoutes(): Router {
  const router = Router();
  const logger = createLogger('NotesRoutes');
  const devNotesService = DevNotesService.getInstance();

  // GET /api/notes - List pending notes
  router.get('/', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    logger.debug('Getting pending dev notes', { requestId });

    const notes = await devNotesService.getPendingDevNotes();
    logger.debug('Pending dev notes retrieved', { requestId, count: notes.length });

    res.json({ notes });
  }));

  // POST /api/notes - Create a new note
  router.post('/', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    const body = req.body as CreateNoteBody;

    if (!body.content || typeof body.content !== 'string' || body.content.trim().length === 0) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    logger.debug('Creating dev note', { requestId, priority: body.priority });

    const id = await devNotesService.createDevNote({
      content: body.content.trim(),
      priority: body.priority,
      projectPath: body.projectPath,
    });

    logger.info('Dev note created', { requestId, id });
    res.status(201).json({ id });
  }));

  // PATCH /api/notes/:id - Update note content/priority/status
  router.patch('/:id', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    const { id } = req.params;
    const body = req.body as UpdateNoteStatusBody;

    const hasStatus = body.status !== undefined;
    const hasContent = body.content !== undefined;
    const hasPriority = body.priority !== undefined;

    if (!hasStatus && !hasContent && !hasPriority) {
      res.status(400).json({ error: 'At least one update field is required' });
      return;
    }

    if (hasStatus && !['pending', 'done', 'dismissed'].includes(body.status!)) {
      res.status(400).json({ error: 'Status must be "pending", "done", or "dismissed"' });
      return;
    }

    if (hasPriority && !['low', 'normal', 'high'].includes(body.priority!)) {
      res.status(400).json({ error: 'Priority must be "low", "normal", or "high"' });
      return;
    }

    if (hasContent && (typeof body.content !== 'string' || body.content.trim().length === 0)) {
      res.status(400).json({ error: 'Content must be a non-empty string' });
      return;
    }

    const updates = {
      ...(hasStatus && { status: body.status }),
      ...(hasPriority && { priority: body.priority }),
      ...(hasContent && { content: body.content!.trim() }),
    } as {
      status?: 'pending' | 'done' | 'dismissed';
      priority?: 'low' | 'normal' | 'high';
      content?: string;
    };

    logger.debug('Updating dev note', {
      requestId,
      id,
      hasStatus,
      hasPriority,
      hasContent,
    });

    await devNotesService.updateDevNote(id, updates);

    logger.info('Dev note updated', { requestId, id });
    res.json({ success: true });
  }));

  // DELETE /api/notes/:id - Delete a note
  router.delete('/:id', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    const { id } = req.params;

    logger.debug('Deleting dev note', { requestId, id });

    await devNotesService.deleteDevNote(id);

    logger.info('Dev note deleted', { requestId, id });
    res.json({ success: true });
  }));

  return router;
}
