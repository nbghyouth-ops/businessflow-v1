import { BUNDLED_MIGRATIONS } from "./migrations-bundle";
import { getPool, isDatabaseConfigured } from "./index";

const globalForMig = globalThis as typeof globalThis & {
  __bfSchemaReady?: boolean;
  __bfSchemaPromise?: Promise<void> | null;
};

/**
 * Menjalankan migrasi skema + integritas + RLS secara otomatis, idempoten, dan aman
 * terhadap konkurensi (memakai pg_advisory_xact_lock di dalam transaksi, kompatibel
 * dengan Neon PgBouncer mode transaksi).
 */
export async function ensureSchemaMigrated(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  if (globalForMig.__bfSchemaReady) return;
  if (globalForMig.__bfSchemaPromise) {
    await globalForMig.__bfSchemaPromise;
    return;
  }

  const run = async () => {
    const pool = getPool();

    // Fast-path: pastikan tabel inti DAN tabel baru (api_rate_limits) ada & checksum cocok
    try {
      const [migRes, checkRes] = await Promise.all([
        pool.query<{ id: string; checksum: string }>("SELECT id, checksum FROM schema_migrations"),
        pool.query<{ has_rate: string | null; has_exp: string | null; has_prd: string | null }>(
          "SELECT to_regclass('public.api_rate_limits')::text AS has_rate, to_regclass('public.export_records')::text AS has_exp, to_regclass('public.cashier_shifts')::text AS has_prd",
        ),
      ]);
      const applied = new Map(migRes.rows.map((r) => [r.id, r.checksum]));
      const allPresent = BUNDLED_MIGRATIONS.every((m) => applied.get(m.id) === m.checksum);
      if (allPresent && checkRes.rows[0]?.has_rate && checkRes.rows[0]?.has_exp && checkRes.rows[0]?.has_prd) {
        globalForMig.__bfSchemaReady = true;
        return;
      }
    } catch {
      // Lanjut ke transaksi migrasi
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(88442211)");

      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      for (const m of BUNDLED_MIGRATIONS) {
        // Karena semua migrasi sekarang 100% idempoten (IF NOT EXISTS / DO $$),
        // jalankan jika belum tercatat dengan checksum terbaru.
        const existing = await client.query<{ checksum: string }>(
          "SELECT checksum FROM schema_migrations WHERE id = $1",
          [m.id],
        );
        if (existing.rows[0]?.checksum === m.checksum) {
          // Khusus 003: pastikan api_rate_limits benar-benar ada
          if (m.id === "003_features_and_exports") {
            const chk = await client.query<{ r: string | null }>("SELECT to_regclass('public.api_rate_limits')::text AS r");
            if (chk.rows[0]?.r) continue;
          } else {
            continue;
          }
        }

        if (m.id === "0000_baseline") {
          const baseChk = await client.query<{ r: string | null }>("SELECT to_regclass('public.accounting_periods')::text AS r");
          if (baseChk.rows[0]?.r) {
            await client.query(
              `INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)
               ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
              [m.id, m.checksum],
            );
            continue;
          }
        }
        await client.query(m.sql);
        await client.query(
          `INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
          [m.id, m.checksum],
        );
      }

      await client.query("COMMIT");
      globalForMig.__bfSchemaReady = true;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };

  globalForMig.__bfSchemaPromise = run().finally(() => {
    globalForMig.__bfSchemaPromise = null;
  });

  await globalForMig.__bfSchemaPromise;
}
