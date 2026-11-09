import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { createApp } from './app.js';
import { createSapBackend } from './sap.js';
import { createMockBackend } from './mock.js';

const env = process.env;
const port = Number(env.PORT || 3000);
const useMock = env.MOCK === '1' || !env.SAP_SL_URL;

const backend = useMock
  ? createMockBackend()
  : createSapBackend({ baseUrl: env.SAP_SL_URL, caFile: env.SAP_SL_CA || undefined });

const tls = env.TLS_CERT && env.TLS_KEY;
const app = createApp({
  backend,
  companyDb: env.SAP_COMPANY_DB || undefined,
  secureCookie: Boolean(tls) || env.BEHIND_HTTPS_PROXY === '1',
});

const server = tls
  ? https.createServer({ cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) }, app)
  : http.createServer(app);

server.listen(port, () => {
  console.log(`Lager-Scanner läuft auf ${tls ? 'https' : 'http'}://localhost:${port}`);
  console.log(useMock ? 'Modus: DEMO (Testdaten, keine SAP-Verbindung)' : `Modus: SAP Service Layer ${env.SAP_SL_URL}`);
  if (!tls) console.log('Hinweis: Die Handykamera funktioniert nur über HTTPS (siehe README).');
});
