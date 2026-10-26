// Rückmeldung 2026-10-26: Die KK-Abrechnungs-Auswahl im Pool zeigte "#2 image002.png" — die Nummer
// stand nirgends sonst, und der Name war der eines Bild-Anhangs statt der Rechnungs-PDF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { createKreditkarte } from '../../src/db/kreditkartenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createPoolPageRouter } from '../../src/routes/poolPage.js';
import { createApp } from '../../src/app.js';
import { belegName } from '../../src/services/belegName.js';

function poolApp(db, ansicht) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.locals.belegName = belegName;
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    res.locals.csrfToken = 'tok';
    res.locals.ansicht = ansicht;
    req.session = { personId: '50' };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 's', publicBaseUrl: 'https://portal.example.org' };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/pool', requireLogin(), createPoolPageRouter({ db, config, mailer: { async sendMail() {} }, csrfProtection: (q, r, n) => n() }));
  return app;
}

function seed() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '50', vorname: 'Buch', nachname: 'Halter', email: '50@example.org', gruppen: ['10'], loggedInNow: true });
  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  createKreditkarte(db, { bezeichnung: 'Visa', karteEndziffern: '4242', karteninhaberName: 'Anna', verantwortlichId: '50', erfassungOffen: true });
  const mitPdf = createJob(db, { eingangAm: '2026-10-23T11:10:00.000Z', quelle: 'lieferant', absender: 'a@example.org', dateiname: 'image002.png', pdfPfad: '/tmp/x.pdf', pdfDateiname: 'Kreditkarte_September.pdf' });
  const ohnePdf = createJob(db, { eingangAm: '2026-10-23T11:13:00.000Z', quelle: 'lieferant', absender: 'b@example.org', dateiname: 'image002.png', pdfPfad: '/tmp/y.pdf', dateiHash: 'h2' });
  return { db, mitPdf, ohnePdf };
}

test('Pool: KK-Auswahl zeigt "#<id> <PDF-Name>" bzw. "#<id> Eingang <Datum>", nie den Bild-Anhangnamen', async () => {
  const { db, mitPdf, ohnePdf } = seed();
  try {
    const res = await request(poolApp(db, 'kacheln')).get('/pool');
    assert.equal(res.status, 200);
    const auswahl = /<select[^>]*id="kk-markieren-job"[^>]*>([\s\S]*?)<\/select>/.exec(res.text)[1];
    assert.match(auswahl, new RegExp(`<option value="${mitPdf}">#${mitPdf} Kreditkarte_September\\.pdf</option>`));
    assert.match(auswahl, new RegExp(`<option value="${ohnePdf}">#${ohnePdf} Eingang 23\\.10\\.2026 13:13</option>`));
    assert.doesNotMatch(res.text, /image002\.png/);
  } finally {
    db.close();
  }
});

test('Pool: Kacheln und Tabellenzeilen zeigen die Belegnummer "#<id>" sichtbar', async () => {
  const { db, mitPdf, ohnePdf } = seed();
  try {
    for (const ansicht of ['kacheln', 'tabelle']) {
      const res = await request(poolApp(db, ansicht)).get('/pool');
      for (const id of [mitPdf, ohnePdf]) {
        const container = ansicht === 'kacheln' ? `pool-kachel-${id}` : `pool-row-${id}`;
        const block = res.text.slice(res.text.indexOf(`id="${container}"`), res.text.indexOf(`id="${container}"`) + 3000);
        assert.match(block, new RegExp(`<span class="beleg-nr"[^>]*>#${id}</span>`), `${ansicht}: #${id} fehlt`);
      }
    }
  } finally {
    db.close();
  }
});

test('createApp stellt belegName für alle Views bereit', () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: { sessionSecret: 's', env: 'test', churchtools: { baseUrl: 'https://ct.example.org', groupIdBuchhaltung: '10', groupIdAdmin: '20' } } });
  assert.equal(app.locals.belegName, belegName);
  db.close();
});

// Seitenköpfe und Admin-Listen: die Nummer muss dort stehen, wo der Beleg bearbeitet wird.
test('Seitenköpfe und Admin-Vorgänge zeigen die Belegnummer über _beleg_nr', () => {
  const views = ['kontierung', 'freigabe2', 'spesen-freigabe1', 'kk-abgleich', 'abgelehnt', 'kontierung-aufsplitten',
    'admin/vorgang-detail', 'admin/vorgaenge-liste', 'admin/_vorgaenge_kacheln', '_job_kacheln', '_job_table'];
  for (const v of views) {
    const src = readFileSync(new URL(`../../views/${v}.ejs`, import.meta.url), 'utf8');
    assert.match(src, /include\('(\.\.\/)?_beleg_nr'/, `${v}.ejs zeigt keine Belegnummer`);
  }
});
