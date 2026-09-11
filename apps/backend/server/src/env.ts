// Environment loading, isolated in its own module because ES module imports are
// hoisted: each module's db.ts would otherwise read process.env before
// dotenv.config() ran. index.ts declares this import first, so every later
// import sees a populated env.
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(here, '../../../..');

// Snapshot the *real* environment before dotenv runs. The per-module .env files
// below still carry the split-service values (ports 4001/4002) from when each
// module was deployed on its own, and those must not win over the loopback
// wiring this process needs — but a genuine host/shell override must.
const realEnv = {
  USER_INTERNAL_API: process.env.USER_INTERNAL_API,
  MECHANIC_INTERNAL_API: process.env.MECHANIC_INTERNAL_API,
};

// dotenv never overwrites an already-set key, so order is precedence. Values
// already in process.env (Render's dashboard, a shell export) always win, which
// is why production needs no .env file at all — every path below is optional.
dotenv.config({ path: path.resolve(here, '../.env') });
dotenv.config({ path: path.join(backendRoot, 'user/.env') });
dotenv.config({ path: path.join(backendRoot, 'mechanic/.env') });
dotenv.config({ path: path.join(backendRoot, 'admin/.env') });
dotenv.config({ path: path.join(repoRoot, '.env') });

/** The one port the consolidated service listens on. Render injects PORT. */
export const PORT = Number(process.env.PORT) || Number(process.env.BACKEND_PORT) || 4000;

// The user and mechanic modules talk to each other over HTTP for roadside
// dispatch. Now that both live in this process those calls are loopback, so
// they resolve instantly instead of waiting on a second service to cold-start.
// Set these in the real environment only if you are running the modules split
// across separate services again.
process.env.USER_INTERNAL_API = realEnv.USER_INTERNAL_API || `http://127.0.0.1:${PORT}/api/user`;
process.env.MECHANIC_INTERNAL_API =
  realEnv.MECHANIC_INTERNAL_API || `http://127.0.0.1:${PORT}/api/mechanic`;

// Each module's db.ts exits the process on its own missing URL. In a single
// service that would report one variable per restart, so check them together
// here — this module is evaluated before any db.ts is imported.
const required = ['USER_DATABASE_URL', 'MECHANIC_DATABASE_URL', 'ADMIN_DATABASE_URL'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\n[backend] Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('Set them in the host dashboard, or locally in apps/backend/server/.env\n');
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.warn('[backend] JWT_SECRET is not set — falling back to the insecure dev default.');
}
