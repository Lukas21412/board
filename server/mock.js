// Demo-Backend mit Testdaten. Verhält sich wie der Service Layer (inkl. Bestandsprüfung),
// damit die App ohne SAP-Zugang ausprobiert werden kann. Daten liegen nur im Speicher.

import { AppError } from './errors.js';

function seed() {
  const items = [
    { itemCode: 'A1000', itemName: 'Sechskantschraube M8x40 verzinkt', barcode: '4006381333931', uom: 'Stk' },
    { itemCode: 'A1001', itemName: 'Unterlegscheibe M8 DIN 125', barcode: '4006381333948', uom: 'Stk' },
    { itemCode: 'B2000', itemName: 'Kabelbinder 200 mm schwarz (100er)', barcode: '4012345678901', uom: 'Pck' },
    { itemCode: 'C3000', itemName: 'Palette Stretchfolie 500 mm', barcode: '4098765432109', uom: 'Rolle' },
    { itemCode: 'D4000', itemName: 'Hydraulikzylinder HZ-50 (Charge)', barcode: '4011111111116', uom: 'Stk', batchManaged: true },
  ].map((i) => ({ batchManaged: false, serialManaged: false, inventoryItem: true, active: true, ...i }));

  const stock = {
    A1000: { '01': 1200, '02': 300 },
    A1001: { '01': 5000 },
    B2000: { '01': 40, '02': 12 },
    C3000: { '02': 18 },
    D4000: { '01': 6 },
  };

  const orders = [
    {
      docEntry: 501, docNum: 10001, cardCode: 'K10000', cardName: 'Muster Maschinenbau GmbH',
      dueDate: new Date().toISOString().slice(0, 10), open: true,
      lines: [
        { lineNum: 0, itemCode: 'A1000', openQty: 50, warehouse: '01' },
        { lineNum: 1, itemCode: 'A1001', openQty: 50, warehouse: '01' },
        { lineNum: 2, itemCode: 'B2000', openQty: 2, warehouse: '01' },
      ],
    },
  ];

  return { items, stock, orders, nextDoc: 900 };
}

export function createMockBackend() {
  let db = seed();

  const find = (code) =>
    db.items.find((i) => i.itemCode.toUpperCase() === String(code).toUpperCase() || i.barcode === code);

  const view = (item) => ({
    ...item,
    stock: Object.entries(db.stock[item.itemCode] || {}).map(([warehouse, inStock]) => ({
      warehouse, inStock, committed: 0, ordered: 0,
    })),
  });

  function take(itemCode, warehouse, qty) {
    const have = db.stock[itemCode]?.[warehouse] || 0;
    if (have < qty) {
      throw new AppError(400, `Zu wenig Bestand: ${itemCode} in Lager ${warehouse} hat ${have}, benötigt ${qty}.`);
    }
  }
  const add = (itemCode, warehouse, qty) => {
    db.stock[itemCode] ??= {};
    db.stock[itemCode][warehouse] = (db.stock[itemCode][warehouse] || 0) + qty;
  };
  const docNo = () => ++db.nextDoc;

  return {
    mode: 'mock',
    reset() {
      db = seed();
    },

    async login({ companyDb, userName, password }) {
      if (!userName || !password) throw new AppError(401, 'Anmeldung fehlgeschlagen: Benutzer oder Passwort fehlt.');
      return { cookie: 'mock', userName, companyDb: companyDb || 'DEMO' };
    },
    async logout() {},

    async warehouses() {
      return [
        { code: '01', name: 'Hauptlager' },
        { code: '02', name: 'Außenlager' },
        { code: '03', name: 'Sperrlager' },
      ];
    },

    async lookupItem(_s, code) {
      const item = find(code);
      return item ? view(item) : null;
    },

    async findOrder(_s, docNum) {
      const o = db.orders.find((x) => x.docNum === Number(docNum));
      if (!o) return null;
      return {
        ...o,
        lines: o.lines
          .filter((l) => l.openQty > 0)
          .map((l) => {
            const it = find(l.itemCode);
            return { ...l, itemName: it.itemName, barcode: it.barcode };
          }),
      };
    },

    async postDelivery(_s, { order, lines }) {
      const o = db.orders.find((x) => x.docEntry === order.docEntry);
      for (const l of lines) {
        const ol = o?.lines.find((x) => x.lineNum === l.lineNum);
        if (!ol) throw new AppError(400, `Auftragsposition ${l.lineNum} nicht gefunden.`);
        if (l.quantity > ol.openQty) throw new AppError(400, `Menge für ${ol.itemCode} größer als offene Menge (${ol.openQty}).`);
        take(ol.itemCode, l.warehouse, l.quantity);
      }
      for (const l of lines) {
        const ol = o.lines.find((x) => x.lineNum === l.lineNum);
        ol.openQty -= l.quantity;
        add(ol.itemCode, l.warehouse, -l.quantity);
      }
      return { docEntry: docNo(), docNum: db.nextDoc, type: 'Lieferung' };
    },

    async postGoodsIssue(_s, { warehouse, lines }) {
      lines.forEach((l) => take(l.itemCode, warehouse, l.quantity));
      lines.forEach((l) => add(l.itemCode, warehouse, -l.quantity));
      return { docEntry: docNo(), docNum: db.nextDoc, type: 'Warenausgang' };
    },

    async postTransfer(_s, { fromWarehouse, toWarehouse, lines }) {
      lines.forEach((l) => take(l.itemCode, fromWarehouse, l.quantity));
      lines.forEach((l) => {
        add(l.itemCode, fromWarehouse, -l.quantity);
        add(l.itemCode, toWarehouse, l.quantity);
      });
      return { docEntry: docNo(), docNum: db.nextDoc, type: 'Bestandsumlagerung' };
    },

    async postCounting() {
      return { docEntry: docNo(), docNum: db.nextDoc, type: 'Inventurzählung' };
    },
  };
}
