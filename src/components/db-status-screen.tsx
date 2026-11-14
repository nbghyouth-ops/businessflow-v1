import Link from "next/link";
import { Logo } from "./ui";

export function DbStatusScreen({
  reason,
}: {
  reason: "DATABASE_URL_MISSING" | "DATABASE_URL_INVALID" | "SCHEMA_NOT_MIGRATED" | "CONNECTION_ERROR";
}) {
  const isMissing = reason === "DATABASE_URL_MISSING" || reason === "DATABASE_URL_INVALID";
  const isSchema = reason === "SCHEMA_NOT_MIGRATED";

  const title = isMissing
    ? "Database belum terhubung"
    : isSchema
      ? "Skema database belum dimigrasi"
      : "Koneksi database sedang bermasalah";

  const description = isMissing
    ? "Aplikasi membutuhkan satu variabel lingkungan DATABASE_URL (connection string Neon PostgreSQL) sebelum dapat digunakan."
    : isSchema
      ? "Database sudah terhubung, tetapi tabel Business Flow belum dibuat. Jalankan migrasi sekali saja untuk menyiapkan skema."
      : "Server tidak dapat menjangkau Neon PostgreSQL saat ini. Periksa status project Neon atau coba muat ulang beberapa saat lagi.";

  return (
    <main className="grid min-h-screen place-items-center bg-surface px-4 py-10">
      <div className="w-full max-w-xl rounded-[24px] border border-line bg-white p-8 shadow-pop sm:p-10">
        <Logo size={40} />
        <span className="mt-6 inline-block rounded-full bg-[#FFF5EB] px-3 py-1 text-xs font-semibold text-[#9A420C]">
          Status: {reason}
        </span>
        <h1 className="mt-3 text-2xl font-bold text-ink">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">{description}</p>

        <div className="mt-6 rounded-2xl border border-line bg-surface p-4 text-sm text-ink">
          <p className="font-semibold">Langkah cepat:</p>
          {isMissing ? (
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-ink-2">
              <li>Buat project Neon PostgreSQL (region Singapura <code>aws-ap-southeast-1</code>) dan salin connection string <strong>pooled</strong>.</li>
              <li>Isi <code>DATABASE_URL</code> di file <code>.env</code> lokal atau di Environment Variables Vercel.</li>
              <li>Jalankan <code>npm run db:migrate</code> atau tempel isi <code>drizzle/ALL_IN_ONE.sql</code> di Neon SQL Editor.</li>
            </ol>
          ) : isSchema ? (
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-ink-2">
              <li>Jalankan <code>npm run db:migrate</code> di terminal dengan <code>DATABASE_URL</code> terpasang, atau</li>
              <li>Buka Neon SQL Editor dan jalankan seluruh isi file <code>drizzle/ALL_IN_ONE.sql</code>.</li>
              <li>Verifikasi dengan <code>npm run db:check</code>, lalu muat ulang halaman ini.</li>
            </ol>
          ) : (
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-ink-2">
              <li>Pastikan project Neon aktif (tidak dihapus atau terblokir kuota).</li>
              <li>Periksa apakah <code>DATABASE_URL</code> memakai endpoint <code>-pooler</code> yang valid.</li>
              <li>Muat ulang halaman ini setelah koneksi pulih.</li>
            </ol>
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-primary-deep px-5 text-sm font-semibold text-white hover:bg-primary-dark"
          >
            Muat ulang
          </Link>
          <Link
            href="/guide"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-line bg-white px-5 text-sm font-semibold text-ink hover:bg-primary-bg"
          >
            Lihat Panduan Penggunaan
          </Link>
        </div>
      </div>
    </main>
  );
}
