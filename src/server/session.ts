import { cookies } from "next/headers";
import { and, desc, eq } from "drizzle-orm";
import { DatabaseConfigError, db, isDatabaseConfigured, isUndefinedTableError, withDbRetry } from "@/db";
import { ensureSchemaMigrated } from "@/db/auto-migrate";
import { businesses, deviceGrants, devices } from "@/db/schema";
import { sha256 } from "@/lib/crypto";
import { DEVICE_COOKIE } from "./core";

export type GrantSessionResult =
  | {
      status: "ok";
      grant: { businessName: string; deviceName: string; operatorName: string | null; pinLength: number } | null;
    }
  | {
      status: "db_error";
      reason: "DATABASE_URL_MISSING" | "DATABASE_URL_INVALID" | "SCHEMA_NOT_MIGRATED" | "CONNECTION_ERROR";
    };

/** Untuk Server Component: hanya info non-sensitif (nama bisnis/perangkat) agar layar PIN dapat ditampilkan. */
export async function getSessionState(): Promise<GrantSessionResult> {
  if (!isDatabaseConfigured()) {
    return { status: "db_error", reason: "DATABASE_URL_MISSING" };
  }
  try {
    await ensureSchemaMigrated();
    const token = (await cookies()).get(DEVICE_COOKIE)?.value;
    if (!token || token.length > 200) {
      // Verify schema exists even if no cookie yet so first-time visitors see friendly migration screen
      await withDbRetry(() => db.select({ id: businesses.id }).from(businesses).limit(1), 1);
      return { status: "ok", grant: null };
    }
    const rows = await withDbRetry(
      () =>
        db
          .select({
            deviceName: devices.name,
            operatorName: devices.operatorName,
            pinLength: devices.pinLength,
            businessName: businesses.name,
          })
          .from(devices)
          .innerJoin(deviceGrants, and(eq(deviceGrants.deviceId, devices.id), eq(deviceGrants.status, "active")))
          .innerJoin(businesses, eq(businesses.id, deviceGrants.businessId))
          .where(and(eq(devices.tokenHash, sha256(token)), eq(devices.status, "active")))
          .orderBy(desc(deviceGrants.createdAt))
          .limit(1),
      1,
    );
    const row = rows[0];
    if (!row) return { status: "ok", grant: null };
    return {
      status: "ok",
      grant: {
        businessName: row.businessName ?? "Business Flow",
        deviceName: row.deviceName,
        operatorName: row.operatorName,
        pinLength: row.pinLength ?? 6,
      },
    };
  } catch (err) {
    if (err instanceof DatabaseConfigError) return { status: "db_error", reason: err.reason };
    if (isUndefinedTableError(err)) return { status: "db_error", reason: "SCHEMA_NOT_MIGRATED" };
    return { status: "db_error", reason: "CONNECTION_ERROR" };
  }
}

export async function currentGrant() {
  const res = await getSessionState();
  return res.status === "ok" ? res.grant : null;
}
