import { Router } from 'express';
import { WorkingDirectoriesService } from '@/services/working-directories-service.js';
import { createLogger } from '@/services/infrastructure/logger.js';
import { asyncHandler } from '@/middleware/error-handler.js';
import { RequestWithRequestId } from '@/types/express.js';

export function createWorkingDirectoriesRoutes(
  workingDirectoriesService: WorkingDirectoriesService
): Router {
  const router = Router();
  const logger = createLogger('WorkingDirectoriesRoutes');

  router.get('/', asyncHandler(async (req: RequestWithRequestId, res) => {
    const requestId = req.requestId;
    logger.debug('Getting working directories', { requestId });

    const result = await workingDirectoriesService.getWorkingDirectories();

    logger.debug('Retrieved working directories', {
      requestId,
      totalDirectories: result.totalCount
    });

    res.json(result);
  }));

  return router;
}
