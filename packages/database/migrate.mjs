import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = new URL('./migrations/', import.meta.url);

/** Immutable migrations: a changed applied migration fails instead of silently changing history. */
export async function migrate(pool) {
  const client = pool.connect ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA IF NOT EXISTS fagoo');
    await client.query('CREATE TABLE IF NOT EXISTS fagoo.schema_migration(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('LOCK TABLE fagoo.schema_migration IN EXCLUSIVE MODE');
    for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const old = (await client.query('SELECT sha256 FROM fagoo.schema_migration WHERE name=$1', [name])).rows[0];
      if (old) { if (old.sha256 !== hash) throw new Error(`Migration checksum mismatch: ${name}`); continue; }
      // pg and PGlite accept a multi-statement migration without parameters.
      if (client.exec) await client.exec(sql); else await client.query(sql);
      await client.query('INSERT INTO fagoo.schema_migration(name,sha256) VALUES($1,$2)', [name, hash]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release?.(); }
}
