import { DatabaseSync, type StatementSync } from "node:sqlite";

export type SqlValue = string | number | null | bigint | Uint8Array;

/**
 * The only storage surface WorkspaceHub uses. It is deliberately tiny and synchronous so the same hub
 * code can sit on a Durable Object's `ctx.storage.sql` later (see ARCHITECTURE.md section 15).
 */
export interface SqlStore {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  all<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T[];
  get<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T | undefined;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export class NodeSqlStore implements SqlStore {
  private db: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]) {
    const r = this.stmt(sql).run(...(params as any[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...(params as any[])) as T[];
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...(params as any[])) as T | undefined;
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn(); // nested calls join the outer transaction
    this.depth++;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }
}
