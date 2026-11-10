// Database access. Uses a real PostgreSQL server when DATABASE_URL is set;
// otherwise falls back to PGlite, the PostgreSQL engine compiled to WASM and
// persisted to ./data/pgdata, so the app runs with zero setup. Both paths run
// the same SQL (tsvector, GIN, identity columns, ON CONFLICT ...).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let engine = null;

export async function initDb() {
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');

  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    await pool.query(schema);
    const run = (client) => async (text, params = []) => {
      const r = await client.query(text, params);
      return { rows: r.rows, rowCount: r.rowCount };
    };
    engine = {
      kind: 'postgres',
      query: run(pool),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn(run(client));
          await client.query('COMMIT');
          return out;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || path.join(dataDir, 'pgdata');
    fs.mkdirSync(dir, { recursive: true });
    const releaseLock = acquireLock(dir);
    let pglite;
    try {
      pglite = await PGlite.create(dir);
    } catch (err) {
      releaseLock();
      throw new Error(`Could not open the database in ${dir}: ${err.message}`);
    }
    await pglite.exec(schema);
    const run = (h) => async (text, params = []) => {
      const r = await h.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    };
    engine = {
      kind: 'pglite',
      query: run(pglite),
      tx: (fn) => pglite.transaction((t) => fn(run(t))),
      close: async () => { await pglite.close(); releaseLock(); },
    };
  }
  return engine;
}

/**
 * PGlite allows one process per data directory. Record our PID next to it;
 * refuse to start while another live server holds it, and clear the stale
 * postmaster.pid a crashed or force-killed server leaves behind (PGlite will
 * not start while that file exists).
 */
function acquireLock(dir) {
  const lockFile = path.join(dir, '..', 'courtscribe.lock');
  try {
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new Error(
        `Another CourtScribe server (process ${pid}) is already using ${dir}. ` +
        'Stop it first (Ctrl+C in its terminal), or set PGLITE_DIR to use a different database.',
      );
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.rmSync(path.join(dir, 'postmaster.pid'), { force: true });
  fs.writeFileSync(lockFile, String(process.pid));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (Number(fs.readFileSync(lockFile, 'utf8')) === process.pid) fs.rmSync(lockFile, { force: true });
    } catch {}
  };
  process.once('exit', release);
  return release;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export const db = {
  query: (text, params) => engine.query(text, params),
  tx: (fn) => engine.tx(fn),
  get kind() { return engine?.kind; },
  close: () => engine?.close(),
};
