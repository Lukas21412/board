// Lager-Scanner – Frontend (ohne Build-Schritt, läuft direkt im Handy-Browser)

const $view = document.getElementById('view');
const $title = document.getElementById('title');
const $back = document.getElementById('back');
const $logout = document.getElementById('logout');
const $mode = document.getElementById('mode');
const $toast = document.getElementById('toast');

const state = { config: null, user: null, warehouses: [] };

// ---------------------------------------------------------------- Hilfsfunktionen
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const store = {
  get(k, d = null) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* egal */ } },
};

let toastTimer;
function toast(msg, kind = 'info') {
  $toast.textContent = msg;
  $toast.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.className = ''), kind === 'err' ? 5000 : 2500);
}

let audio;
function feedback(ok = true) {
  try {
    navigator.vibrate?.(ok ? 60 : [80, 60, 80]);
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = ok ? 1800 : 300;
    g.gain.value = 0.15;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.08 : 0.3));
  } catch { /* kein Ton möglich */ }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new HttpError(0, 'Keine Verbindung zum Server (WLAN prüfen).');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    state.user = null;
    go('login');
  }
  if (!res.ok) throw new HttpError(res.status, data.error || `Fehler ${res.status}`);
  return data;
}

const fmt = (n) => Number(n).toLocaleString('de-DE', { maximumFractionDigits: 3 });
const whName = (code) => state.warehouses.find((w) => w.code === code)?.name || '';

// ---------------------------------------------------------------- Kamera-Scanner
const $scanner = document.getElementById('scanner');
let qr = null;

async function closeCamera() {
  $scanner.hidden = true;
  if (qr) {
    try { if (qr.isScanning) await qr.stop(); qr.clear(); } catch { /* ignorieren */ }
    qr = null;
  }
}
document.getElementById('scanner-close').addEventListener('click', closeCamera);

async function openCamera(onCode) {
  if (!window.Html5Qrcode) return toast('Kamera-Scanner nicht geladen.', 'err');
  if (!window.isSecureContext) {
    return toast('Kamera braucht HTTPS. Bitte App über https:// öffnen oder Handscanner/Tastatur nutzen.', 'err');
  }
  $scanner.hidden = false;
  qr = new Html5Qrcode('reader', { verbose: false });
  let handled = false;
  try {
    await qr.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: (w, hgt) => ({ width: Math.min(w, 400) * 0.9, height: Math.min(hgt, 400) * 0.5 }) },
      async (text) => {
        if (handled) return;
        handled = true;
        await closeCamera();
        onCode(text.trim());
      },
      () => {}
    );
  } catch (e) {
    await closeCamera();
    toast(`Kamera nicht verfügbar: ${e?.message || e}`, 'err');
  }
}

/**
 * Eingabefeld für Scans. Funktioniert mit
 *  - Kamera (Knopf rechts),
 *  - Bluetooth-/Hardware-Scannern im Tastaturmodus (senden Code + Enter),
 *  - manueller Eingabe.
 */
function scanField({ placeholder, onCode, inputmode = 'text', autofocus = true }) {
  const input = h('input', {
    type: 'text', placeholder, inputmode, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
  });
  let busy = false;
  const submit = async (code) => {
    if (!code || busy) return;
    busy = true;
    input.value = '';
    try { await onCode(code); } finally { busy = false; input.focus({ preventScroll: true }); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(input.value.trim()); }
  });
  const cam = h('button', { class: 'cam-btn', type: 'button', 'aria-label': 'Mit Kamera scannen', onclick: () => openCamera(submit) }, '📷');
  if (autofocus) setTimeout(() => input.focus({ preventScroll: true }), 50);
  return h('div', { class: 'scanrow' }, input, cam);
}

function warehouseSelect(key, label) {
  const sel = h('select', { 'aria-label': label },
    state.warehouses.map((w) => h('option', { value: w.code }, `${w.code} – ${w.name}`)));
  const saved = store.get(key);
  if (saved && state.warehouses.some((w) => w.code === saved)) sel.value = saved;
  sel.addEventListener('change', () => store.set(key, sel.value));
  return sel;
}

