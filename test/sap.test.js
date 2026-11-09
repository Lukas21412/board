// Prüft den Service-Layer-Client gegen einen nachgebauten Service Layer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSapBackend, odataString } from '../server/sap.js';

let fake, sap;
const seen = [];

before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = decodeURIComponent(req.url);
      seen.push({ method: req.method, url, cookie: req.headers.cookie, body: body ? JSON.parse(body) : null });
      const json = (status, data, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      if (url === '/b1s/v1/Login') {
        const b = JSON.parse(body);
        if (b.Password !== 'geheim') return json(401, { error: { code: 100000027, message: { lang: 'en-us', value: 'Login failed' } } });
        return json(200, { SessionId: 'abc' }, { 'Set-Cookie': ['B1SESSION=abc; path=/b1s; HttpOnly', 'ROUTEID=.node1; path=/b1s'] });
      }
      if (req.headers.cookie !== 'B1SESSION=abc; ROUTEID=.node1') return json(401, { error: { message: { value: 'Invalid session' } } });
      if (url.startsWith("/b1s/v1/Items('4006381333931')")) return json(404, { error: { message: { value: 'No matching records found' } } });
      if (url.startsWith("/b1s/v1/Items?") && url.includes("BarCode eq '4006381333931'")) return json(200, { value: [{ ItemCode: 'A1000' }] });
      if (url.startsWith("/b1s/v1/Items('A1000')")) {
        return json(200, {
          ItemCode: 'A1000', ItemName: 'Schraube', BarCode: '4006381333931', InventoryUOM: 'Stk',
          ManageBatchNumbers: 'tNO', ManageSerialNumbers: 'tNO', InventoryItem: 'tYES', Valid: 'tYES',
          ItemWarehouseInfoCollection: [
            { WarehouseCode: '01', InStock: 10, Committed: 2, Ordered: 0 },
            { WarehouseCode: '02', InStock: 0, Committed: 0, Ordered: 0 },
          ],
        });
      }
      if (url.startsWith('/b1s/v1/StockTransfers')) {
        return json(400, { error: { code: -10, message: { lang: 'en-us', value: 'Quantity falls into negative inventory' } } });
      }
      if (url.startsWith('/b1s/v1/DeliveryNotes')) return json(201, { DocEntry: 77, DocNum: 4711 });
      json(404, { error: { message: { value: 'not found' } } });
    });
  }).listen(0);
  await new Promise((r) => fake.once('listening', r));
  sap = createSapBackend({ baseUrl: `http://127.0.0.1:${fake.address().port}/b1s/v1` });
});
after(() => fake.close());

test('odataString maskiert Hochkommas', () => {
  assert.equal(odataString("O'Neil"), "'O''Neil'");
});

test('Login: falsches Passwort und Erfolg', async () => {
  await assert.rejects(sap.login({ companyDb: 'X', userName: 'u', password: 'falsch' }), { status: 401 });
  const s = await sap.login({ companyDb: 'X', userName: 'u', password: 'geheim' });
  assert.equal(s.cookie, 'B1SESSION=abc; ROUTEID=.node1');
});

test('Barcode-Suche fällt auf Items-Filter zurück und mappt Bestand', async () => {
  const s = { cookie: 'B1SESSION=abc; ROUTEID=.node1' };
  const item = await sap.lookupItem(s, '4006381333931');
  assert.equal(item.itemCode, 'A1000');
  assert.deepEqual(item.stock, [{ warehouse: '01', inStock: 10, committed: 2, ordered: 0 }]);
  assert.equal(item.batchManaged, false);
});

test('SAP-Fehlermeldung wird durchgereicht', async () => {
  const s = { cookie: 'B1SESSION=abc; ROUTEID=.node1' };
  await assert.rejects(
    sap.postTransfer(s, { fromWarehouse: '01', toWarehouse: '02', lines: [{ itemCode: 'A1000', quantity: 99 }], comment: 'x' }),
    { status: 400, message: 'Quantity falls into negative inventory' }
  );
  const sent = seen.find((r) => r.url.startsWith('/b1s/v1/StockTransfers')).body;
  assert.deepEqual(sent.StockTransferLines, [{ ItemCode: 'A1000', Quantity: 99, FromWarehouseCode: '01', WarehouseCode: '02' }]);
});

test('Lieferung referenziert den Kundenauftrag', async () => {
  const s = { cookie: 'B1SESSION=abc; ROUTEID=.node1' };
  const res = await sap.postDelivery(s, {
    order: { docEntry: 501, cardCode: 'K1' }, lines: [{ lineNum: 2, quantity: 3, warehouse: '01' }], comment: 'c',
  });
  assert.deepEqual(res, { docEntry: 77, docNum: 4711, type: 'Lieferung' });
  const sent = seen.find((r) => r.url.startsWith('/b1s/v1/DeliveryNotes')).body;
  assert.deepEqual(sent.DocumentLines, [{ BaseType: 17, BaseEntry: 501, BaseLine: 2, Quantity: 3, WarehouseCode: '01' }]);
});

test('abgelaufene Sitzung ergibt 401', async () => {
  await assert.rejects(sap.warehouses({ cookie: 'B1SESSION=alt' }), { status: 401 });
});
