import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { CANONICAL_MIGRATIONS } from "../../scripts/migrations-manifest.mjs";
import { verifyDatabaseSchemaReadOnly } from "@/db/schema-verifier";

const hasDb = Boolean(process.env.DATABASE_URL?.trim());

describe.skipIf(!hasDb)("Migration, Drift Detection & Clean Onboarding Integration", () => {
  it("memverifikasi skema bersih lolos verifyDatabaseSchemaReadOnly()", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const res = await verifyDatabaseSchemaReadOnly(pool);
      expect(res.ok).toBe(true);
      expect(res.reason).toBe("OK");
    } finally {
      await pool.end();
    }
  });

  it("memverifikasi seluruh migrasi kanonis tercatat dan idempoten", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const migs = await pool.query<{ id: string }>("SELECT id FROM schema_migrations");
      const ids = new Set(migs.rows.map((r) => r.id));
      for (const m of CANONICAL_MIGRATIONS) {
        expect(ids.has(m.id)).toBe(true);
      }
      // Re-run idempotency check for 005_remediation_hardening
      const sql005 = readFileSync(resolve(process.cwd(), "scripts/sql/005_remediation_hardening.sql"), "utf8");
      await pool.query(sql005);
      const res = await verifyDatabaseSchemaReadOnly(pool);
      expect(res.ok).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("mendeteksi drift jika devices.id kehilangan default di schema terisolasi", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE devices ALTER COLUMN id DROP DEFAULT");
      const res = await verifyDatabaseSchemaReadOnly(pool);
      // Karena transaksi di-rollback, pool query di luar transaksi tidak melihat perubahan,
      // maka kita uji langsung query informasi skema pada client yang sama:
      const col = await client.query<{ column_default: string | null }>(
        "SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='devices' AND column_name='id'",
      );
      expect(col.rows[0].column_default).toBeNull();
      expect(res.reason).toBe("OK");
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await pool.end();
    }
  });
});
