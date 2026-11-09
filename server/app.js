import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_LINES = 200;
const COOKIE = 'lsid';

export function createApp({ backend, sessionTtlMs = 8 * 60 * 60 * 1000, secureCookie = false, companyDb }) {
  const app = express();
  const sessions = new Map(); // Token -> { sl, user, company, lastUsed }

  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  // ---- Statische Dateien (PWA) --------------------------------------------
  app.use(express.static(path.join(root, 'public'), { index: 'index.html' }));
  app.get('/vendor/html5-qrcode.min.js', (_req, res) =>
    res.sendFile(path.join(root, 'node_modules/html5-qrcode/html5-qrcode.min.js'))
  );

  // ---- Sitzungen -----------------------------------------------------------
  const readToken = (req) =>
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .find(([k]) => k === COOKIE)?.[1];

  function auth(req, _res, next) {
    const token = readToken(req);
    const s = token && sessions.get(token);
    if (!s || Date.now() - s.lastUsed > sessionTtlMs) {
      if (token) sessions.delete(token);
      return next(new AppError(401, 'Nicht angemeldet.'));
    }
    s.lastUsed = Date.now();
    req.session = s;
    req.token = token;
    next();
  }

  // Wenn SAP die Sitzung beendet hat, auch unsere Sitzung verwerfen.
  const wrap = (fn) => async (req, res, next) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      if (err.status === 401 && req.token) sessions.delete(req.token);
      next(err);
    }
  };

  app.get('/api/config', (_req, res) => res.json({ mode: backend.mode, companyDb: companyDb || null }));

  app.post(
    '/api/login',
    wrap(async (req, res) => {
      const { userName, password } = req.body || {};
      const db = companyDb || req.body?.companyDb;
      if (!userName || !password || !db) throw new AppError(400, 'Benutzer, Passwort und Mandant sind erforderlich.');
      const sl = await backend.login({ companyDb: String(db), userName: String(userName), password: String(password) });
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { sl, user: String(userName), company: String(db), lastUsed: Date.now() });
      res.set(
        'Set-Cookie',
        `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs / 1000)}` +
          (secureCookie ? '; Secure' : '')
      );
      return { user: String(userName), company: String(db) };
    })
  );

  app.post(
    '/api/logout',
    auth,
    wrap(async (req, res) => {
      sessions.delete(req.token);
      await backend.logout(req.session.sl);
      res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return { ok: true };
    })
  );

  app.get('/api/me', auth, (req, res) => res.json({ user: req.session.user, company: req.session.company }));

  app.get('/api/warehouses', auth, wrap((req) => backend.warehouses(req.session.sl)));

  app.get(
    '/api/items/lookup',
    auth,
    wrap(async (req) => {
      const code = String(req.query.code || '').trim();
      if (!code) throw new AppError(400, 'Kein Code angegeben.');
      const item = await backend.lookupItem(req.session.sl, code);
      if (!item) throw new AppError(404, `Kein Artikel zu „${code}“ gefunden.`);
      return item;
    })
  );

  app.get(
    '/api/orders/:docNum',
    auth,
    wrap(async (req) => {
      const docNum = Number(req.params.docNum);
      if (!Number.isInteger(docNum) || docNum <= 0) throw new AppError(400, 'Ungültige Auftragsnummer.');
      const order = await backend.findOrder(req.session.sl, docNum);
      if (!order) throw new AppError(404, `Kundenauftrag ${docNum} nicht gefunden.`);
      if (!order.open) throw new AppError(400, `Kundenauftrag ${docNum} ist bereits abgeschlossen.`);
      return order;
    })
  );

  // ---- Buchungen -----------------------------------------------------------
  function parseLines(raw, { allowZero = false } = {}) {
    if (!Array.isArray(raw) || raw.length === 0) throw new AppError(400, 'Keine Positionen erfasst.');
    if (raw.length > MAX_LINES) throw new AppError(400, `Maximal ${MAX_LINES} Positionen pro Beleg.`);
    return raw.map((l, i) => {
      const quantity = Number(l?.quantity);
      if (!Number.isFinite(quantity) || quantity < 0 || (quantity === 0 && !allowZero)) {
        throw new AppError(400, `Position ${i + 1}: ungültige Menge.`);
      }
      const itemCode = String(l?.itemCode || '').trim();
      if (!itemCode) throw new AppError(400, `Position ${i + 1}: Artikel fehlt.`);
      return { itemCode, quantity };
    });
  }

  const requireWarehouse = (v, label) => {
    const w = String(v || '').trim();
    if (!w) throw new AppError(400, `${label} fehlt.`);
    return w;
  };

  const comment = (req, what) =>
    `${what} per Lager-Scanner-App (${req.session.user})${req.body?.comment ? ': ' + String(req.body.comment).slice(0, 200) : ''}`;

  // Chargen-/Seriennummernartikel brauchen zusätzliche Angaben, die v1 noch nicht erfasst.
  async function checkItems(sl, lines) {
    for (const code of new Set(lines.map((l) => l.itemCode))) {
      const item = await backend.lookupItem(sl, code);
      if (!item) throw new AppError(400, `Artikel ${code} existiert nicht.`);
      if (item.batchManaged || item.serialManaged) {
        throw new AppError(
          400,
          `Artikel ${code} ist chargen- oder seriennummernpflichtig – bitte im SAP-Client buchen.`
        );
      }
    }
  }

  app.post(
    '/api/goods-issue',
    auth,
    wrap(async (req) => {
      const warehouse = requireWarehouse(req.body?.warehouse, 'Lager');
      const lines = parseLines(req.body?.lines);
      await checkItems(req.session.sl, lines);
      return backend.postGoodsIssue(req.session.sl, { warehouse, lines, comment: comment(req, 'Warenausgang') });
    })
  );

  app.post(
    '/api/transfer',
    auth,
    wrap(async (req) => {
      const fromWarehouse = requireWarehouse(req.body?.fromWarehouse, 'Von-Lager');
      const toWarehouse = requireWarehouse(req.body?.toWarehouse, 'Nach-Lager');
      if (fromWarehouse === toWarehouse) throw new AppError(400, 'Von- und Nach-Lager sind identisch.');
      const lines = parseLines(req.body?.lines);
      await checkItems(req.session.sl, lines);
      return backend.postTransfer(req.session.sl, {
        fromWarehouse, toWarehouse, lines, comment: comment(req, 'Umlagerung'),
      });
    })
  );

  app.post(
    '/api/counting',
    auth,
    wrap(async (req) => {
      const warehouse = requireWarehouse(req.body?.warehouse, 'Lager');
      const lines = parseLines(req.body?.lines, { allowZero: true });
      await checkItems(req.session.sl, lines);
      return backend.postCounting(req.session.sl, { warehouse, lines, comment: comment(req, 'Inventur') });
    })
  );

  app.post(
    '/api/delivery',
    auth,
    wrap(async (req) => {
      const docNum = Number(req.body?.docNum);
      // Auftrag frisch aus SAP laden – Positionen/Artikel nicht vom Handy übernehmen.
      const order = await backend.findOrder(req.session.sl, docNum);
      if (!order || !order.open) throw new AppError(400, `Kundenauftrag ${docNum} ist nicht offen.`);
      const raw = req.body?.lines;
      if (!Array.isArray(raw) || raw.length === 0) throw new AppError(400, 'Keine Positionen kommissioniert.');
      const lines = raw
        .map((l) => {
          const ol = order.lines.find((x) => x.lineNum === Number(l?.lineNum));
          if (!ol) throw new AppError(400, `Auftragsposition ${l?.lineNum} ist nicht (mehr) offen.`);
          const quantity = Number(l.quantity);
          if (!Number.isFinite(quantity) || quantity < 0) throw new AppError(400, `Ungültige Menge bei ${ol.itemCode}.`);
          if (quantity > ol.openQty) throw new AppError(400, `${ol.itemCode}: mehr als offen (${ol.openQty}).`);
          return { lineNum: ol.lineNum, itemCode: ol.itemCode, quantity, warehouse: ol.warehouse };
        })
        .filter((l) => l.quantity > 0);
      if (!lines.length) throw new AppError(400, 'Keine Mengen kommissioniert.');
      await checkItems(req.session.sl, lines);
      return backend.postDelivery(req.session.sl, { order, lines, comment: comment(req, `Kommissionierung Auftrag ${docNum}`) });
    })
  );

  app.use('/api', (_req, _res, next) => next(new AppError(404, 'Unbekannter Endpunkt.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500 && !(err instanceof AppError)) console.error(err);
    res.status(status).json({ error: status >= 500 && !(err instanceof AppError) ? 'Interner Fehler' : err.message });
  });

  // Abgelaufene Sitzungen regelmäßig aufräumen.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [t, s] of sessions) if (now - s.lastUsed > sessionTtlMs) sessions.delete(t);
  }, 10 * 60 * 1000);
  timer.unref();

  return app;
}
