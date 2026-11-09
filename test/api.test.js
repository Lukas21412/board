import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createMockBackend } from '../server/mock.js';

let server, base, cookie;
const backend = createMockBackend();

async function call(method, path, body, withCookie = true) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(withCookie && cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

before(async () => {
  server = createApp({ backend }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await call('POST', '/api/login', { userName: 'lager1', password: 'x', companyDb: 'DEMO' }, false);
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
});
after(() => server.close());

test('ohne Anmeldung kein Zugriff', async () => {
  const res = await call('GET', '/api/warehouses', null, false);
  assert.equal(res.status, 401);
});

test('Artikel per Barcode und Artikelnummer finden', async () => {
  const a = await call('GET', '/api/items/lookup?code=4006381333931');
  assert.equal(a.body.itemCode, 'A1000');
  const b = await call('GET', '/api/items/lookup?code=a1000');
  assert.equal(b.body.itemCode, 'A1000');
  const c = await call('GET', '/api/items/lookup?code=nix');
  assert.equal(c.status, 404);
});

test('Umlagerung bucht Bestand um und prüft Bestand', async () => {
  const ok = await call('POST', '/api/transfer', { fromWarehouse: '02', toWarehouse: '01', lines: [{ itemCode: 'C3000', quantity: 8 }] });
  assert.equal(ok.status, 200);
  const item = (await call('GET', '/api/items/lookup?code=C3000')).body;
  assert.deepEqual(item.stock.map((s) => [s.warehouse, s.inStock]).sort(), [['01', 8], ['02', 10]]);
  const tooMuch = await call('POST', '/api/transfer', { fromWarehouse: '02', toWarehouse: '01', lines: [{ itemCode: 'C3000', quantity: 99 }] });
  assert.equal(tooMuch.status, 400);
  const same = await call('POST', '/api/transfer', { fromWarehouse: '01', toWarehouse: '01', lines: [{ itemCode: 'C3000', quantity: 1 }] });
  assert.equal(same.status, 400);
});

test('Chargenartikel werden abgelehnt', async () => {
  const res = await call('POST', '/api/goods-issue', { warehouse: '01', lines: [{ itemCode: 'D4000', quantity: 1 }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /chargen/);
});

test('Warenausgang validiert Mengen', async () => {
  const zero = await call('POST', '/api/goods-issue', { warehouse: '01', lines: [{ itemCode: 'A1000', quantity: 0 }] });
  assert.equal(zero.status, 400);
  const ok = await call('POST', '/api/goods-issue', { warehouse: '01', lines: [{ itemCode: 'A1000', quantity: 10 }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.type, 'Warenausgang');
});

test('Inventur erlaubt Menge 0', async () => {
  const res = await call('POST', '/api/counting', { warehouse: '01', lines: [{ itemCode: 'A1001', quantity: 0 }] });
  assert.equal(res.status, 200);
});

test('Kommissionierung: Teillieferung und Übermenge', async () => {
  const order = (await call('GET', '/api/orders/10001')).body;
  assert.equal(order.lines.length, 3);
  const over = await call('POST', '/api/delivery', { docNum: 10001, lines: [{ lineNum: 0, quantity: 51 }] });
  assert.equal(over.status, 400);
  const part = await call('POST', '/api/delivery', { docNum: 10001, lines: [{ lineNum: 0, quantity: 50 }, { lineNum: 2, quantity: 1 }] });
  assert.equal(part.status, 200);
  const rest = (await call('GET', '/api/orders/10001')).body;
  assert.deepEqual(rest.lines.map((l) => [l.lineNum, l.openQty]), [[1, 50], [2, 1]]);
  const missing = await call('GET', '/api/orders/99999');
  assert.equal(missing.status, 404);
});

test('Abmelden beendet die Sitzung', async () => {
  const res = await call('POST', '/api/logout');
  assert.equal(res.status, 200);
  assert.equal((await call('GET', '/api/me')).status, 401);
});
