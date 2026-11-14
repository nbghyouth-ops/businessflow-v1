import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CANONICAL_MIGRATIONS } from "./migrations-manifest.mjs";

const chunks = [
  "-- Business Flow — ALL_IN_ONE.sql",
  "-- Dihasilkan otomatis oleh scripts/bundle-sql.mjs. Aman ditempel di Neon SQL Editor.",
  "",
  "CREATE TABLE IF NOT EXISTS schema_migrations (",
  "  id TEXT PRIMARY KEY,",
  "  checksum TEXT NOT NULL,",
  "  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()",
  ");",
  "",
];

for (const m of CANONICAL_MIGRATIONS) {
  const abs = resolve(process.cwd(), m.path);
  if (!existsSync(abs)) continue;
  const sql = readFileSync(abs, "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  chunks.push(`-- === BEGIN ${m.id} (${m.path}) ===`);
  chunks.push(sql.trim());
  chunks.push(
    `INSERT INTO schema_migrations (id, checksum) VALUES ('${m.id}', '${checksum}') ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum;`,
  );
  if (m.legacyId && m.legacyId !== m.id) {
    chunks.push(
      `INSERT INTO schema_migrations (id, checksum) VALUES ('${m.legacyId}', '${checksum}') ON CONFLICT (id) DO NOTHING;`,
    );
  }
  chunks.push(`-- === END ${m.id} ===`);
  chunks.push("");
}

const outPath = resolve(process.cwd(), "drizzle/ALL_IN_ONE.sql");
writeFileSync(outPath, chunks.join("\n"), "utf8");
console.log(`Berhasil membuat ${outPath}`);