async function lookup(code) {
  try {
    return await api('GET', `/api/items/lookup?code=${encodeURIComponent(code)}`);
  } catch (e) {
    feedback(false);
    toast(e.message, 'err');
    return null;
  }
}

// ---------------------------------------------------------------- Routing
const routes = {};
let leaveGuard = null;

function go(name) {
  if (location.hash !== `#${name}`) location.hash = name;
  else render();
}

async function render() {
  await closeCamera();
  const name = location.hash.slice(1) || 'home';
  const route = routes[name] && (state.user || name === 'login') ? name : state.user ? 'home' : 'login';
  leaveGuard = null;
  $back.hidden = route === 'home' || route === 'login';
  $logout.hidden = !state.user;
  $view.replaceChildren();
  routes[route]();
}

window.addEventListener('hashchange', (e) => {
  if (leaveGuard && !leaveGuard()) {
    history.replaceState(null, '', new URL(e.oldURL).hash);
    return;
  }
  render();
});
$back.addEventListener('click', () => go('home'));
$logout.addEventListener('click', async () => {
  if (!confirm('Abmelden?')) return;
  await api('POST', '/api/logout').catch(() => {});
  state.user = null;
  go('login');
});

// ---------------------------------------------------------------- Ansichten
routes.login = () => {
  $title.textContent = 'Anmelden';
  const user = h('input', { autocomplete: 'username', value: store.get('lastUser', '') });
  const pass = h('input', { type: 'password', autocomplete: 'current-password' });
  const company = state.config.companyDb ? null : h('input', { value: store.get('lastCompany', ''), autocapitalize: 'characters' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Anmelden');

  const form = h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const res = await api('POST', '/api/login', {
          userName: user.value.trim(), password: pass.value, companyDb: company?.value.trim(),
        });
        store.set('lastUser', user.value.trim());
        if (company) store.set('lastCompany', company.value.trim());
        state.user = res;
        state.warehouses = await api('GET', '/api/warehouses');
        location.hash = 'home';
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    },
  },
  h('h2', {}, 'SAP Business One'),
  state.config.mode === 'mock' ? h('p', { class: 'warn small' }, 'Demo-Modus: beliebiger Benutzer/Passwort, Testdaten. Nichts wird in SAP gebucht.') : null,
  company ? [h('label', {}, 'Mandant (Datenbank)'), company] : h('p', { class: 'muted small' }, `Mandant: ${state.config.companyDb}`),
  h('label', {}, 'SAP-Benutzer'), user,
  h('label', {}, 'Passwort'), pass,
  btn);
  $view.append(form);
  (user.value ? pass : user).focus();
};

routes.home = () => {
  $title.textContent = 'Lager-Scanner';
  const tile = (route, ico, title, sub) =>
    h('button', { class: 'tile', onclick: () => go(route) }, h('span', { class: 'ico' }, ico), h('span', {}, title, h('small', {}, sub)));
  $view.append(
    h('p', { class: 'muted small' }, `${state.user.user} · ${state.user.company}`),
    h('div', { class: 'tiles' },
      tile('stock', '🔍', 'Bestand', 'Artikel scannen, Bestand je Lager'),
      tile('pick', '📦', 'Kommissionieren', 'Kundenauftrag → Lieferung'),
      tile('issue', '📤', 'Warenausgang', 'Freie Entnahme aus Lager'),
      tile('transfer', '🔁', 'Umlagern', 'Von Lager A nach B'),
      tile('count', '📋', 'Inventur', 'Zählung erfassen')
    )
  );
};

