import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const targetDir = join(process.cwd(), "node_modules", "drizzle-orm");
if (!existsSync(targetDir)) {
  console.log("[fix-drizzle-types] node_modules/drizzle-orm tidak ditemukan, lewati.");
  process.exit(0);
}

let count = 0;
function walk(dir) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else if (entry.endsWith(".d.cts")) {
      const dts = full.slice(0, -6) + ".d.ts";
      copyFileSync(full, dts);
      count++;
    }
  }
}

walk(targetDir);
console.log(`[fix-drizzle-types] Berhasil menyalin ${count} file .d.cts ke .d.ts di drizzle-orm.`);
