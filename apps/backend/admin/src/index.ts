import './env.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { router } from './routes.js';
import { errorHandler, notFound } from './middleware.js';
import { assertDbReady } from './db.js';

const __dirname = here;
const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use('/uploads', express.static(path.resolve(__dirname, '../uploads')));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'admin-backend' }));
app.use('/api', router);

app.use(notFound);
app.use(errorHandler);

const port = Number(process.env.ADMIN_BACKEND_PORT) || 4003;

assertDbReady()
  .then(() => {
    app.listen(port, () => console.log(`✓ AutoMate ADMIN backend on http://localhost:${port}`));
  })
  .catch((err) => {
    console.error('\n[admin-backend] Cannot reach PostgreSQL:', err.message);
    console.error('Check ADMIN_DATABASE_URL in apps/backend/admin/.env and that the server is running.\n');
    process.exit(1);
  });
