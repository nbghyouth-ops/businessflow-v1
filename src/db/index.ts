import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool, type PoolConfig } from "pg";

export class DatabaseConfigError extends Error {
  constructor(
    public readonly reason: "DATABASE_URL_MISSING" | "DATABASE_URL_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

const globalForDb = globalThis as typeof globalThis & {
  __bfPgPool?: Pool;
  __bfDrizzle?: NodePgDatabase;
};

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

/**
 * Normalizes Neon & standard PostgreSQL connection strings without requiring
 * a second ENV var. Handles `-pooler` hosts, `sslmode=require`, and
 * `channel_binding=require` cleanly without emitting pg sslmode warnings.
 */
export function buildPoolConfig(rawUrl: string): PoolConfig {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new DatabaseConfigError("DATABASE_URL_MISSING", "DATABASE_URL belum diatur.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new DatabaseConfigError("DATABASE_URL_INVALID", "Format DATABASE_URL tidak valid.");
  }

  const host = parsed.hostname.toLowerCase();
  const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();
  const isNeon = host.includes("neon.tech") || host.includes("neon.build");
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";

  // Remove query params that trigger pg deprecation/sslmode warnings when handled via `ssl` option
  if (isNeon || sslMode) {
    parsed.searchParams.delete("sslmode");
    parsed.searchParams.delete("channel_binding");
  }

  const needsSsl = isNeon || (sslMode !== undefined && sslMode !== "disable") || (!isLocal && sslMode !== "disable");

  return {
    connectionString: parsed.toString(),
    max: 5,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 12_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    ssl: needsSsl ? { rejectUnauthorized: true } : false,
  };
}

export function getPool(): Pool {
  if (globalForDb.__bfPgPool) return globalForDb.__bfPgPool;
  const raw = process.env.DATABASE_URL;
  if (!raw?.trim()) {
    throw new DatabaseConfigError("DATABASE_URL_MISSING", "DATABASE_URL belum diatur.");
  }
  const p = new Pool(buildPoolConfig(raw));
  globalForDb.__bfPgPool = p;
  return p;
}

function getDrizzle(): NodePgDatabase {
  if (!globalForDb.__bfDrizzle) {
    globalForDb.__bfDrizzle = drizzle(getPool());
  }
  return globalForDb.__bfDrizzle;
}

export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const p = getPool();
    const val = Reflect.get(p, prop, p);
    return typeof val === "function" ? val.bind(p) : val;
  },
});

export const db: NodePgDatabase = new Proxy({} as NodePgDatabase, {
  get(_target, prop) {
    const d = getDrizzle();
    const val = Reflect.get(d, prop, d);
    return typeof val === "function" ? val.bind(d) : val;
  },
});

const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "57P01", "57P03", "08006", "08001"]);

export function isTransientDbError(err: unknown): boolean {
  const e = ((err as { cause?: unknown })?.cause ?? err) as { code?: string; message?: string };
  if (e?.code && TRANSIENT_CODES.has(e.code)) return true;
  const msg = String(e?.message ?? "");
  return /Connection terminated|timeout expired|ECONNRESET|ETIMEDOUT/i.test(msg);
}

export function isUndefinedTableError(err: unknown): boolean {
  const e = ((err as { cause?: unknown })?.cause ?? err) as { code?: string };
  return e?.code === "42P01";
}

export async function withDbRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isTransientDbError(err)) {
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export type DbHealthStatus =
  | { ok: true }
  | { ok: false; reason: "DATABASE_URL_MISSING" | "DATABASE_URL_INVALID" | "SCHEMA_NOT_MIGRATED" | "CONNECTION_ERROR" };

export async function checkDatabaseHealth(): Promise<DbHealthStatus> {
  if (!isDatabaseConfigured()) {
    return { ok: false, reason: "DATABASE_URL_MISSING" };
  }
  try {
    const { ensureSchemaMigrated } = await import("./auto-migrate");
    await ensureSchemaMigrated();
    await withDbRetry(() => getDrizzle().execute(sql`SELECT 1 FROM businesses LIMIT 1`), 1);
    return { ok: true };
  } catch (err) {
    if (err instanceof DatabaseConfigError) {
      return { ok: false, reason: err.reason };
    }
    if (isUndefinedTableError(err)) {
      return { ok: false, reason: "SCHEMA_NOT_MIGRATED" };
    }
    return { ok: false, reason: "CONNECTION_ERROR" };
  }
}
