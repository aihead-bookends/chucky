// A TCP Postgres adapter with the interface api/_lib/db.mjs describes, for local dev, the dev/
// scripts and the tests. Never deployed (dev/ is in .vercelignore): production uses Neon over HTTP.
import pg from 'pg';

// bigint (int8) comes back as a string by default; a version's `t` is a millisecond timestamp, far
// inside the range a JS number holds exactly, so read it as a number like the Neon path does
pg.types.setTypeParser(20, (v) => Number(v));

export function pgAdapter(url) {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return {
    kind: 'postgres',
    pool,
    query: async (text, params = []) => (await pool.query(text, params)).rows,
    tx: async (stmts) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = [];
        for (const s of stmts) out.push((await client.query(s.text, s.params || [])).rows);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}
