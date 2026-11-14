import { sql } from "drizzle-orm";
import { z } from "zod";
import { toCents } from "@/lib/money";
import { audit, HttpError, nextNumber, r, type Route } from "../core";

const uuid = z.string().uuid();

export const prdRoutes: Route[] = [
  /* ───────── 1. Cashier Shift & Table Management (POS-01..07) ───────── */
  r("GET", "/prd/shifts", { perm: "sales:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, operator, opening_cash::text AS "openingCash", cash_in::text AS "cashIn",
             cash_out::text AS "cashOut", cash_sales::text AS "cashSales", cash_refunds::text AS "cashRefunds",
             expected_cash::text AS "expectedCash", counted_cash::text AS "countedCash",
             variance::text, status, note, opened_at AS "openedAt", closed_at AS "closedAt"
      FROM cashier_shifts WHERE workspace_id = ${ctx.workspaceId} ORDER BY opened_at DESC LIMIT 50
    `);
    return { items: res.rows };
  }),

  r("POST", "/prd/shifts/open", { perm: "sales:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        openingCash: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        note: z.string().max(300).optional(),
      }),
    );
    const openExisting = await tx.execute(sql`
      SELECT id FROM cashier_shifts WHERE workspace_id = ${ctx.workspaceId} AND status = 'open' LIMIT 1
    `);
    if (openExisting.rows.length > 0) throw new HttpError(409, "Masih ada shift kasir yang terbuka. Tutup shift aktif terlebih dahulu.");
    const openCents = toCents(b.openingCash);
    const ins = await tx.execute(sql`
      INSERT INTO cashier_shifts (workspace_id, branch_id, device_id, operator, opening_cash, expected_cash, note)
      VALUES (${ctx.workspaceId}, ${ctx.branchId}, ${ctx.deviceId}, ${ctx.operator ?? ctx.deviceName}, ${openCents.toString()}, ${openCents.toString()}, ${b.note ?? null})
      RETURNING id, status, opening_cash::text AS "openingCash"
    `);
    await audit(tx, ctx, "pos.shift_open", "cashier_shift", String((ins.rows[0] as { id: string }).id));
    return ins.rows[0];
  }),

  r("POST", "/prd/shifts/:id/close", { perm: "sales:write" }, async ({ ctx, tx, params, json }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "Shift tidak ditemukan.");
    const b = await json(
      z.object({
        countedCash: z.string().regex(/^\d+(\.\d{1,2})?$/),
        cashIn: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        cashOut: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        note: z.string().max(300).optional(),
      }),
    );
    const cur = await tx.execute(sql`
      SELECT id, opening_cash::text AS "openingCash", cash_sales::text AS "cashSales", cash_refunds::text AS "cashRefunds", status
      FROM cashier_shifts WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId} LIMIT 1
    `);
    const row = cur.rows[0] as { openingCash: string; cashSales: string; cashRefunds: string; status: string } | undefined;
    if (!row) throw new HttpError(404, "Shift tidak ditemukan.");
    if (row.status === "closed") throw new HttpError(409, "Shift sudah ditutup.");

    const cashInCents = toCents(b.cashIn);
    const cashOutCents = toCents(b.cashOut);
    const countedCents = toCents(b.countedCash);
    const expectedCents =
      BigInt(row.openingCash) + BigInt(row.cashSales) + cashInCents - BigInt(row.cashRefunds) - cashOutCents;
    const varianceCents = countedCents - expectedCents;

    const up = await tx.execute(sql`
      UPDATE cashier_shifts
      SET cash_in = ${cashInCents.toString()}, cash_out = ${cashOutCents.toString()},
          expected_cash = ${expectedCents.toString()}, counted_cash = ${countedCents.toString()},
          variance = ${varianceCents.toString()}, status = 'closed',
          note = COALESCE(${b.note ?? null}, note), closed_at = now()
      WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId}
      RETURNING id, expected_cash::text AS "expectedCash", counted_cash::text AS "countedCash", variance::text, status
    `);
    await audit(tx, ctx, "pos.shift_close", "cashier_shift", params.id, { variance: varianceCents.toString() });
    return up.rows[0];
  }),

  r("GET", "/prd/tables", { perm: "sales:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, code, name, capacity, status, active_note AS "activeNote", updated_at AS "updatedAt"
      FROM pos_tables WHERE workspace_id = ${ctx.workspaceId} ORDER BY code ASC
    `);
    return { items: res.rows };
  }),

  r("POST", "/prd/tables", { perm: "sales:write" }, async ({ ctx, tx, json }) => {
    const b = await json(z.object({ code: z.string().min(1).max(20), name: z.string().min(1).max(60), capacity: z.coerce.number().int().min(1).max(100).default(4) }));
    const ins = await tx.execute(sql`
      INSERT INTO pos_tables (workspace_id, branch_id, code, name, capacity)
      VALUES (${ctx.workspaceId}, ${ctx.branchId}, ${b.code}, ${b.name}, ${b.capacity})
      RETURNING id, code, name, capacity, status
    `);
    return ins.rows[0];
  }),

  r("PATCH", "/prd/tables/:id", { perm: "sales:write" }, async ({ ctx, tx, params, json }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "Meja tidak ditemukan.");
    const b = await json(z.object({ status: z.enum(["available", "occupied", "reserved"]), activeNote: z.string().max(120).optional() }));
    const up = await tx.execute(sql`
      UPDATE pos_tables SET status = ${b.status}, active_note = ${b.activeNote ?? null}, updated_at = now()
      WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId}
      RETURNING id, status, active_note AS "activeNote"
    `);
    if (!up.rows.length) throw new HttpError(404, "Meja tidak ditemukan.");
    return up.rows[0];
  }),

  /* ───────── 2. Product Batches, Serial, Expiry & Waste (INV-11..15) ───────── */
  r("GET", "/prd/batches", { perm: "inventory:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, product_id AS "productId", warehouse_id AS "warehouseId", batch_no AS "batchNo",
             serial_no AS "serialNo", qty_milli::text AS "qtyMilli", expiry_date::text AS "expiryDate",
             cost_cents::text AS "costCents", status, created_at AS "createdAt"
      FROM product_batches WHERE workspace_id = ${ctx.workspaceId} ORDER BY expiry_date ASC NULLS LAST, created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/prd/batches", { perm: "inventory:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        productId: uuid,
        warehouseId: uuid.optional(),
        batchNo: z.string().min(1).max(60),
        serialNo: z.string().max(80).optional(),
        qty: z.coerce.number().min(0),
        expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        cost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
      }),
    );
    const ins = await tx.execute(sql`
      INSERT INTO product_batches (workspace_id, product_id, warehouse_id, batch_no, serial_no, qty_milli, expiry_date, cost_cents)
      VALUES (${ctx.workspaceId}, ${b.productId}, ${b.warehouseId ?? null}, ${b.batchNo}, ${b.serialNo ?? null},
              ${Math.round(b.qty * 1000)}, ${b.expiryDate ? sql`${b.expiryDate}::date` : sql`NULL`}, ${toCents(b.cost).toString()})
      RETURNING id, batch_no AS "batchNo", status
    `);
    return ins.rows[0];
  }),

  r("GET", "/prd/waste", { perm: "inventory:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, product_id AS "productId", warehouse_id AS "warehouseId", qty_milli::text AS "qtyMilli",
             reason, cost_cents::text AS "costCents", operator, created_at AS "createdAt"
      FROM stock_waste WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/prd/waste", { perm: "inventory:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        productId: uuid,
        warehouseId: uuid.optional(),
        qty: z.coerce.number().positive(),
        reason: z.string().min(1).max(200),
        cost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
      }),
    );

    // Verifikasi produk dalam workspace
    const prodRes = await tx.execute(sql`
      SELECT id, name, cost_price AS "costPrice" FROM products
      WHERE id = ${b.productId} AND workspace_id = ${ctx.workspaceId} LIMIT 1
    `);
    if (!prodRes.rows.length) throw new HttpError(404, "Produk tidak ditemukan.");

    // Dapatkan target gudang
    let whId = b.warehouseId;
    if (!whId) {
      const whRes = await tx.execute(sql`
        SELECT id FROM warehouses WHERE workspace_id = ${ctx.workspaceId} ORDER BY is_default DESC, created_at ASC LIMIT 1
      `);
      whId = (whRes.rows[0] as { id: string } | undefined)?.id;
    }
    if (!whId) throw new HttpError(422, "Gudang belum dikonfigurasi di workspace ini.");

    // Cek ketersediaan stok
    const stockRes = await tx.execute(sql`
      SELECT COALESCE(SUM(quantity), 0)::numeric AS current_stock
      FROM stock_movements
      WHERE workspace_id = ${ctx.workspaceId} AND warehouse_id = ${whId} AND product_id = ${b.productId}
    `);
    const currentStock = Number((stockRes.rows[0] as { current_stock: string })?.current_stock ?? 0);
    if (currentStock < b.qty) {
      throw new HttpError(422, `Stok gudang tidak mencukupi untuk dicatat sebagai waste (tersedia: ${currentStock}, diminta: ${b.qty}).`);
    }

    const costCents = toCents(b.cost);
    const ins = await tx.execute(sql`
      INSERT INTO stock_waste (workspace_id, product_id, warehouse_id, qty_milli, reason, cost_cents, operator)
      VALUES (${ctx.workspaceId}, ${b.productId}, ${whId}, ${Math.round(b.qty * 1000)}, ${b.reason}, ${costCents.toString()}, ${ctx.operator ?? ctx.deviceName})
      RETURNING id
    `);
    const wasteId = String((ins.rows[0] as { id: string }).id);

    // Kurangi stok di stock_movements
    await tx.execute(sql`
      INSERT INTO stock_movements (
        workspace_id, business_id, warehouse_id, product_id, quantity, unit_cost, kind, ref_type, ref_id, note, device_id
      ) VALUES (
        ${ctx.workspaceId}, ${ctx.businessId}, ${whId}, ${b.productId},
        ${(-b.qty).toFixed(3)}::numeric, ${b.cost}::numeric, 'waste', 'stock_waste', ${wasteId}::uuid,
        ${'Waste/Kerusakan: ' + b.reason}, ${ctx.deviceId}
      )
    `);

    await audit(tx, ctx, "stock.waste", "stock_waste", wasteId, { reason: b.reason, qty: b.qty });
    return ins.rows[0];
  }),

  /* ───────── 3. Recipe, BOM & Work Orders (PRD-01..17) ───────── */
  r("GET", "/prd/recipes", { perm: "inventory:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, product_id AS "productId", version, name, yield_qty::text AS "yieldQty", yield_unit AS "yieldUnit",
             ingredients, is_active AS "isActive", created_at AS "createdAt"
      FROM recipes WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/prd/recipes", { perm: "inventory:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        productId: uuid.optional(),
        name: z.string().min(1).max(120),
        yieldQty: z.coerce.number().positive().default(1),
        yieldUnit: z.string().min(1).max(20).default("pcs"),
        ingredients: z.array(z.object({
          name: z.string().min(1),
          qty: z.coerce.number().positive(),
          unit: z.string().default("gr"),
          productId: uuid.optional(),
        })).min(1),
      }),
    );
    const ins = await tx.execute(sql`
      INSERT INTO recipes (workspace_id, product_id, name, yield_qty, yield_unit, ingredients)
      VALUES (${ctx.workspaceId}, ${b.productId ?? null}, ${b.name}, ${String(b.yieldQty)}::numeric, ${b.yieldUnit}, ${JSON.stringify(b.ingredients)}::jsonb)
      RETURNING id, name, version
    `);
    return ins.rows[0];
  }),

  r("GET", "/prd/work-orders", { perm: "inventory:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, number, recipe_id AS "recipeId", product_id AS "productId", planned_qty::text AS "plannedQty", actual_qty::text AS "actualQty",
             waste_qty::text AS "wasteQty", labor_cost_cents::text AS "laborCostCents",
             overhead_cost_cents::text AS "overheadCostCents", total_cost_cents::text AS "totalCostCents",
             status, created_at AS "createdAt", completed_at AS "completedAt"
      FROM work_orders WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/prd/work-orders", { perm: "inventory:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        recipeId: uuid.optional(),
        productId: uuid.optional(),
        warehouseId: uuid.optional(),
        plannedQty: z.coerce.number().positive(),
        laborCost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        overheadCost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
      }),
    );
    const number = await nextNumber(tx, ctx.workspaceId, "work_order", "WO");
    const laborCents = toCents(b.laborCost);
    const overCents = toCents(b.overheadCost);
    const ins = await tx.execute(sql`
      INSERT INTO work_orders (workspace_id, number, recipe_id, product_id, planned_qty, labor_cost_cents, overhead_cost_cents, total_cost_cents)
      VALUES (${ctx.workspaceId}, ${number}, ${b.recipeId ?? null}, ${b.productId ?? null}, ${String(b.plannedQty)}::numeric,
              ${laborCents.toString()}, ${overCents.toString()}, ${(laborCents + overCents).toString()})
      RETURNING id, number, status
    `);
    return ins.rows[0];
  }),

  r("POST", "/prd/work-orders/:id/complete", { perm: "inventory:write" }, async ({ ctx, tx, params, json }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "Work Order tidak ditemukan.");
    const b = await json(z.object({
      actualQty: z.coerce.number().min(0),
      wasteQty: z.coerce.number().min(0).default(0),
      warehouseId: uuid.optional(),
    }));

    const woRes = await tx.execute(sql`
      SELECT wo.id, wo.number, wo.recipe_id AS "recipeId", wo.product_id AS "productId",
             r.product_id AS "recipeProductId", r.ingredients, r.yield_qty AS "yieldQty"
      FROM work_orders wo
      LEFT JOIN recipes r ON r.id = wo.recipe_id
      WHERE wo.id = ${params.id} AND wo.workspace_id = ${ctx.workspaceId} AND wo.status <> 'completed'
      FOR UPDATE
    `);
    const wo = woRes.rows[0] as {
      id: string;
      number: string;
      recipeId: string | null;
      productId: string | null;
      recipeProductId: string | null;
      ingredients: Array<{ name: string; qty: number; unit?: string; productId?: string }> | null;
      yieldQty: string | number | null;
    } | undefined;
    if (!wo) throw new HttpError(409, "Work Order tidak ditemukan atau sudah selesai.");

    // Dapatkan target gudang
    let whId = b.warehouseId;
    if (!whId) {
      const whRes = await tx.execute(sql`
        SELECT id FROM warehouses WHERE workspace_id = ${ctx.workspaceId} ORDER BY is_default DESC, created_at ASC LIMIT 1
      `);
      whId = (whRes.rows[0] as { id: string } | undefined)?.id;
    }

    if (whId) {
      // 1. Konsumsi bahan baku jika ada
      const ingredients = Array.isArray(wo.ingredients) ? wo.ingredients : [];
      const yieldQtyNum = Math.max(1, Number(wo.yieldQty ?? 1));
      const totalUnits = b.actualQty + b.wasteQty;
      const factor = totalUnits / yieldQtyNum;

      for (const ing of ingredients) {
        if (ing.productId) {
          const consumeQty = Number(ing.qty) * factor;
          await tx.execute(sql`
            INSERT INTO stock_movements (
              workspace_id, business_id, warehouse_id, product_id, quantity, unit_cost, kind, ref_type, ref_id, note, device_id
            ) VALUES (
              ${ctx.workspaceId}, ${ctx.businessId}, ${whId}, ${ing.productId},
              ${(-consumeQty).toFixed(3)}::numeric, '0'::numeric, 'production_consume', 'work_order', ${wo.id}::uuid,
              ${'Konsumsi produksi ' + wo.number + ': ' + ing.name}, ${ctx.deviceId}
            )
          `);
        }
      }

      // 2. Output barang jadi jika ada productId
      const finishedProdId = wo.productId || wo.recipeProductId;
      if (finishedProdId && b.actualQty > 0) {
        await tx.execute(sql`
          INSERT INTO stock_movements (
            workspace_id, business_id, warehouse_id, product_id, quantity, unit_cost, kind, ref_type, ref_id, note, device_id
          ) VALUES (
            ${ctx.workspaceId}, ${ctx.businessId}, ${whId}, ${finishedProdId},
            ${b.actualQty.toFixed(3)}::numeric, '0'::numeric, 'production_output', 'work_order', ${wo.id}::uuid,
            ${'Hasil produksi ' + wo.number}, ${ctx.deviceId}
          )
        `);
      }
    }

    const up = await tx.execute(sql`
      UPDATE work_orders
      SET actual_qty = ${String(b.actualQty)}::numeric, waste_qty = ${String(b.wasteQty)}::numeric,
          status = 'completed', completed_at = now()
      WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId}
      RETURNING id, number, status
    `);
    await audit(tx, ctx, "production.complete", "work_order", params.id, { actualQty: b.actualQty, wasteQty: b.wasteQty });
    return up.rows[0];
  }),

  /* ───────── 4. Fixed Assets & Depreciation (AST-01..19) ───────── */
  r("GET", "/prd/assets", { perm: "assets:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, code, name, category, location, responsible, acquisition_date::text AS "acquisitionDate",
             acquisition_cost_cents::text AS "acquisitionCostCents", residual_value_cents::text AS "residualValueCents",
             useful_life_months AS "usefulLifeMonths", method,
             accumulated_dep_cents::text AS "accumulatedDepCents", book_value_cents::text AS "bookValueCents", status
      FROM fixed_assets WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/prd/assets", { perm: "assets:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        name: z.string().min(1).max(120),
        category: z.string().min(1).max(60).default("Peralatan"),
        location: z.string().max(100).optional(),
        responsible: z.string().max(80).optional(),
        acquisitionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        acquisitionCost: z.string().regex(/^\d+(\.\d{1,2})?$/),
        residualValue: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        usefulLifeMonths: z.coerce.number().int().min(1).max(600).default(36),
        method: z.enum(["straight_line", "declining_balance"]).default("straight_line"),
      }),
    );
    const acq = toCents(b.acquisitionCost);
    const resVal = toCents(b.residualValue);
    if (resVal > acq) throw new HttpError(422, "Nilai residu tidak boleh melebihi nilai perolehan.");
    const code = await nextNumber(tx, ctx.workspaceId, "fixed_asset", "AST");
    const ins = await tx.execute(sql`
      INSERT INTO fixed_assets (workspace_id, branch_id, code, name, category, location, responsible, acquisition_date,
        acquisition_cost_cents, residual_value_cents, useful_life_months, method, book_value_cents)
      VALUES (${ctx.workspaceId}, ${ctx.branchId}, ${code}, ${b.name}, ${b.category}, ${b.location ?? null}, ${b.responsible ?? null},
              ${b.acquisitionDate}::date, ${acq.toString()}, ${resVal.toString()}, ${b.usefulLifeMonths}, ${b.method}, ${acq.toString()})
      RETURNING id, code, status
    `);
    return ins.rows[0];
  }),

  r("POST", "/prd/assets/:id/depreciate", { perm: "assets:write" }, async ({ ctx, tx, params, json }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "Aset tidak ditemukan.");
    const b = await json(z.object({ periodMonth: z.string().regex(/^\d{4}-\d{2}$/) }));
    const cur = await tx.execute(sql`
      SELECT id, acquisition_cost_cents::text AS acq, residual_value_cents::text AS res,
             useful_life_months AS life, method, accumulated_dep_cents::text AS acc, book_value_cents::text AS bv
      FROM fixed_assets WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId} LIMIT 1
    `);
    const a = cur.rows[0] as { acq: string; res: string; life: number; method: string; acc: string; bv: string } | undefined;
    if (!a) throw new HttpError(404, "Aset tidak ditemukan.");

    const dup = await tx.execute(sql`
      SELECT id FROM asset_depreciation_logs WHERE asset_id = ${params.id} AND period_month = ${b.periodMonth} AND workspace_id = ${ctx.workspaceId} LIMIT 1
    `);
    if (dup.rows.length > 0) throw new HttpError(409, `Penyusutan periode ${b.periodMonth} sudah diposting.`);

    const bv = BigInt(a.bv);
    const resVal = BigInt(a.res);
    if (bv <= resVal) throw new HttpError(422, "Nilai buku sudah mencapai nilai residu.");

    const acq = BigInt(a.acq);
    const life = BigInt(a.life);
    let dep = a.method === "declining_balance" ? (bv * 2n) / life : (acq - resVal) / life;
    if (dep <= 0n) dep = 1n;
    if (bv - dep < resVal) dep = bv - resVal;

    const newAcc = BigInt(a.acc) + dep;
    const newBv = bv - dep;
    await tx.execute(sql`
      INSERT INTO asset_depreciation_logs (workspace_id, asset_id, period_month, amount_cents, book_value_after_cents)
      VALUES (${ctx.workspaceId}, ${params.id}, ${b.periodMonth}, ${dep.toString()}, ${newBv.toString()})
    `);
    await tx.execute(sql`
      UPDATE fixed_assets SET accumulated_dep_cents = ${newAcc.toString()}, book_value_cents = ${newBv.toString()}
      WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId}
    `);
    await audit(tx, ctx, "asset.depreciate", "fixed_asset", params.id, { periodMonth: b.periodMonth, amount: dep.toString() });
    return { periodMonth: b.periodMonth, amountCents: dep.toString(), bookValueCents: newBv.toString() };
  }),

  /* ───────── 5. Commissions, Cost of Service & Operational Displays ───────── */
  r("GET", "/prd/commissions", { perm: "hr:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, name, basis, rate_percent::text AS "ratePercent", is_active AS "isActive", created_at AS "createdAt"
      FROM commission_rules WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC
    `);
    return { items: res.rows };
  }),

  r("POST", "/prd/commissions", { perm: "hr:write" }, async ({ ctx, tx, json }) => {
    const b = await json(z.object({ name: z.string().min(1).max(100), basis: z.enum(["product", "service", "target"]), ratePercent: z.coerce.number().min(0).max(100) }));
    const ins = await tx.execute(sql`
      INSERT INTO commission_rules (workspace_id, name, basis, rate_percent)
      VALUES (${ctx.workspaceId}, ${b.name}, ${b.basis}, ${String(b.ratePercent)}::numeric)
      RETURNING id
    `);
    return ins.rows[0];
  }),

  r("GET", "/prd/service-costs", { perm: "ops:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, service_name AS "serviceName", standard_cost_cents::text AS "standardCostCents",
             labor_cost_cents::text AS "laborCostCents", material_cost_cents::text AS "materialCostCents",
             equipment_cost_cents::text AS "equipmentCostCents", facility_cost_cents::text AS "facilityCostCents",
             revenue_cents::text AS "revenueCents", wait_minutes AS "waitMinutes", process_minutes AS "processMinutes",
             created_at AS "createdAt"
      FROM service_costs WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/prd/service-costs", { perm: "ops:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        serviceName: z.string().min(1).max(120),
        standardCost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        laborCost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        materialCost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        equipmentCost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        facilityCost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        revenue: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        waitMinutes: z.coerce.number().int().min(0).default(0),
        processMinutes: z.coerce.number().int().min(0).default(0),
      }),
    );
    const ins = await tx.execute(sql`
      INSERT INTO service_costs (workspace_id, service_name, standard_cost_cents, labor_cost_cents, material_cost_cents, equipment_cost_cents, facility_cost_cents, revenue_cents, wait_minutes, process_minutes)
      VALUES (${ctx.workspaceId}, ${b.serviceName}, ${toCents(b.standardCost).toString()}, ${toCents(b.laborCost).toString()},
              ${toCents(b.materialCost).toString()}, ${toCents(b.equipmentCost).toString()}, ${toCents(b.facilityCost).toString()},
              ${toCents(b.revenue).toString()}, ${b.waitMinutes}, ${b.processMinutes})
      RETURNING id
    `);
    return ins.rows[0];
  }),

  r("GET", "/prd/displays", { perm: "ops:read" }, async ({ ctx, tx, query }) => {
    const station = query.get("station");
    const res = await tx.execute(sql`
      SELECT id, ticket_no AS "ticketNo", station, title, items, priority, status, created_at AS "createdAt"
      FROM operational_displays
      WHERE workspace_id = ${ctx.workspaceId} ${station ? sql`AND station = ${station}` : sql``}
      ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, created_at ASC
      LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/prd/displays", { perm: "ops:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        station: z.enum(["kitchen", "production", "warehouse", "pickup"]),
        title: z.string().min(1).max(120),
        priority: z.enum(["normal", "high", "urgent"]).default("normal"),
        items: z.array(z.string().min(1)).default([]),
      }),
    );
    const ticketNo = await nextNumber(tx, ctx.workspaceId, "display_ticket", "TKT");
    const ins = await tx.execute(sql`
      INSERT INTO operational_displays (workspace_id, ticket_no, station, title, priority, items)
      VALUES (${ctx.workspaceId}, ${ticketNo}, ${b.station}, ${b.title}, ${b.priority}, ${JSON.stringify(b.items)}::jsonb)
      RETURNING id, ticket_no AS "ticketNo", status
    `);
    return ins.rows[0];
  }),

  r("PATCH", "/prd/displays/:id", { perm: "ops:write" }, async ({ ctx, tx, params, json }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "Tiket tidak ditemukan.");
    const b = await json(z.object({ status: z.enum(["queued", "in_progress", "ready", "completed"]) }));
    const up = await tx.execute(sql`
      UPDATE operational_displays SET status = ${b.status}, updated_at = now()
      WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId}
      RETURNING id, status
    `);
    if (!up.rows.length) throw new HttpError(404, "Tiket tidak ditemukan.");
    return up.rows[0];
  }),
];
