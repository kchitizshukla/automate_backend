// ──────────────────────────────────────────────
// AutoMate / FixMyRide — consolidated backend.
//
// One Express process mounts all three route modules:
//   /api/user      -> apps/backend/user/src/routes.ts
//   /api/mechanic  -> apps/backend/mechanic/src/routes.ts
//   /api/admin     -> apps/backend/admin/src/routes.ts
//
// The modules keep their own folders, their own Pool and their own database
// (am_user / am_mech / am_admin) — only the deployment unit is merged, so a
// free-tier host cold-starts once instead of three times and the user<->mechanic
// dispatch calls become loopback rather than cross-service HTTP.
// ──────────────────────────────────────────────
import { PORT } from './env.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import morgan from 'morgan';

import { router as userRouter } from '../../user/src/routes.js';
import { router as mechanicRouter } from '../../mechanic/src/routes.js';
import { router as adminRouter } from '../../admin/src/routes.js';

import { assertDbReady as assertUserDb } from '../../user/src/db.js';
import { assertDbReady as assertMechanicDb } from '../../mechanic/src/db.js';
import { assertDbReady as assertAdminDb } from '../../admin/src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '../..');

const app = express();

// An empty/unset CORS_ORIGINS keeps the permissive dev behaviour. In production
// set it to the comma-separated Vercel origins of the four web apps.
const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors(
    allowedOrigins.length
      ? {
          origin(origin, cb) {
            // Same-origin and server-to-server requests send no Origin header;
            // the loopback dispatch calls below rely on that being allowed.
            if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
            // Reflect nothing rather than throwing: the browser enforces the
            // block, and the request does not surface as a 500 in our logs.
            cb(null, false);
          },
          credentials: true,
        }
      : {},
  ),
);

app.use(express.json());
app.use(morgan('dev'));

// Each module writes uploads into its own folder via multer, and stores the
// path as "/uploads/<file>". Serving that under the module's own API prefix
// keeps the three namespaces from colliding and makes `<apiBaseUrl><imagePath>`
// resolve correctly from the frontends.
for (const mod of ['user', 'mechanic', 'admin'] as const) {
  app.use(`/api/${mod}/uploads`, express.static(path.join(backendRoot, mod, 'uploads')));
}

app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'fixmyride-backend', modules: ['user', 'mechanic', 'admin'] }),
);

app.use('/api/user', userRouter);
app.use('/api/mechanic', mechanicRouter);
app.use('/api/admin', adminRouter);

app.use((_req: Request, res: Response) => res.status(404).json({ error: 'Route not found' }));

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[backend] Unhandled error:', err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// Every module's connection is checked before the port opens, so a bad
// DATABASE_URL fails the deploy instead of surfacing on the first request.
Promise.all([assertUserDb(), assertMechanicDb(), assertAdminDb()])
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✓ FixMyRide backend on http://localhost:${PORT}`);
      console.log(`  /api/user  ·  /api/mechanic  ·  /api/admin  ·  /health`);
    });
  })
  .catch((err) => {
    console.error('\n[backend] Cannot reach PostgreSQL:', err.message);
    console.error('Check USER_DATABASE_URL / MECHANIC_DATABASE_URL / ADMIN_DATABASE_URL.\n');
    process.exit(1);
  });
