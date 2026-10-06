import { Router } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { requireTrustedOrigin } from '@/middleware/trusted-origin.js';
import { AttachedFileError, receiveUpload } from '@/services/sessions/large-attached-files.js';

/**
 * `POST /api/attachment-uploads`: the composer streams a large text file here
 * as it is attached (raw bytes, `application/octet-stream`), and the message
 * later carries only the returned id. See large-attached-files.ts.
 */
export function createAttachmentUploadRoutes(): Router {
  const router = Router();
  router.post('/', requireTrustedOrigin, asyncHandler(async (req, res) => {
    if (req.is('application/json')) {
      res.status(415).json({ error: 'Send the file as raw bytes (application/octet-stream)' });
      return;
    }
    try {
      res.json(await receiveUpload(req));
    } catch (error) {
      if (!(error instanceof AttachedFileError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  }));
  return router;
}
