# Threat Model — Business Flow

1. **Identitas & Autentikasi Tanpa Login Akun**: Cookie `bf_device` (`HttpOnly`, `SameSite=Strict`, `Secure` di HTTPS) menyimpan token acak yang hanya hash SHA-256-nya disimpan di DB. Tidak ada email/password/OAuth.
2. **Kunci Layar PIN**: PIN di-hash Argon2id (`@node-rs/argon2`). Token sesi tab (`x-tab-session`) hanya hidup di memori JS modul, tidak pernah di storage. Rate limit SQL atomik (`api_rate_limits`) + lockout eksponensial setelah 5 kali gagal. Catatan: "Ubah PIN tanpa PIN lama" adalah keputusan desain pemilik (lihat `PIN_SECURITY.md`).
3. **Isolasi Tenant (RLS Fail-Closed)**: Semua rute terotorisasi dibungkus `withTenant(ctx, fn)` yang menyetel `app.workspace_id` (transaction-local) dan `SET LOCAL ROLE bf_app` (`NOBYPASSRLS`). Seluruh tabel bertenant memiliki `ENABLE + FORCE ROW LEVEL SECURITY` dan composite FK `(workspace_id, id)`.
4. **Integritas Keuangan**: Uang memakai integer satuan terkecil (`BigInt` di `src/lib/money.ts`). Jurnal dan ledger stok bersifat append-only (`REVOKE UPDATE, DELETE` dari `bf_app` + trigger SQL `001_integrity.sql`).
5. **Lampiran & Ekspor**: Unggahan dibatasi 3 MB, dicek magic bytes (menolak HTML/SVG/eksekutabel), dan diunduh lewat endpoint terotorisasi dengan `Content-Disposition: attachment` dan `X-Content-Type-Options: nosniff`. CSP memblokir skrip/font eksternal.
