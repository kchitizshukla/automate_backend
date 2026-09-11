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

app.get('/health', (_req, res) => res.json({ ok: true, service: 'user-backend' }));
app.use('/api', router);

app.use(notFound);
app.use(errorHandler);

const port = Number(process.env.USER_BACKEND_PORT) || 4001;

assertDbReady()
  .then(() => {
    app.listen(port, () => console.log(`✓ AutoMate USER backend on http://localhost:${port}`));
  })
  .catch((err) => {
    console.error('\n[user-backend] Cannot reach PostgreSQL:', err.message);
    console.error('Check USER_DATABASE_URL in apps/backend/user/.env and that the server is running.\n');
    process.exit(1);
  });
