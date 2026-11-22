import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createDatabaseCluster } from './server/db';
import { createApiRouter } from './server/routes';
import { sendProblem, traceMiddleware } from './server/auth';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  const db = createDatabaseCluster();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));
  app.use(traceMiddleware);

  // Structured request logging for /api routes
  app.use('/api', (req, res, next) => {
    const start = performance.now();
    res.on('finish', () => {
      if (process.env.LOG_JSON === 'true') {
        console.log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: res.statusCode >= 500 ? 'ERROR' : 'INFO',
            traceId: (req as { traceId?: string }).traceId,
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            durationMs: Number((performance.now() - start).toFixed(2)),
          })
        );
      }
    });
    next();
  });

  // Mount PharmaSync REST API
  app.use('/api', createApiRouter(db));

  // Unmatched API routes return RFC 9457 Problem Details
  app.use('/api', (req, res) => {
    sendProblem(res, 404, 'Not Found', `API route ${req.method} ${req.originalUrl} does not exist.`, undefined, (req as { traceId?: string }).traceId);
  });

  if (isProduction) {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PharmaSync server listening on http://localhost:${PORT} (${isProduction ? 'production' : 'development'})`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start PharmaSync server:', err);
  process.exit(1);
});