routes.stock = () => {
  $title.textContent = 'Bestand';
  const result = h('div');
  const show = async (code) => {
    const item = await lookup(code);
    if (!item) return;
    feedback(true);
    const total = item.stock.reduce((s, w) => s + w.inStock, 0);
    result.replaceChildren(
      h('div', { class: 'card' },
        h('h2', {}, item.itemCode),
        h('div', {}, item.itemName),
        h('div', { class: 'muted small' }, `Barcode: ${item.barcode || '–'} · Einheit: ${item.uom || '–'}`),
        item.batchManaged || item.serialManaged ? h('div', { class: 'warn small' }, 'Chargen-/Seriennummernartikel – Buchung nur im SAP-Client.') : null,
        !item.active ? h('div', { class: 'warn small' }, 'Artikel ist inaktiv.') : null,
        h('table', { class: 'stock' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Lager'), h('th', {}, 'Bestand'), h('th', {}, 'Reserviert'), h('th', {}, 'Verfügbar'))),
          h('tbody', {},
            item.stock.length
              ? item.stock.map((w) => h('tr', {},
                  h('td', {}, `${w.warehouse} ${whName(w.warehouse)}`),
                  h('td', {}, fmt(w.inStock)),
                  h('td', {}, fmt(w.committed)),
                  h('td', {}, h('b', {}, fmt(w.inStock - w.committed)))))
              : h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'Kein Bestand'))),
          h('tfoot', {}, h('tr', {}, h('th', {}, 'Gesamt'), h('th', {}, fmt(total)), h('th'), h('th'))))
      )
    );
  };
  $view.append(h('div', { class: 'card' }, h('label', {}, 'Artikel oder Barcode scannen'), scanField({ placeholder: 'Scannen…', onCode: show })), result);
};

/**
 * Gemeinsame Scan-Liste für Warenausgang, Umlagerung und Inventur.
 * Jeder Scan erhöht die Menge um 1, Mengen sind auch per Tastatur änderbar.
 * Der Entwurf wird lokal gespeichert, damit bei WLAN-Abbruch nichts verloren geht.
 */
function scanListView({ key, title, header, submitLabel, submit, zeroAllowed = false }) {
  $title.textContent = title;
  const draftKey = `draft:${key}`;
  let lines = store.get(draftKey, []);
  const save = () => (lines.length ? store.set(draftKey, lines) : store.del(draftKey));
  const list = h('ul', { class: 'list' });
  const count = h('span', { class: 'muted small' });
  const btn = h('button', { class: 'btn btn-ok', type: 'button' }, submitLabel);

  leaveGuard = () => !lines.length || confirm('Erfasste Positionen bleiben als Entwurf gespeichert. Trotzdem verlassen?');

  function draw() {
    count.textContent = lines.length ? `${lines.length} Position(en)` : 'Noch nichts gescannt';
    btn.disabled = !lines.length;
    list.replaceChildren(...lines.map((l, i) => {
      const qty = h('input', { class: 'qty', type: 'number', inputmode: 'decimal', min: zeroAllowed ? '0' : '0.001', step: 'any', value: l.quantity });
      qty.addEventListener('change', () => { l.quantity = Number(qty.value); save(); });
      return h('li', {},
        h('div', { class: 'info' }, h('div', { class: 'code' }, l.itemCode), h('div', { class: 'name' }, l.itemName)),
        qty,
        h('button', { class: 'del', type: 'button', 'aria-label': 'Entfernen', onclick: () => { lines.splice(i, 1); save(); draw(); } }, '✕'));
    }));
  }

  async function onCode(code) {
    const item = await lookup(code);
    if (!item) return;
    if (item.batchManaged || item.serialManaged) {
      feedback(false);
      return toast(`${item.itemCode} ist chargen-/seriennummernpflichtig – bitte im SAP-Client buchen.`, 'err');
    }
    const existing = lines.find((l) => l.itemCode === item.itemCode);
    if (existing) {
      existing.quantity = Number(existing.quantity) + 1;
      lines.splice(lines.indexOf(existing), 1);
      lines.unshift(existing);
    } else {
      lines.unshift({ itemCode: item.itemCode, itemName: item.itemName, quantity: 1 });
    }
    feedback(true);
    toast(`${item.itemCode} · Menge ${fmt(lines[0].quantity)}`, 'ok');
    save();
    draw();
  }

  btn.addEventListener('click', async () => {
    const bad = lines.find((l) => !Number.isFinite(Number(l.quantity)) || Number(l.quantity) < 0 || (!zeroAllowed && Number(l.quantity) === 0));
    if (bad) return toast(`Ungültige Menge bei ${bad.itemCode}`, 'err');
    if (!confirm(`${lines.length} Position(en) jetzt in SAP buchen?`)) return;
    btn.disabled = true;
    try {
      const res = await submit(lines.map((l) => ({ itemCode: l.itemCode, quantity: Number(l.quantity) })));
      feedback(true);
      toast(`${res.type} ${res.docNum} gebucht ✔`, 'ok');
      lines = [];
      save();
      draw();
    } catch (e) {
      feedback(false);
      toast(e.message, 'err');
      btn.disabled = false;
    }
  });

  $view.append(
    h('div', { class: 'card' }, header, h('label', {}, 'Artikel scannen'), scanField({ placeholder: 'Scannen…', onCode })),
    h('div', { class: 'card' }, count, list, btn,
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { if (lines.length && confirm('Alle Positionen verwerfen?')) { lines = []; save(); draw(); } } }, 'Liste leeren'))
  );
  draw();
}

