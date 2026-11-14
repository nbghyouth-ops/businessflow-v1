import { sql } from "drizzle-orm";
import { z } from "zod";
import { toCents } from "@/lib/money";
import { audit, HttpError, nextNumber, r, type Route } from "../core";

const uuid = z.string().uuid();

export const p2Routes: Route[] = [
  /* ───────── 1. Quotations & Sales Orders ───────── */
  r("GET", "/p2/quotations", { perm: "sales:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, number, client_id AS "clientId", status, valid_until AS "validUntil",
             subtotal::text, discount::text, tax::text, total::text, notes, lines, created_at AS "createdAt"
      FROM quotations WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/quotations", { perm: "sales:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        clientId: uuid.optional(),
        validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        notes: z.string().max(500).optional(),
        lines: z
          .array(
            z.object({
              description: z.string().min(1).max(200),
              qty: z.coerce.number().positive(),
              unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
              discount: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
            }),
          )
          .min(1),
      }),
    );
    let subtotal = 0n;
    let totalDiscount = 0n;
    for (const l of b.lines) {
      const lineGross = (toCents(l.unitPrice) * BigInt(Math.round(l.qty * 1000))) / 1000n;
      const lineDisc = toCents(l.discount);
      subtotal += lineGross;
      totalDiscount += lineDisc;
    }
    const total = subtotal > totalDiscount ? subtotal - totalDiscount : 0n;
    const number = await nextNumber(tx, ctx.workspaceId, "quotation", "QUO");
    const ins = await tx.execute(sql`
      INSERT INTO quotations (workspace_id, branch_id, number, client_id, valid_until, subtotal, discount, total, notes, lines)
      VALUES (${ctx.workspaceId}, ${ctx.branchId}, ${number}, ${b.clientId ?? null}, ${b.validUntil ?? null},
              ${subtotal.toString()}, ${totalDiscount.toString()}, ${total.toString()}, ${b.notes ?? null}, ${JSON.stringify(b.lines)}::jsonb)
      RETURNING id, number, total::text, status
    `);
    await audit(tx, ctx, "quotation.create", "quotation", String((ins.rows[0] as { id: string }).id), { number });
    return ins.rows[0];
  }),

  r("POST", "/p2/quotations/:id/convert", { perm: "sales:write" }, async ({ ctx, tx, params }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "Penawaran tidak ditemukan.");
    const qRes = await tx.execute(sql`
      SELECT * FROM quotations WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId} LIMIT 1
    `);
    const q = qRes.rows[0] as Record<string, unknown> | undefined;
    if (!q) throw new HttpError(404, "Penawaran tidak ditemukan.");
    const number = await nextNumber(tx, ctx.workspaceId, "sales_order", "SO");
    const so = await tx.execute(sql`
      INSERT INTO sales_orders (workspace_id, branch_id, number, quotation_id, client_id, subtotal, discount, tax, total, lines)
      VALUES (${ctx.workspaceId}, ${ctx.branchId}, ${number}, ${params.id}, ${q.client_id ?? null},
              ${String(q.subtotal)}, ${String(q.discount)}, ${String(q.tax)}, ${String(q.total)}, ${JSON.stringify(q.lines)}::jsonb)
      RETURNING id, number, status
    `);
    await tx.execute(sql`UPDATE quotations SET status = 'converted' WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId}`);
    await audit(tx, ctx, "quotation.convert", "sales_order", String((so.rows[0] as { id: string }).id), { number });
    return so.rows[0];
  }),

  r("GET", "/p2/sales-orders", { perm: "sales:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, number, quotation_id AS "quotationId", client_id AS "clientId", status,
             subtotal::text, discount::text, tax::text, total::text, lines, created_at AS "createdAt"
      FROM sales_orders WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  /* ───────── 2. Stock Transfer & Stock Count (Opname) ───────── */
  r("GET", "/p2/stock-transfers", { perm: "inventory:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, number, from_warehouse_id AS "fromWarehouseId", to_warehouse_id AS "toWarehouseId",
             product_id AS "productId", qty_milli::text AS "qtyMilli", status, note, created_at AS "createdAt"
      FROM stock_transfers WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/stock-transfers", { perm: "inventory:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        fromWarehouseId: uuid,
        toWarehouseId: uuid,
        productId: uuid,
        qty: z.coerce.number().positive(),
        note: z.string().max(300).optional(),
        status: z.enum(["draft", "completed"]).default("completed"),
      }),
    );
    if (b.fromWarehouseId === b.toWarehouseId) throw new HttpError(422, "Gudang asal dan tujuan harus berbeda.");

    // Verifikasi produk dan gudang ada di workspace
    const prodRes = await tx.execute(sql`
      SELECT id, name, cost_price AS "costPrice" FROM products
      WHERE id = ${b.productId} AND workspace_id = ${ctx.workspaceId} LIMIT 1
    `);
    if (!prodRes.rows.length) throw new HttpError(404, "Produk tidak ditemukan.");

    const whRes = await tx.execute(sql`
      SELECT id FROM warehouses WHERE id IN (${b.fromWarehouseId}, ${b.toWarehouseId}) AND workspace_id = ${ctx.workspaceId}
    `);
    if (whRes.rows.length < 2) throw new HttpError(422, "Gudang asal atau tujuan tidak valid dalam workspace ini.");

    const qtyMilli = Math.round(b.qty * 1000);
    const unitCost = String((prodRes.rows[0] as { costPrice: unknown })?.costPrice ?? "0");
    const number = await nextNumber(tx, ctx.workspaceId, "stock_transfer", "TRF");

    if (b.status === "completed") {
      // Validasi ketersediaan stok di gudang asal
      const stockRes = await tx.execute(sql`
        SELECT COALESCE(SUM(quantity), 0)::numeric AS current_stock
        FROM stock_movements
        WHERE workspace_id = ${ctx.workspaceId} AND warehouse_id = ${b.fromWarehouseId} AND product_id = ${b.productId}
      `);
      const currentStock = Number((stockRes.rows[0] as { current_stock: string })?.current_stock ?? 0);
      if (currentStock < b.qty) {
        throw new HttpError(422, `Stok gudang asal tidak mencukupi (tersedia: ${currentStock}, diminta: ${b.qty}).`);
      }

      const ins = await tx.execute(sql`
        INSERT INTO stock_transfers (workspace_id, number, from_warehouse_id, to_warehouse_id, product_id, qty_milli, status, note)
        VALUES (${ctx.workspaceId}, ${number}, ${b.fromWarehouseId}, ${b.toWarehouseId}, ${b.productId}, ${qtyMilli}, 'completed', ${b.note ?? null})
        RETURNING id, number, status
      `);
      const transferId = String((ins.rows[0] as { id: string }).id);

      // Mutasi KELUAR gudang asal
      await tx.execute(sql`
        INSERT INTO stock_movements (
          workspace_id, business_id, warehouse_id, product_id, quantity, unit_cost, kind, ref_type, ref_id, note, device_id
        ) VALUES (
          ${ctx.workspaceId}, ${ctx.businessId}, ${b.fromWarehouseId}, ${b.productId},
          ${(-b.qty).toFixed(3)}::numeric, ${unitCost}::numeric, 'transfer_out', 'stock_transfer', ${transferId}::uuid,
          ${'Transfer keluar ke ' + number}, ${ctx.deviceId}
        )
      `);

      // Mutasi MASUK gudang tujuan
      await tx.execute(sql`
        INSERT INTO stock_movements (
          workspace_id, business_id, warehouse_id, product_id, quantity, unit_cost, kind, ref_type, ref_id, note, device_id
        ) VALUES (
          ${ctx.workspaceId}, ${ctx.businessId}, ${b.toWarehouseId}, ${b.productId},
          ${b.qty.toFixed(3)}::numeric, ${unitCost}::numeric, 'transfer_in', 'stock_transfer', ${transferId}::uuid,
          ${'Transfer masuk dari ' + number}, ${ctx.deviceId}
        )
      `);

      await audit(tx, ctx, "stock.transfer.complete", "stock_transfer", transferId, { number, qty: b.qty });
      return ins.rows[0];
    } else {
      const ins = await tx.execute(sql`
        INSERT INTO stock_transfers (workspace_id, number, from_warehouse_id, to_warehouse_id, product_id, qty_milli, status, note)
        VALUES (${ctx.workspaceId}, ${number}, ${b.fromWarehouseId}, ${b.toWarehouseId}, ${b.productId}, ${qtyMilli}, 'draft', ${b.note ?? null})
        RETURNING id, number, status
      `);
      await audit(tx, ctx, "stock.transfer.create", "stock_transfer", String((ins.rows[0] as { id: string }).id), { number });
      return ins.rows[0];
    }
  }),

  r("POST", "/p2/stock-transfers/:id/complete", { perm: "inventory:write" }, async ({ ctx, tx, params }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "Transfer tidak ditemukan.");
    const trfRes = await tx.execute(sql`
      SELECT id, number, from_warehouse_id AS "fromWarehouseId", to_warehouse_id AS "toWarehouseId",
             product_id AS "productId", qty_milli AS "qtyMilli", status
      FROM stock_transfers WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId}
      FOR UPDATE
    `);
    const trf = trfRes.rows[0] as {
      id: string;
      number: string;
      fromWarehouseId: string;
      toWarehouseId: string;
      productId: string;
      qtyMilli: string | number;
      status: string;
    } | undefined;
    if (!trf) throw new HttpError(404, "Transfer tidak ditemukan.");
    if (trf.status === "completed") throw new HttpError(409, "Transfer sudah berstatus selesai.");

    const qty = Number(trf.qtyMilli) / 1000;
    const stockRes = await tx.execute(sql`
      SELECT COALESCE(SUM(quantity), 0)::numeric AS current_stock
      FROM stock_movements
      WHERE workspace_id = ${ctx.workspaceId} AND warehouse_id = ${trf.fromWarehouseId} AND product_id = ${trf.productId}
    `);
    const currentStock = Number((stockRes.rows[0] as { current_stock: string })?.current_stock ?? 0);
    if (currentStock < qty) {
      throw new HttpError(422, `Stok gudang asal tidak mencukupi (tersedia: ${currentStock}, diminta: ${qty}).`);
    }

    const prodRes = await tx.execute(sql`
      SELECT cost_price AS "costPrice" FROM products WHERE id = ${trf.productId} AND workspace_id = ${ctx.workspaceId} LIMIT 1
    `);
    const unitCost = String((prodRes.rows[0] as { costPrice: unknown })?.costPrice ?? "0");

    await tx.execute(sql`
      INSERT INTO stock_movements (
        workspace_id, business_id, warehouse_id, product_id, quantity, unit_cost, kind, ref_type, ref_id, note, device_id
      ) VALUES (
        ${ctx.workspaceId}, ${ctx.businessId}, ${trf.fromWarehouseId}, ${trf.productId},
        ${(-qty).toFixed(3)}::numeric, ${unitCost}::numeric, 'transfer_out', 'stock_transfer', ${trf.id}::uuid,
        ${'Transfer keluar ke ' + trf.number}, ${ctx.deviceId}
      )
    `);

    await tx.execute(sql`
      INSERT INTO stock_movements (
        workspace_id, business_id, warehouse_id, product_id, quantity, unit_cost, kind, ref_type, ref_id, note, device_id
      ) VALUES (
        ${ctx.workspaceId}, ${ctx.businessId}, ${trf.toWarehouseId}, ${trf.productId},
        ${qty.toFixed(3)}::numeric, ${unitCost}::numeric, 'transfer_in', 'stock_transfer', ${trf.id}::uuid,
        ${'Transfer masuk dari ' + trf.number}, ${ctx.deviceId}
      )
    `);

    const up = await tx.execute(sql`
      UPDATE stock_transfers SET status = 'completed' WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId}
      RETURNING id, number, status
    `);
    await audit(tx, ctx, "stock.transfer.complete", "stock_transfer", trf.id, { number: trf.number, qty });
    return up.rows[0];
  }),

  r("GET", "/p2/stock-counts", { perm: "inventory:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, number, warehouse_id AS "warehouseId", status, items, note, created_at AS "createdAt"
      FROM stock_counts WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/stock-counts", { perm: "inventory:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        warehouseId: uuid,
        note: z.string().max(300).optional(),
        items: z
          .array(
            z.object({
              productId: uuid,
              countedQty: z.coerce.number().min(0),
            }),
          )
          .min(1),
        status: z.enum(["draft", "posted"]).default("posted"),
      }),
    );
    const whRes = await tx.execute(sql`
      SELECT id FROM warehouses WHERE id = ${b.warehouseId} AND workspace_id = ${ctx.workspaceId} LIMIT 1
    `);
    if (!whRes.rows.length) throw new HttpError(404, "Gudang tidak ditemukan.");

    const number = await nextNumber(tx, ctx.workspaceId, "stock_count", "OPN");
    const detailedItems: Array<{
      productId: string;
      countedQty: number;
      systemQty: number;
      varianceQty: number;
      unitCost: string;
    }> = [];

    for (const it of b.items) {
      const prodRes = await tx.execute(sql`
        SELECT id, name, cost_price AS "costPrice" FROM products
        WHERE id = ${it.productId} AND workspace_id = ${ctx.workspaceId} LIMIT 1
      `);
      if (!prodRes.rows.length) continue;
      const unitCost = String((prodRes.rows[0] as { costPrice: unknown })?.costPrice ?? "0");

      const stockRes = await tx.execute(sql`
        SELECT COALESCE(SUM(quantity), 0)::numeric AS current_stock
        FROM stock_movements
        WHERE workspace_id = ${ctx.workspaceId} AND warehouse_id = ${b.warehouseId} AND product_id = ${it.productId}
      `);
      const systemStock = Number((stockRes.rows[0] as { current_stock: string })?.current_stock ?? 0);
      const variance = it.countedQty - systemStock;

      detailedItems.push({
        productId: it.productId,
        countedQty: it.countedQty,
        systemQty: systemStock,
        varianceQty: variance,
        unitCost,
      });
    }

    const ins = await tx.execute(sql`
      INSERT INTO stock_counts (workspace_id, number, warehouse_id, items, status, note)
      VALUES (${ctx.workspaceId}, ${number}, ${b.warehouseId}, ${JSON.stringify(detailedItems)}::jsonb, ${b.status}, ${b.note ?? null})
      RETURNING id, number, status
    `);
    const countId = String((ins.rows[0] as { id: string }).id);

    if (b.status === "posted") {
      for (const item of detailedItems) {
        if (item.varianceQty !== 0) {
          await tx.execute(sql`
            INSERT INTO stock_movements (
              workspace_id, business_id, warehouse_id, product_id, quantity, unit_cost, kind, ref_type, ref_id, note, device_id
            ) VALUES (
              ${ctx.workspaceId}, ${ctx.businessId}, ${b.warehouseId}, ${item.productId},
              ${item.varianceQty.toFixed(3)}::numeric, ${item.unitCost}::numeric, 'adjustment', 'stock_count', ${countId}::uuid,
              ${'Penyesuaian stok opname ' + number + ' (fisik: ' + item.countedQty + ', sistem: ' + item.systemQty + ')'},
              ${ctx.deviceId}
            )
          `);
        }
      }
      await audit(tx, ctx, "stock.count.posted", "stock_count", countId, { number, itemsCount: detailedItems.length });
    } else {
      await audit(tx, ctx, "stock.count.draft", "stock_count", countId, { number });
    }

    return { ...ins.rows[0], items: detailedItems };
  }),

  r("POST", "/p2/stock-counts/:id/post", { perm: "inventory:write" }, async ({ ctx, tx, params }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "Stock opname tidak ditemukan.");
    const countRes = await tx.execute(sql`
      SELECT id, number, warehouse_id AS "warehouseId", items, status
      FROM stock_counts WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId}
      FOR UPDATE
    `);
    const sc = countRes.rows[0] as {
      id: string;
      number: string;
      warehouseId: string;
      items: Array<{ productId: string; countedQty: number; systemQty?: number; varianceQty?: number; unitCost?: string }>;
      status: string;
    } | undefined;
    if (!sc) throw new HttpError(404, "Stock opname tidak ditemukan.");
    if (sc.status === "posted") throw new HttpError(409, "Stock opname sudah diposting.");

    const items = Array.isArray(sc.items) ? sc.items : [];
    for (const item of items) {
      const stockRes = await tx.execute(sql`
        SELECT COALESCE(SUM(quantity), 0)::numeric AS current_stock
        FROM stock_movements
        WHERE workspace_id = ${ctx.workspaceId} AND warehouse_id = ${sc.warehouseId} AND product_id = ${item.productId}
      `);
      const systemStock = Number((stockRes.rows[0] as { current_stock: string })?.current_stock ?? 0);
      const variance = item.countedQty - systemStock;

      const prodRes = await tx.execute(sql`
        SELECT cost_price AS "costPrice" FROM products WHERE id = ${item.productId} AND workspace_id = ${ctx.workspaceId} LIMIT 1
      `);
      const unitCost = String((prodRes.rows[0] as { costPrice: unknown })?.costPrice ?? "0");

      if (variance !== 0) {
        await tx.execute(sql`
          INSERT INTO stock_movements (
            workspace_id, business_id, warehouse_id, product_id, quantity, unit_cost, kind, ref_type, ref_id, note, device_id
          ) VALUES (
            ${ctx.workspaceId}, ${ctx.businessId}, ${sc.warehouseId}, ${item.productId},
            ${variance.toFixed(3)}::numeric, ${unitCost}::numeric, 'adjustment', 'stock_count', ${sc.id}::uuid,
            ${'Penyesuaian stok opname ' + sc.number + ' (fisik: ' + item.countedQty + ', sistem: ' + systemStock + ')'},
            ${ctx.deviceId}
          )
        `);
      }
    }

    const up = await tx.execute(sql`
      UPDATE stock_counts SET status = 'posted' WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId}
      RETURNING id, number, status
    `);
    await audit(tx, ctx, "stock.count.posted", "stock_count", sc.id, { number: sc.number });
    return up.rows[0];
  }),

  /* ───────── 3. Purchase Requests & Supplier Returns ───────── */
  r("GET", "/p2/purchase-requests", { perm: "purchasing:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, number, requester, status, items, estimated_total::text AS "estimatedTotal", note, created_at AS "createdAt"
      FROM purchase_requests WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/purchase-requests", { perm: "purchasing:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        requester: z.string().min(1).max(120),
        estimatedTotal: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        note: z.string().max(400).optional(),
        items: z.array(z.object({ name: z.string().min(1), qty: z.coerce.number().positive(), productId: uuid.optional() })).min(1),
        status: z.enum(["draft", "pending_approval"]).default("pending_approval"),
      }),
    );
    const number = await nextNumber(tx, ctx.workspaceId, "purchase_request", "PR");
    const estCents = toCents(b.estimatedTotal);
    const ins = await tx.execute(sql`
      INSERT INTO purchase_requests (workspace_id, number, requester, estimated_total, items, status, note)
      VALUES (${ctx.workspaceId}, ${number}, ${b.requester}, ${estCents.toString()}, ${JSON.stringify(b.items)}::jsonb, ${b.status}, ${b.note ?? null})
      RETURNING id, number, status
    `);
    await audit(tx, ctx, "pr.create", "purchase_request", String((ins.rows[0] as { id: string }).id), { number });
    return ins.rows[0];
  }),

  r("POST", "/p2/purchase-requests/:id/approve", { perm: "purchasing:write" }, async ({ ctx, tx, params }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "PR tidak ditemukan.");
    const up = await tx.execute(sql`
      UPDATE purchase_requests SET status = 'approved' WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId} AND status IN ('draft', 'pending_approval')
      RETURNING id, status
    `);
    if (!up.rows.length) throw new HttpError(404, "PR tidak ditemukan atau status tidak dapat disetujui.");
    await audit(tx, ctx, "pr.approve", "purchase_request", params.id);
    return up.rows[0];
  }),

  r("POST", "/p2/purchase-requests/:id/reject", { perm: "purchasing:write" }, async ({ ctx, tx, params, json }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "PR tidak ditemukan.");
    const b = await json(z.object({ reason: z.string().min(1).max(300).optional() }));
    const up = await tx.execute(sql`
      UPDATE purchase_requests SET status = 'rejected', note = COALESCE(${b.reason ?? null}, note)
      WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId} AND status IN ('draft', 'pending_approval')
      RETURNING id, status
    `);
    if (!up.rows.length) throw new HttpError(404, "PR tidak ditemukan atau status tidak dapat ditolak.");
    await audit(tx, ctx, "pr.reject", "purchase_request", params.id, { reason: b.reason });
    return up.rows[0];
  }),

  r("POST", "/p2/purchase-requests/:id/cancel", { perm: "purchasing:write" }, async ({ ctx, tx, params }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "PR tidak ditemukan.");
    const up = await tx.execute(sql`
      UPDATE purchase_requests SET status = 'cancelled'
      WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId} AND status <> 'cancelled'
      RETURNING id, status
    `);
    if (!up.rows.length) throw new HttpError(404, "PR tidak ditemukan atau sudah dibatalkan.");
    await audit(tx, ctx, "pr.cancel", "purchase_request", params.id);
    return up.rows[0];
  }),

  r("GET", "/p2/supplier-returns", { perm: "purchasing:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, number, supplier_id AS "supplierId", po_id AS "poId", total::text, reason, items, created_at AS "createdAt"
      FROM supplier_returns WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/supplier-returns", { perm: "purchasing:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        supplierId: uuid.optional(),
        poId: uuid.optional(),
        warehouseId: uuid.optional(),
        total: z.string().regex(/^\d+(\.\d{1,2})?$/),
        reason: z.string().min(1).max(300),
        items: z
          .array(
            z.object({
              name: z.string().min(1),
              qty: z.coerce.number().positive(),
              productId: uuid.optional(),
              warehouseId: uuid.optional(),
              unitCost: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
            }),
          )
          .default([]),
      }),
    );

    // Dapatkan default warehouse jika belum dispesifikasikan per item
    let defaultWhId = b.warehouseId;
    if (!defaultWhId) {
      const defWh = await tx.execute(sql`
        SELECT id FROM warehouses WHERE workspace_id = ${ctx.workspaceId} ORDER BY is_default DESC, created_at ASC LIMIT 1
      `);
      defaultWhId = (defWh.rows[0] as { id: string } | undefined)?.id;
    }

    const number = await nextNumber(tx, ctx.workspaceId, "supplier_return", "SRT");
    const ins = await tx.execute(sql`
      INSERT INTO supplier_returns (workspace_id, number, supplier_id, po_id, total, reason, items)
      VALUES (${ctx.workspaceId}, ${number}, ${b.supplierId ?? null}, ${b.poId ?? null}, ${toCents(b.total).toString()}, ${b.reason}, ${JSON.stringify(b.items)}::jsonb)
      RETURNING id, number
    `);
    const returnId = String((ins.rows[0] as { id: string }).id);

    // Pengurangan stok pada stock_movements untuk setiap item yang memiliki productId
    for (const item of b.items) {
      if (item.productId) {
        const targetWhId = item.warehouseId || defaultWhId;
        if (targetWhId) {
          await tx.execute(sql`
            INSERT INTO stock_movements (
              workspace_id, business_id, warehouse_id, product_id, quantity, unit_cost, kind, ref_type, ref_id, note, device_id
            ) VALUES (
              ${ctx.workspaceId}, ${ctx.businessId}, ${targetWhId}, ${item.productId},
              ${(-item.qty).toFixed(3)}::numeric, ${toCents(item.unitCost).toString()}::numeric, 'supplier_return', 'supplier_return', ${returnId}::uuid,
              ${'Retur ke pemasok ' + number + ': ' + b.reason}, ${ctx.deviceId}
            )
          `);
        }
      }
    }

    await audit(tx, ctx, "supplier_return.create", "supplier_return", returnId, { number, total: b.total });
    return ins.rows[0];
  }),

  /* ───────── 4. HR: Leave, Shifts, Payroll ───────── */
  r("GET", "/p2/leave-requests", { perm: "hr:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, employee_id AS "employeeId", leave_type AS "leaveType", start_date::text AS "startDate",
             end_date::text AS "endDate", status, reason, created_at AS "createdAt"
      FROM leave_requests WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/leave-requests", { perm: "hr:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        employeeId: uuid,
        leaveType: z.string().min(1).max(60),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().max(300).optional(),
      }),
    );
    if (b.startDate > b.endDate) throw new HttpError(422, "Tanggal mulai setelah tanggal selesai.");
    const ins = await tx.execute(sql`
      INSERT INTO leave_requests (workspace_id, employee_id, leave_type, start_date, end_date, reason)
      VALUES (${ctx.workspaceId}, ${b.employeeId}, ${b.leaveType}, ${b.startDate}::date, ${b.endDate}::date, ${b.reason ?? null})
      RETURNING id, status
    `);
    return ins.rows[0];
  }),

  r("POST", "/p2/leave-requests/:id/decide", { perm: "hr:write" }, async ({ ctx, tx, params, json }) => {
    const { status } = await json(z.object({ status: z.enum(["approved", "rejected"]) }));
    const up = await tx.execute(sql`
      UPDATE leave_requests SET status = ${status} WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId} RETURNING id, status
    `);
    if (!up.rows.length) throw new HttpError(404, "Pengajuan cuti tidak ditemukan.");
    return up.rows[0];
  }),

  r("GET", "/p2/shifts", { perm: "hr:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, employee_id AS "employeeId", shift_date::text AS "shiftDate", start_time AS "startTime",
             end_time AS "endTime", overtime_minutes AS "overtimeMinutes", note
      FROM shifts WHERE workspace_id = ${ctx.workspaceId} ORDER BY shift_date DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/shifts", { perm: "hr:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        employeeId: uuid,
        shiftDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: z.string().min(4).max(10),
        endTime: z.string().min(4).max(10),
        overtimeMinutes: z.coerce.number().int().min(0).default(0),
        note: z.string().max(200).optional(),
      }),
    );
    const ins = await tx.execute(sql`
      INSERT INTO shifts (workspace_id, employee_id, shift_date, start_time, end_time, overtime_minutes, note)
      VALUES (${ctx.workspaceId}, ${b.employeeId}, ${b.shiftDate}::date, ${b.startTime}, ${b.endTime}, ${b.overtimeMinutes}, ${b.note ?? null})
      RETURNING id
    `);
    return ins.rows[0];
  }),

  r("GET", "/p2/payroll-runs", { perm: "hr:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, period_month AS "periodMonth", status, total_gross::text AS "totalGross",
             total_deductions::text AS "totalDeductions", total_net::text AS "totalNet", items, created_at AS "createdAt"
      FROM payroll_runs WHERE workspace_id = ${ctx.workspaceId} ORDER BY period_month DESC LIMIT 36
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/payroll-runs", { perm: "hr:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        periodMonth: z.string().regex(/^\d{4}-\d{2}$/),
        items: z
          .array(
            z.object({
              employeeId: uuid,
              name: z.string().min(1),
              gross: z.string().regex(/^\d+(\.\d{1,2})?$/),
              deductions: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
            }),
          )
          .min(1),
      }),
    );
    let totalGross = 0n;
    let totalDed = 0n;
    for (const it of b.items) {
      totalGross += toCents(it.gross);
      totalDed += toCents(it.deductions);
    }
    const totalNet = totalGross > totalDed ? totalGross - totalDed : 0n;
    const ins = await tx.execute(sql`
      INSERT INTO payroll_runs (workspace_id, period_month, total_gross, total_deductions, total_net, items)
      VALUES (${ctx.workspaceId}, ${b.periodMonth}, ${totalGross.toString()}, ${totalDed.toString()}, ${totalNet.toString()}, ${JSON.stringify(b.items)}::jsonb)
      RETURNING id, period_month AS "periodMonth", total_net AS "totalNet"
    `);
    await audit(tx, ctx, "payroll.run", "payroll_run", String((ins.rows[0] as { id: string }).id), { periodMonth: b.periodMonth });
    return ins.rows[0];
  }),

  /* ───────── 5. Task Comments & Checklists ───────── */
  r("GET", "/p2/tasks/:id/comments", { perm: "tasks:read" }, async ({ ctx, tx, params }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "Tugas tidak ditemukan.");
    const res = await tx.execute(sql`
      SELECT id, author, body, checklist, created_at AS "createdAt"
      FROM task_comments WHERE workspace_id = ${ctx.workspaceId} AND task_id = ${params.id}
      ORDER BY created_at ASC
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/tasks/:id/comments", { perm: "tasks:write" }, async ({ ctx, tx, params, json }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "Tugas tidak ditemukan.");
    const b = await json(
      z.object({
        body: z.string().min(1).max(1000),
        checklist: z.array(z.object({ label: z.string().min(1), done: z.boolean() })).default([]),
      }),
    );
    const ins = await tx.execute(sql`
      INSERT INTO task_comments (workspace_id, task_id, author, body, checklist)
      VALUES (${ctx.workspaceId}, ${params.id}, ${ctx.operator ?? ctx.deviceName}, ${b.body}, ${JSON.stringify(b.checklist)}::jsonb)
      RETURNING id, created_at AS "createdAt"
    `);
    return ins.rows[0];
  }),

  /* ───────── 6. Bank Reconciliation & Credit Notes ───────── */
  r("GET", "/p2/bank-reconciliations", { perm: "finance:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, account_id AS "accountId", statement_date::text AS "statementDate",
             statement_balance::text AS "statementBalance", book_balance::text AS "bookBalance",
             difference::text, status, note, created_at AS "createdAt"
      FROM bank_reconciliations WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 50
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/bank-reconciliations", { perm: "finance:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        accountId: uuid,
        statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        statementBalance: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
        bookBalance: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
        note: z.string().max(300).optional(),
      }),
    );
    const stmtCents = toCents(b.statementBalance.replace(/^-/, "")) * (b.statementBalance.startsWith("-") ? -1n : 1n);
    const bookCents = toCents(b.bookBalance.replace(/^-/, "")) * (b.bookBalance.startsWith("-") ? -1n : 1n);
    const diff = stmtCents - bookCents;
    const status = diff === 0n ? "reconciled" : "unbalanced";
    const ins = await tx.execute(sql`
      INSERT INTO bank_reconciliations (workspace_id, account_id, statement_date, statement_balance, book_balance, difference, status, note)
      VALUES (${ctx.workspaceId}, ${b.accountId}, ${b.statementDate}::date, ${stmtCents.toString()}, ${bookCents.toString()}, ${diff.toString()}, ${status}, ${b.note ?? null})
      RETURNING id, difference::text, status
    `);
    await audit(tx, ctx, "finance.reconcile", "bank_reconciliation", String((ins.rows[0] as { id: string }).id), { status });
    return ins.rows[0];
  }),

  r("GET", "/p2/credit-notes", { perm: "finance:read" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, number, invoice_id AS "invoiceId", client_id AS "clientId", amount::text, reason, status, created_at AS "createdAt"
      FROM credit_notes WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/credit-notes", { perm: "finance:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        invoiceId: uuid.optional(),
        clientId: uuid.optional(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
        reason: z.string().min(1).max(300),
      }),
    );
    const amt = toCents(b.amount);
    if (amt <= 0n) throw new HttpError(422, "Nominal credit note harus lebih dari nol.");
    const number = await nextNumber(tx, ctx.workspaceId, "credit_note", "CN");
    const ins = await tx.execute(sql`
      INSERT INTO credit_notes (workspace_id, number, invoice_id, client_id, amount, reason)
      VALUES (${ctx.workspaceId}, ${number}, ${b.invoiceId ?? null}, ${b.clientId ?? null}, ${amt.toString()}, ${b.reason})
      RETURNING id, number, status
    `);
    await audit(tx, ctx, "credit_note.create", "credit_note", String((ins.rows[0] as { id: string }).id), { number });
    return ins.rows[0];
  }),

  /* ───────── 7. Import / Migration / Reconciliation Center (CSV + Rollback) ───────── */
  r("GET", "/p2/imports", { perm: "settings:write" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, target, filename, total_rows AS "totalRows", imported_rows AS "importedRows",
             error_rows AS "errorRows", status, errors, created_at AS "createdAt"
      FROM import_batches WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 50
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/imports/commit", { perm: "settings:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        target: z.enum(["clients", "products"]),
        filename: z.string().min(1).max(150),
        rows: z.array(z.record(z.string(), z.string())).min(1).max(1000),
      }),
    );
    const errors: { row: number; message: string }[] = [];
    const insertedIds: string[] = [];

    for (let i = 0; i < b.rows.length; i++) {
      const row = b.rows[i];
      const name = (row.name ?? row.nama ?? "").trim();
      if (!name) {
        errors.push({ row: i + 1, message: "Kolom name/nama wajib diisi." });
        continue;
      }
      if (b.target === "clients") {
        const code = await nextNumber(tx, ctx.workspaceId, "client", "CLN");
        const ins = await tx.execute(sql`
          INSERT INTO clients (workspace_id, business_id, code, name, phone, email)
          VALUES (${ctx.workspaceId}, ${ctx.businessId}, ${code}, ${name}, ${row.phone ?? row.telepon ?? null}, ${row.email ?? null})
          RETURNING id
        `);
        insertedIds.push(String((ins.rows[0] as { id: string }).id));
      } else {
        const sku = (row.sku ?? "").trim() || (await nextNumber(tx, ctx.workspaceId, "sku", "SKU"));
        const priceStr = (row.price ?? row.harga ?? "0").replace(/[^\d.]/g, "") || "0";
        const ins = await tx.execute(sql`
          INSERT INTO products (workspace_id, business_id, sku, name, price)
          VALUES (${ctx.workspaceId}, ${ctx.businessId}, ${sku}, ${name}, ${priceStr}::numeric)
          RETURNING id
        `);
        insertedIds.push(String((ins.rows[0] as { id: string }).id));
      }
    }

    const batch = await tx.execute(sql`
      INSERT INTO import_batches (workspace_id, target, filename, total_rows, imported_rows, error_rows, inserted_ids, errors)
      VALUES (${ctx.workspaceId}, ${b.target}, ${b.filename}, ${b.rows.length}, ${insertedIds.length}, ${errors.length},
              ${JSON.stringify(insertedIds)}::jsonb, ${JSON.stringify(errors)}::jsonb)
      RETURNING id, total_rows AS "totalRows", imported_rows AS "importedRows", error_rows AS "errorRows", status, errors
    `);
    await audit(tx, ctx, "import.commit", "import_batch", String((batch.rows[0] as { id: string }).id), {
      target: b.target,
      imported: insertedIds.length,
    });
    return batch.rows[0];
  }),

  r("POST", "/p2/imports/:id/rollback", { perm: "settings:write" }, async ({ ctx, tx, params }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, "Batch impor tidak ditemukan.");
    const res = await tx.execute(sql`
      SELECT id, target, status, inserted_ids FROM import_batches
      WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId} LIMIT 1
    `);
    const batch = res.rows[0] as { id: string; target: string; status: string; inserted_ids: string[] } | undefined;
    if (!batch) throw new HttpError(404, "Batch impor tidak ditemukan.");
    if (batch.status === "rolled_back") throw new HttpError(409, "Batch sudah di-rollback sebelumnya.");

    for (const rid of batch.inserted_ids ?? []) {
      if (batch.target === "clients") {
        await tx.execute(sql`DELETE FROM clients WHERE id = ${rid}::uuid AND workspace_id = ${ctx.workspaceId}`);
      } else {
        await tx.execute(sql`DELETE FROM products WHERE id = ${rid}::uuid AND workspace_id = ${ctx.workspaceId}`);
      }
    }
    await tx.execute(sql`UPDATE import_batches SET status = 'rolled_back' WHERE id = ${params.id} AND workspace_id = ${ctx.workspaceId}`);
    await audit(tx, ctx, "import.rollback", "import_batch", params.id);
    return { ok: true, rolledBackCount: (batch.inserted_ids ?? []).length };
  }),

  /* ───────── 8. Privacy DSR Management ───────── */
  r("GET", "/p2/privacy/dsr", { perm: "settings:write" }, async ({ ctx, tx }) => {
    const res = await tx.execute(sql`
      SELECT id, subject_name AS "subjectName", request_type AS "requestType", status, notes, created_at AS "createdAt"
      FROM data_subject_requests WHERE workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100
    `);
    return { items: res.rows };
  }),

  r("POST", "/p2/privacy/dsr", { perm: "settings:write" }, async ({ ctx, tx, json }) => {
    const b = await json(
      z.object({
        subjectName: z.string().min(1).max(120),
        requestType: z.enum(["access", "rectification", "erasure", "restriction"]),
        notes: z.string().max(400).optional(),
      }),
    );
    const ins = await tx.execute(sql`
      INSERT INTO data_subject_requests (workspace_id, subject_name, request_type, notes)
      VALUES (${ctx.workspaceId}, ${b.subjectName}, ${b.requestType}, ${b.notes ?? null})
      RETURNING id, status
    `);
    await audit(tx, ctx, "privacy.dsr_create", "data_subject_request", String((ins.rows[0] as { id: string }).id));
    return ins.rows[0];
  }),
];
