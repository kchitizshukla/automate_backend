// Environment loading, isolated in its own module because ES module imports are
// hoisted: db.ts would otherwise read process.env before dotenv.config() ran.
// index.ts imports this file first, so every later import sees a populated env.
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// This module's own .env wins; the repo-root .env fills in anything it omits.
// dotenv never overwrites an already-set key, so order is precedence.
dotenv.config({ path: path.resolve(here, '../.env') });
dotenv.config({ path: path.resolve(here, '../../../../.env') });
