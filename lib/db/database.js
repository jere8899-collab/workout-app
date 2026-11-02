// Thin wrapper over a sql.js Database. Identical in the browser and in Node,
// so the tests exercise the exact code the phone runs.
import { MIGRATIONS } from './schema.js';

export class Db {
  constructor(SQL, bytes) {
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.db.run('PRAGMA foreign_keys = ON');
    this.onWrite = null;
    this._depth = 0;
    this.migrate();
  }

  migrate() {
    this.db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at_utc TEXT NOT NULL)`);
    const done = new Set(this.all('SELECT version FROM schema_migrations').map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.run('INSERT INTO schema_migrations VALUES (?,?,?)', [m.version, m.name, new Date().toISOString()]);
      });
    }
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] ?? null;
  }

  run(sql, params = []) {
    this.db.run(sql, params);
    if (this._depth === 0) this.onWrite?.();
  }

  tx(fn) {
    if (this._depth > 0) return fn();
    this._depth++;
    this.db.run('BEGIN');
    try {
      const out = fn();
      this.db.run('COMMIT');
      return out;
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    } finally {
      this._depth--;
      if (this._depth === 0) this.onWrite?.();
    }
  }

  insert(table, row) {
    const cols = Object.keys(row);
    this.run(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map((c) => toSql(row[c])),
    );
  }

  update(table, id, patch) {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    this.run(
      `UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`,
      [...cols.map((c) => toSql(patch[c])), id],
    );
  }

  // sql.js re-opens the database on export, which resets pragmas.
  export() {
    const bytes = this.db.export();
    this.db.run('PRAGMA foreign_keys = ON');
    return bytes;
  }
}

function toSql(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
