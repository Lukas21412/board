// Client für den SAP Business One Service Layer (OData v4, /b1s/v1 bzw. /b1s/v2).
// Der Service Layer arbeitet mit Session-Cookies (B1SESSION, ROUTEID). Diese
// Cookies bleiben auf dem Server – das Handy bekommt sie nie zu sehen.

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import { AppError } from './errors.js';

/** OData-String-Literal: einfache Hochkommas verdoppeln. */
export function odataString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function createSapBackend({ baseUrl, caFile, timeoutMs = 30000 }) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  const transport = base.protocol === 'https:' ? https : http;
  const agent =
    base.protocol === 'https:'
      ? new https.Agent({ keepAlive: true, ca: caFile ? fs.readFileSync(caFile) : undefined })
      : new http.Agent({ keepAlive: true });

  function request(method, path, { body, cookie } = {}) {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (cookie) headers.Cookie = cookie;
    // Ohne diesen Header liefert der Service Layer nur 20 Datensätze pro Seite.
    headers.Prefer = 'odata.maxpagesize=200';

    return new Promise((resolve, reject) => {
      const req = transport.request(url, { method, headers, agent, timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          if (text) {
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      });
      req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim SAP Service Layer')));
      req.on('error', (err) =>
        reject(new AppError(502, `SAP Service Layer nicht erreichbar: ${err.message}`))
      );
      if (payload) req.write(payload);
      req.end();
    });
  }

  function slError(res) {
    if (res.status === 401) return new AppError(401, 'SAP-Sitzung abgelaufen – bitte neu anmelden.');
    const msg = res.json?.error?.message;
    const text = typeof msg === 'string' ? msg : msg?.value;
    return new AppError(res.status >= 500 ? 502 : 400, text || `SAP-Fehler (HTTP ${res.status})`);
  }

  async function call(session, method, path, body) {
    const res = await request(method, path, { body, cookie: session.cookie });
    if (res.status >= 400) throw slError(res);
    return res.json;
  }

  async function getItem(session, itemCode) {
    const path =
      `Items(${odataString(itemCode)})?$select=ItemCode,ItemName,BarCode,InventoryUOM,` +
      `ManageBatchNumbers,ManageSerialNumbers,InventoryItem,Valid,ItemWarehouseInfoCollection`;
    const res = await request('GET', path, { cookie: session.cookie });
    if (res.status === 404) return null;
    if (res.status >= 400) throw slError(res);
    return mapItem(res.json);
  }

  function mapItem(it) {
    return {
      itemCode: it.ItemCode,
      itemName: it.ItemName,
      barcode: it.BarCode || null,
      uom: it.InventoryUOM || '',
      batchManaged: it.ManageBatchNumbers === 'tYES',
      serialManaged: it.ManageSerialNumbers === 'tYES',
      inventoryItem: it.InventoryItem !== 'tNO',
      active: it.Valid !== 'tNO',
      stock: (it.ItemWarehouseInfoCollection || [])
        .map((w) => ({
          warehouse: w.WarehouseCode,
          inStock: Number(w.InStock) || 0,
          committed: Number(w.Committed) || 0,
          ordered: Number(w.Ordered) || 0,
        }))
        .filter((w) => w.inStock || w.committed || w.ordered),
    };
  }

  return {
    mode: 'sap',

    async login({ companyDb, userName, password }) {
      const res = await request('POST', 'Login', {
        body: { CompanyDB: companyDb, UserName: userName, Password: password },
      });
      if (res.status >= 400) {
        const err = slError(res);
        if (res.status === 401) err.message = 'Anmeldung fehlgeschlagen: Benutzer oder Passwort falsch.';
        throw err;
      }
      const setCookie = res.headers['set-cookie'] || [];
      const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
      if (!cookie.includes('B1SESSION')) throw new AppError(502, 'SAP hat keine Sitzung zurückgegeben.');
      return { cookie, userName, companyDb };
    },

    async logout(session) {
      await request('POST', 'Logout', { cookie: session.cookie }).catch(() => {});
    },

    async warehouses(session) {
      const data = await call(
        session,
        'GET',
        `Warehouses?$select=WarehouseCode,WarehouseName,Inactive&$orderby=WarehouseCode`
      );
      return (data.value || [])
        .filter((w) => w.Inactive !== 'tYES')
        .map((w) => ({ code: w.WarehouseCode, name: w.WarehouseName }));
    },

    /** Sucht einen Artikel über Artikelnummer, Haupt-Barcode oder zusätzliche Barcodes. */
    async lookupItem(session, code) {
      const direct = await getItem(session, code);
      if (direct) return direct;

      const byMain = await call(
        session,
        'GET',
        `Items?$select=ItemCode&$filter=BarCode eq ${odataString(code)}&$top=1`
      );
      if (byMain.value?.length) return getItem(session, byMain.value[0].ItemCode);

      const byExtra = await call(
        session,
        'GET',
        `BarCodes?$select=ItemNo&$filter=Barcode eq ${odataString(code)}&$top=1`
      );
      if (byExtra.value?.length) return getItem(session, byExtra.value[0].ItemNo);
      return null;
    },

    async findOrder(session, docNum) {
      const data = await call(
        session,
        'GET',
        `Orders?$select=DocEntry,DocNum,CardCode,CardName,DocDueDate,DocumentStatus,DocumentLines` +
          `&$filter=DocNum eq ${Number(docNum)}&$top=1`
      );
      const o = data.value?.[0];
      if (!o) return null;
      const lines = (o.DocumentLines || [])
        .filter((l) => l.LineStatus !== 'bost_Close' && Number(l.RemainingOpenQuantity) > 0)
        .map((l) => ({
          lineNum: l.LineNum,
          itemCode: l.ItemCode,
          itemName: l.ItemDescription,
          barcode: l.BarCode || null,
          openQty: Number(l.RemainingOpenQuantity),
          warehouse: l.WarehouseCode,
        }));
      return {
        docEntry: o.DocEntry,
        docNum: o.DocNum,
        cardCode: o.CardCode,
        cardName: o.CardName,
        dueDate: o.DocDueDate,
        open: o.DocumentStatus === 'bost_Open',
        lines,
      };
    },

    async postDelivery(session, { order, lines, comment }) {
      const doc = await call(session, 'POST', 'DeliveryNotes', {
        CardCode: order.cardCode,
        Comments: comment,
        DocumentLines: lines.map((l) => ({
          BaseType: 17, // Kundenauftrag
          BaseEntry: order.docEntry,
          BaseLine: l.lineNum,
          Quantity: l.quantity,
          WarehouseCode: l.warehouse,
        })),
      });
      return { docEntry: doc.DocEntry, docNum: doc.DocNum, type: 'Lieferung' };
    },

    async postGoodsIssue(session, { warehouse, lines, comment }) {
      const doc = await call(session, 'POST', 'InventoryGenExits', {
        Comments: comment,
        DocumentLines: lines.map((l) => ({
          ItemCode: l.itemCode,
          Quantity: l.quantity,
          WarehouseCode: warehouse,
        })),
      });
      return { docEntry: doc.DocEntry, docNum: doc.DocNum, type: 'Warenausgang' };
    },

    async postTransfer(session, { fromWarehouse, toWarehouse, lines, comment }) {
      const doc = await call(session, 'POST', 'StockTransfers', {
        FromWarehouse: fromWarehouse,
        ToWarehouse: toWarehouse,
        Comments: comment,
        StockTransferLines: lines.map((l) => ({
          ItemCode: l.itemCode,
          Quantity: l.quantity,
          FromWarehouseCode: fromWarehouse,
          WarehouseCode: toWarehouse,
        })),
      });
      return { docEntry: doc.DocEntry, docNum: doc.DocNum, type: 'Bestandsumlagerung' };
    },

    // Legt einen Inventurzählungs-Beleg an. Die Differenzbuchung (Inventurbuchung)
    // erfolgt bewusst erst nach Prüfung im SAP-Client.
    async postCounting(session, { warehouse, lines, comment }) {
      const doc = await call(session, 'POST', 'InventoryCountings', {
        CountDate: new Date().toISOString().slice(0, 10),
        Remarks: comment,
        InventoryCountingLines: lines.map((l) => ({
          ItemCode: l.itemCode,
          WarehouseCode: warehouse,
          CountedQuantity: l.quantity,
          Counted: 'tYES',
        })),
      });
      return { docEntry: doc.DocumentEntry, docNum: doc.DocumentNumber, type: 'Inventurzählung' };
    },
  };
}
