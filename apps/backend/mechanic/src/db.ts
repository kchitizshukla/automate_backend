// PostgreSQL access layer for the MECHANIC module (database: am_mech).
//
// The rest of this module keeps the familiar `db.prepare(sql).get/all/run(...)`
// shape, except every call now returns a promise. Two conveniences make the
// SQL itself portable:
//   * `?` placeholders are rewritten to `$1..$n` (quoted literals are skipped)
//   * `run()` on an INSERT appends `RETURNING id`, so `lastInsertRowid` works
import pg from 'pg';

const { Pool, types } = pg;

// NUMERIC and COUNT(*) arrive as strings by default; the API contract (and the
// frontend's number formatting) expects real numbers.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

const connectionString = process.env.MECHANIC_DATABASE_URL;
if (!connectionString) {
  console.error('\n[mechanic-backend] MECHANIC_DATABASE_URL is not set.');
  console.error('Add it to apps/backend/mechanic/.env, e.g.');
  console.error('  MECHANIC_DATABASE_URL=postgresql://postgres:password@localhost:5432/am_mech\n');
  process.exit(1);
}

// Managed Postgres (Render, Neon, Supabase) requires TLS, and from the client's
// point of view their certificates are typically self-signed. A local server
// usually has TLS off entirely. Default by host, and allow an explicit override
// via PGSSLMODE=disable|require for anything unusual.
function sslConfig(url: string): false | { rejectUnauthorized: boolean } {
  const mode = process.env.PGSSLMODE;
  if (mode === 'disable') return false;
  if (mode) return { rejectUnauthorized: false };
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  return isLocal ? false : { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString,
  ssl: sslConfig(connectionString),
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => console.error('[mechanic-backend] idle client error:', err.message));

/** Rewrites `?` placeholders to `$1..$n`, leaving anything inside quotes alone. */
function toPgPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let quote: string | null = null;
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '?') {
      out += `$${++n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

const isInsert = (sql: string) => /^\s*insert\b/i.test(sql);
const hasReturning = (sql: string) => /\breturning\b/i.test(sql);

export interface RunResult {
  changes: number;
  lastInsertRowid: number | null;
}

class Statement {
  private readonly text: string;

  constructor(sql: string) {
    this.text = toPgPlaceholders(sql);
  }

  async all<T = any>(...params: any[]): Promise<T[]> {
    const { rows } = await pool.query(this.text, params);
    return rows as T[];
  }

  async get<T = any>(...params: any[]): Promise<T | undefined> {
    const { rows } = await pool.query(this.text, params);
    return rows[0] as T | undefined;
  }

  async run(...params: any[]): Promise<RunResult> {
    const text =
      isInsert(this.text) && !hasReturning(this.text) ? `${this.text} RETURNING id` : this.text;
    const result = await pool.query(text, params);
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: result.rows[0]?.id ?? null,
    };
  }
}

export const db = {
  prepare: (sql: string) => new Statement(sql),
  /** Escape hatch for multi-statement or dynamic SQL. */
  query: (sql: string, params: any[] = []) => pool.query(toPgPlaceholders(sql), params),
};

/** Fails fast at boot rather than on the first request. */
export async function assertDbReady(): Promise<void> {
  const { rows } = await pool.query('SELECT current_database() AS db, COUNT(*)::int AS mechanics FROM mechanics');
  console.log(`[mechanic-backend] connected to ${rows[0].db} (${rows[0].mechanics} mechanics)`);
}
