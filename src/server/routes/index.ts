import { checkDatabaseHealth } from "@/db";
import { r, type Route } from "../core";
import { deviceRoutes } from "./device";
import { financeRoutes } from "./finance";
import { salesRoutes } from "./sales";
import { resourceRoutes } from "./resources";
import { miscRoutes } from "./misc";
import { exportRoutes } from "./exports";
import { fileRoutes } from "./files";
import { p2Routes } from "./p2";
import { prdRoutes } from "./prd";

export const routes: Route[] = [
  r("GET", "/health", { auth: "none" }, async () => {
    const status = await checkDatabaseHealth();
    if (!status.ok) {
      return Response.json({ ok: false, reason: status.reason }, { status: 503 });
    }
    return { ok: true };
  }),
  ...deviceRoutes,
  ...financeRoutes,
  ...salesRoutes,
  ...resourceRoutes,
  ...miscRoutes,
  ...exportRoutes,
  ...fileRoutes,
  ...p2Routes,
  ...prdRoutes,
];
