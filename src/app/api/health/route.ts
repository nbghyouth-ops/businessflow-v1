import { checkDatabaseHealth } from "@/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  const status = await checkDatabaseHealth();
  if (status.ok) {
    return Response.json({ ok: true });
  }
  return Response.json({ ok: false, reason: status.reason }, { status: 503 });
}
