import { Router, Request } from 'express';
import {
  LatticeError,
  FileSystemListQuery,
  FileSystemListResponse,
  FileSystemReadQuery,
  FileSystemReadResponse
} from '@/types/index.js';
import { RequestWithRequestId } from '@/types/express.js';
import { FileSystemService } from '@/services/infrastructure/file-system-service.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { asyncHandler } from '@/middleware/error-handler.js';

export function createFileSystemRoutes(
  fileSystemService: FileSystemService
): Router {
  const router = Router();
  const logger = createLogger('FileSystemRoutes');

  // Helper to strictly parse boolean query params (accepts "true"/"false" and booleans)
  const parseBooleanParam = (value: unknown, paramName: string): boolean | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
    throw new LatticeError('INVALID_PARAM', `${paramName} must be boolean (true/false)`, 400);
  };


  // List directory contents
  router.get('/list', asyncHandler(async (req: Request<Record<string, never>, FileSystemListResponse, Record<string, never>, FileSystemListQuery> & RequestWithRequestId, res) => {
    const requestId = req.requestId;
    logger.debug('List directory request', {
      requestId,
      path: req.query.path,
      recursive: req.query.recursive,
      respectGitignore: req.query.respectGitignore
    });

    // Validate required parameters
    if (!req.query.path) {
      throw new LatticeError('MISSING_PATH', 'path query parameter is required', 400);
    }

    // Parse boolean query parameters
    const recursive = parseBooleanParam(req.query.recursive, 'recursive') ?? false;
    const respectGitignore = parseBooleanParam(req.query.respectGitignore, 'respectGitignore') ?? false;

    const result = await fileSystemService.listDirectory(
      req.query.path,
      recursive,
      respectGitignore
    );

    logger.debug('Directory listed successfully', {
      requestId,
      path: result.path,
      entryCount: result.entries.length
    });

    res.json(result);
  }));

  // Read file contents
  router.get('/read', asyncHandler(async (req: Request<Record<string, never>, FileSystemReadResponse, Record<string, never>, FileSystemReadQuery> & RequestWithRequestId, res) => {
    const requestId = req.requestId;
    logger.debug('Read file request', {
      requestId,
      path: req.query.path
    });

    // Validate required parameters
    if (!req.query.path) {
      throw new LatticeError('MISSING_PATH', 'path query parameter is required', 400);
    }

    const result = await fileSystemService.readFile(req.query.path);

    logger.debug('File read successfully', {
      requestId,
      path: result.path,
      size: result.size
    });

    res.json(result);
  }));

  return router;
}
