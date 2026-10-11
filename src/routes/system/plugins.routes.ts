import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '@/middleware/error-handler.js';
import { requireTrustedOrigin } from '@/middleware/trusted-origin.js';
import { getPlugin, listPlugins, pluginAsset } from '@/services/plugins/plugin-registry.js';

/**
 * Plugins (`services/plugins/plugin-registry.ts`): the list Settings and the
 * web app read, each plugin's web entry and stylesheet, the commands agents
 * send with `lattice plugin`, and the plugin's own routes. Browser requests
 * from other sites are refused, as a plugin's routes may change things.
 */
export function createPluginsRoutes(): Router {
  const router = Router();
  router.use(requireTrustedOrigin);

  router.get('/', (_req, res) => {
    res.json({ plugins: listPlugins() });
  });

  for (const [file, kind] of [['web.js', 'web'], ['web.css', 'css']] as const) {
    router.get(`/:id/assets/${file}`, (req, res) => {
      const asset = pluginAsset(req.params.id, kind);
      if (!asset) {
        res.status(404).json({ error: `No ${kind} entry for plugin ${req.params.id}` });
        return;
      }
      // The plugin can be reinstalled under the same URL.
      res.sendFile(asset, { headers: { 'Cache-Control': 'no-cache' } });
    });
  }

  router.post('/:id/commands/:command', asyncHandler(async (req, res) => {
    const handler = getPlugin(req.params.id)?.commands.get(req.params.command);
    if (!handler) {
      res.status(404).json({ error: `The ${req.params.id} plugin is not loaded, or has no command "${req.params.command}".` });
      return;
    }
    const body = (req.body ?? {}) as { session?: unknown; args?: unknown; text?: unknown };
    if (typeof body.session !== 'string' || !body.session) {
      res.status(400).json({ error: '--session is required: the conversation the command is for.' });
      return;
    }
    const args: Record<string, string> = {};
    if (body.args && typeof body.args === 'object') {
      for (const [key, value] of Object.entries(body.args)) if (typeof value === 'string') args[key] = value;
    }
    try {
      const output = await handler({ session: body.session, args, text: typeof body.text === 'string' ? body.text : '' });
      res.json({ output });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }));

  router.use('/:id', (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    const plugin = getPlugin(req.params.id);
    if (!plugin) {
      res.status(404).json({ error: `No plugin ${req.params.id} is loaded.` });
      return;
    }
    plugin.router(req, res, next);
  });

  return router;
}
