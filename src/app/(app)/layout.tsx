import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { DbStatusScreen } from "@/components/db-status-screen";
import { LockProvider } from "@/components/lock-provider";
import { Shell } from "@/components/shell";
import { getSessionState } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSessionState();
  if (session.status === "db_error") {
    return <DbStatusScreen reason={session.reason} />;
  }
  if (!session.grant) redirect("/");
  return (
    <LockProvider init={session.grant}>
      <Shell>{children}</Shell>
    </LockProvider>
  );
}