routes.issue = () => {
  const wh = warehouseSelect('wh:issue', 'Lager');
  const note = h('input', { placeholder: 'z. B. Kostenstelle, Auftrag, Grund' });
  scanListView({
    key: 'issue', title: 'Warenausgang', submitLabel: 'Warenausgang buchen',
    header: [h('label', {}, 'Aus Lager'), wh, h('label', {}, 'Bemerkung (optional)'), note],
    submit: (lines) => api('POST', '/api/goods-issue', { warehouse: wh.value, lines, comment: note.value.trim() }),
  });
};

routes.transfer = () => {
  const from = warehouseSelect('wh:from', 'Von Lager');
  const to = warehouseSelect('wh:to', 'Nach Lager');
  scanListView({
    key: 'transfer', title: 'Umlagern', submitLabel: 'Umlagerung buchen',
    header: h('div', { class: 'row2' }, h('div', {}, h('label', {}, 'Von Lager'), from), h('div', {}, h('label', {}, 'Nach Lager'), to)),
    submit: (lines) => {
      if (from.value === to.value) throw new Error('Von- und Nach-Lager sind gleich.');
      return api('POST', '/api/transfer', { fromWarehouse: from.value, toWarehouse: to.value, lines });
    },
  });
};

routes.count = () => {
  const wh = warehouseSelect('wh:count', 'Lager');
  scanListView({
    key: 'count', title: 'Inventur', submitLabel: 'Zählung an SAP senden', zeroAllowed: true,
    header: [h('label', {}, 'Lager'), wh,
      h('p', { class: 'muted small' }, 'Legt einen Inventurzählungs-Beleg an. Die Differenzbuchung erfolgt nach Prüfung im SAP-Client.')],
    submit: (lines) => api('POST', '/api/counting', { warehouse: wh.value, lines }),
  });
};

routes.pick = () => {
  $title.textContent = 'Kommissionieren';
  const body = h('div');
  let order = null;
  let picked = {}; // lineNum -> Menge

  leaveGuard = () => !order || !Object.values(picked).some((q) => q > 0) || confirm('Kommissionierung abbrechen?');

  const loadOrder = async (code) => {
    const docNum = code.replace(/\D/g, '');
    if (!docNum) return toast('Bitte Auftragsnummer scannen.', 'err');
    try {
      order = await api('GET', `/api/orders/${docNum}`);
      picked = store.get(`pick:${order.docNum}`, {});
      feedback(true);
      drawOrder();
    } catch (e) {
      feedback(false);
      toast(e.message, 'err');
    }
  };

  const savePick = () => store.set(`pick:${order.docNum}`, picked);

  async function onItem(code) {
    let line = order.lines.find((l) => (l.barcode && l.barcode === code) || l.itemCode.toUpperCase() === code.toUpperCase());
    if (!line) {
      const item = await lookup(code);
      if (!item) return;
      line = order.lines.find((l) => l.itemCode === item.itemCode);
      if (!line) { feedback(false); return toast(`${item.itemCode} ist nicht in Auftrag ${order.docNum}.`, 'err'); }
    }
    // Bei mehreren Positionen mit gleichem Artikel die erste noch offene nehmen.
    const candidates = order.lines.filter((l) => l.itemCode === line.itemCode);
    const target = candidates.find((l) => (picked[l.lineNum] || 0) < l.openQty) || line;
    const now = (picked[target.lineNum] || 0) + 1;
    if (now > target.openQty) { feedback(false); return toast(`${target.itemCode}: bereits vollständig (${fmt(target.openQty)}).`, 'err'); }
    picked[target.lineNum] = now;
    savePick();
    feedback(true);
    toast(`${target.itemCode}: ${fmt(now)} / ${fmt(target.openQty)}`, 'ok');
    drawOrder();
  }

  function drawOrder() {
    const allDone = order.lines.every((l) => (picked[l.lineNum] || 0) >= l.openQty);
    const any = order.lines.some((l) => (picked[l.lineNum] || 0) > 0);
    const btn = h('button', { class: 'btn btn-ok', type: 'button', disabled: !any }, allDone ? 'Lieferung buchen' : 'Teillieferung buchen');
    btn.addEventListener('click', async () => {
      const lines = order.lines
        .filter((l) => (picked[l.lineNum] || 0) > 0)
        .map((l) => ({ lineNum: l.lineNum, quantity: picked[l.lineNum] }));
      if (!confirm(`${allDone ? 'Lieferung' : 'TEILLIEFERUNG'} für Auftrag ${order.docNum} buchen?`)) return;
      btn.disabled = true;
      try {
        const res = await api('POST', '/api/delivery', { docNum: order.docNum, lines });
        store.del(`pick:${order.docNum}`);
        feedback(true);
        toast(`${res.type} ${res.docNum} gebucht ✔`, 'ok');
        order = null;
        picked = {};
        drawStart();
      } catch (e) {
        feedback(false);
        toast(e.message, 'err');
        btn.disabled = false;
      }
    });

    body.replaceChildren(
      h('div', { class: 'card' },
        h('h2', {}, `Auftrag ${order.docNum}`),
        h('div', {}, `${order.cardCode} · ${order.cardName}`),
        h('div', { class: 'muted small' }, `Liefertermin: ${order.dueDate ? new Date(order.dueDate).toLocaleDateString('de-DE') : '–'}`),
        h('label', {}, 'Artikel scannen'),
        scanField({ placeholder: 'Scannen…', onCode: onItem })),
      h('div', { class: 'card' },
        h('ul', { class: 'list' }, order.lines.map((l) => {
          const q = picked[l.lineNum] || 0;
          const qty = h('input', { class: 'qty', type: 'number', inputmode: 'decimal', min: '0', max: l.openQty, step: 'any', value: q });
          qty.addEventListener('change', () => {
            const v = Math.max(0, Math.min(Number(qty.value) || 0, l.openQty));
            picked[l.lineNum] = v;
            savePick();
            drawOrder();
          });
          return h('li', { class: q >= l.openQty ? 'done' : '' },
            h('div', { class: 'info' },
              h('div', { class: 'code' }, l.itemCode, h('span', { class: 'muted small' }, `  Lager ${l.warehouse}`)),
              h('div', { class: 'name' }, l.itemName)),
            qty,
            h('span', { class: `pickstate ${q >= l.openQty ? 'full' : q > 0 ? 'part' : ''}` }, `/ ${fmt(l.openQty)}`));
        })),
        btn,
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { if (leaveGuard()) { order = null; picked = {}; drawStart(); } } }, 'Anderer Auftrag'))
    );
  }

  function drawStart() {
    body.replaceChildren(h('div', { class: 'card' },
      h('label', {}, 'Kundenauftrag scannen oder Nummer eingeben'),
      scanField({ placeholder: 'Auftragsnummer…', inputmode: 'numeric', onCode: loadOrder })));
  }

  $view.append(body);
  drawStart();
};

// ---------------------------------------------------------------- Start
(async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    state.config = await api('GET', '/api/config');
  } catch (e) {
    $view.append(h('div', { class: 'card' }, h('h2', {}, 'Server nicht erreichbar'), h('p', {}, e.message)));
    return;
  }
  $mode.hidden = state.config.mode !== 'mock';
  try {
    state.user = await api('GET', '/api/me');
    state.warehouses = await api('GET', '/api/warehouses');
  } catch {
    state.user = null;
  }
  render();
})();
