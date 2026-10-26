// Server für den Responsive-Browsertest (npm run test:responsive): Test-Instanz der App
// (createApp mit testmodus: true) auf einer Spiel-DB aus den Testmodus-Beispieldaten, hinter einer
// kleinen Hülle, die die Sitzung setzt. Kein Netz, Test-Mailer, alles in einem temporären Verzeichnis.
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createApp } from '../../src/app.js';
import { createPublicRateLimiter, createSessionRateLimiter, createMachineRateLimiter } from '../../src/middleware/rateLimit.js';
import { erstelleSpielwiese } from '../../src/services/testmodus/spielwiese.js';
import { createTestMailer } from '../../src/services/testmodus/testMailer.js';
import { BEISPIELPERSONEN } from '../../src/services/testmodus/beispieldaten.js';
import { createKreditor } from '../../src/db/kreditorenRepo.js';
import { createKreditorIban } from '../../src/db/kreditorIbanRepo.js';
import { createZuweisungsregel } from '../../src/db/zuweisungsregelnRepo.js';
import { createKreditkarte, setErfasser } from '../../src/db/kreditkartenRepo.js';
import { createKkBeleg } from '../../src/db/kkBelegeRepo.js';
import { createJob, markiereJobAlsKkAbrechnung } from '../../src/db/jobsRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';

export const STANDARD_PERSON = 'test-4'; // Dora, Superadmin in der Test-Konfiguration
const PERSONEN = new Set(BEISPIELPERSONEN.map((p) => p.id));
const ALS_COOKIE = 'responsive_als';

// Review Focus 1: sehr lange Werte ohne Umbruchmöglichkeit.
export const LANG = {
  dateiname: 'Rechnung_2026-10-26_Musterfirma_Grossauftrag_Liegenschaftsverwaltung_Nachtrag_final_unterschrieben_v3.pdf',
  kreditor: 'GenossenschaftEvangelischReformierteKirchgemeindeMusterhausenLiegenschaftsverwaltungAG',
  iban: 'CH9300762011623852957',
  kommentarWort: `Bitte${'Rückfrage'.repeat(30)}`,
};

async function pdf(pfad, zeile) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText(zeile, { x: 60, y: 760, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  writeFileSync(pfad, Buffer.from(await doc.save()));
  return pfad;
}

const jobId = (db, dateiname) => db.prepare('SELECT id FROM jobs WHERE dateiname = ?').get(dateiname)?.id;

// Zusatzdaten für Seiten, die die Beispieldaten nicht abdecken, und für Review Focus 1.
async function ergaenzeDaten(db, config) {
  const jetzt = new Date().toISOString();
  const ids = {
    pool: jobId(db, 'Rechnung im Pool.pdf'),
    anna: jobId(db, 'Rechnung bei Anna.pdf'),
    freigabe2: jobId(db, 'Rechnung zur Freigabe 2.pdf'),
    abgelehnt: jobId(db, 'Abgelehnte Rechnung.pdf'),
    abgeschlossen: jobId(db, 'Abgeschlossene Rechnung.pdf'),
    spesen: jobId(db, 'Spesenbeleg.pdf'),
  };
  const konto = db.prepare("SELECT id FROM konten WHERE kontonummer = '3000'").get().id;

  // Lange Werte: Dateinamen ohne Leerzeichen, langer Kreditor, IBAN, lange Kommentarzeile.
  db.prepare('UPDATE jobs SET dateiname = ? WHERE id IN (?, ?)').run(LANG.dateiname, ids.pool, ids.anna);
  ids.konto = konto;
  // Überfällig (Admin → Laufende Vorgänge: gelb hinterlegte Zeile, Prüfung kontrast): Pool-Beleg seit 10 Tagen.
  db.prepare('UPDATE jobs SET eingang_am = ? WHERE id = ?').run(new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(), ids.pool);
  // Dora darf eingreifen: "Umhängen"-Knöpfe in der Vorgangsliste (auch in der überfälligen Zeile).
  setBerechtigungenForPerson(db, 'test-4', ['workflow_eingreifen']);
  const langerKreditor = createKreditor(db, { name: LANG.kreditor, kontoId: konto });
  ids.langerKreditor = langerKreditor;
  createKreditorIban(db, { kreditorId: langerKreditor, iban: LANG.iban });
  db.prepare('UPDATE jobs SET kreditor_id = ?, lieferant = ? WHERE id = ?').run(langerKreditor, LANG.kreditor, ids.freigabe2);
  db.prepare('UPDATE jobs SET qr_iban = ?, qr_betrag = ?, qr_waehrung = ?, qr_creditor_name = ?, qr_erkannt_am = ? WHERE id = ?')
    .run('CH4431999123000889012', '86.50', 'CHF', LANG.kreditor, jetzt, ids.anna);
  ids.regel = createZuweisungsregel(db, { absenderMuster: `rechnungen.${'sehr-lang'.repeat(6)}@example.invalid`, kreditorId: langerKreditor });
  const kommentar = db.prepare('INSERT INTO kommentare (job_id, person_id, text, erwaehnt, erstellt_am) VALUES (?, ?, ?, ?, ?)');
  for (const id of [ids.anna, ids.freigabe2, ids.spesen]) {
    kommentar.run(id, 'test-2', `Lange Zeile: ${LANG.kommentarWort} — bitte prüfen.`, '[]', jetzt);
  }

  // Kreditkarte mit Monatsabrechnung bei Anna (KK-Abgleich) und einem offenen Beleg.
  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  ids.karte = createKreditkarte(db, { bezeichnung: 'Visa Jugend', karteEndziffern: '4242', karteninhaberName: 'Anna Beispiel', verantwortlichId: 'test-1', erfassungOffen: true });
  setErfasser(db, ids.karte, ['test-1', 'test-4']);
  const abrechnungPfad = await pdf(join(config.jobsDir, 'responsive-kk-abrechnung.pdf'), 'Kreditkartenabrechnung September');
  ids.kkAbrechnung = createJob(db, { eingangAm: jetzt, quelle: 'scanner', absender: 'karten@bank.invalid', dateiname: 'Kreditkartenabrechnung_September.pdf', pdfPfad: abrechnungPfad, dateiHash: 'responsive-kk' });
  markiereJobAlsKkAbrechnung(db, ids.kkAbrechnung, { kreditkarteId: ids.karte, verantwortlichId: 'test-1', ausStatus: 'unzugewiesen' });
  const belegPfad = await pdf(join(config.jobsDir, 'responsive-kk-beleg.pdf'), 'Beleg Zugticket');
  ids.kkBeleg = createKkBeleg(db, { kreditkarteId: ids.karte, hochgeladenVon: 'test-4', gekauftVon: 'test-4', quelle: 'web', pdfPfad: belegPfad, betrag: '12.50', kaufdatum: jetzt.slice(0, 10), beschreibung: `Zugticket ${LANG.kommentarWort}`, kontoId: konto, status: 'offen' });

  // Betrieb: Fehler, Fehlermeldung, Warn-Banner (Review Focus 3: Band + Banner + Kopfzeile).
  db.prepare('INSERT INTO betrieb_fehler (request_id, zeitpunkt, person_id, methode, pfad, status, meldung, stack, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', jetzt, 'test-1', 'GET', `/kontierung/${ids.anna}?${'x'.repeat(120)}`, 500, `Error: ${LANG.kommentarWort}`, `Error: Beispiel\n    at ${'sehrLangerFunktionsname'.repeat(5)} (/app/src/${'verzeichnis/'.repeat(8)}datei.js:1:1)`, 'Mozilla/5.0 (Linux; Android 14) Beispiel');
  ids.fehler = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  ids.meldung = Number(db.prepare("INSERT INTO betrieb_fehlermeldungen (zeitpunkt, person_id, request_id, beschreibung, seite) VALUES (?, 'test-1', ?, ?, ?)")
    .run(jetzt, ids.fehler, `Beim Kontieren kam ein Fehler: ${LANG.kommentarWort}`, `/kontierung/${ids.anna}`).lastInsertRowid);
  const bis = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  ids.banner = Number(db.prepare("INSERT INTO banner (art, text, link, von, bis, erstellt_von, erstellt_am, aktiv) VALUES ('warnung', ?, NULL, ?, ?, 'test-4', ?, 1)")
    .run('Wartung am Samstag: das Portal ist zwischen 8 und 10 Uhr nicht erreichbar.', jetzt, bis, jetzt).lastInsertRowid);

  return ids;
}

export async function starteResponsiveServer({ port = 0 } = {}) {
  // Kein Netz aus dem Server heraus (fetch/undici); der Browser spricht nur mit 127.0.0.1.
  const ohneNetz = new MockAgent();
  ohneNetz.disableNetConnect();
  ohneNetz.enableNetConnect((host) => /^127\.0\.0\.1(:\d+)?$/.test(host));
  setGlobalDispatcher(ohneNetz);
  const dir = mkdtempSync(join(tmpdir(), 'freigabeportal-responsive-'));
  const config = {
    env: 'test',
    sessionSecret: 'responsive-test-secret',
    dbPath: join(dir, 'echt.sqlite'), jobsDir: join(dir, 'jobs'), brandingDir: join(dir, 'branding'),
    backupDir: join(dir, 'backups'),
    downloadSigningSecret: 'responsive-download-secret',
    churchtools: { baseUrl: 'https://echt.invalid', clientId: 'id', groupIdAdmin: '1', groupIdBuchhaltung: '2' },
  };
  // Rückfallebene: auch bei hartem Abbruch (process.exit) bleibt kein Temp-Verzeichnis liegen.
  const entferneDir = () => rmSync(dir, { recursive: true, force: true });
  process.once('exit', entferneDir);
  for (const d of [config.jobsDir, config.brandingDir, config.backupDir]) mkdirSync(d, { recursive: true });
  const echteDb = openDatabase(config.dbPath);
  seedDefaults(echteDb);
  const sp = await erstelleSpielwiese(echteDb, config, { neu: true });
  const ids = await ergaenzeDaten(sp.db, sp.config);
  const mailer = createTestMailer();
  // Der Lauf ruft als eine Person (Dora) mehrere hundert Seiten in wenigen Minuten auf (hell + dunkel):
  // eigene, grosszügige Limiter statt der Betriebswerte (300/15 min je Person), sonst 429 mitten im Lauf.
  const viel = { limit: 1_000_000 };
  const limiter = { publicLimiter: createPublicRateLimiter(viel), sessionLimiter: createSessionRateLimiter(viel), machineLimiter: createMachineRateLimiter(viel) };
  const testApp = createApp({ db: sp.db, config: sp.config, mailer, testmodus: true, limiter });

  // Hülle: eine feste Sitzung je Beispielperson. ?als=test-1 wählt die Person und merkt sie sich
  // im Cookie (für Folgeanfragen derselben Browser-Sitzung: Formulare, Bilder, Skripte).
  const sitzungen = new Map();
  const huelle = express();
  huelle.use((req, res, next) => {
    const url = new URL(req.url, 'http://x');
    const ausQuery = url.searchParams.get('als');
    const ausCookie = /(?:^|;\s*)responsive_als=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    let personId = STANDARD_PERSON;
    if (ausQuery !== null) {
      personId = PERSONEN.has(ausQuery) ? ausQuery : STANDARD_PERSON;
      res.append('Set-Cookie', `${ALS_COOKIE}=${personId}; Path=/; SameSite=Lax`);
      url.searchParams.delete('als');
      req.url = url.pathname + url.search;
      req.originalUrl = req.url;
    } else if (ausCookie && PERSONEN.has(ausCookie)) {
      personId = ausCookie;
    }
    if (!sitzungen.has(personId)) sitzungen.set(personId, { id: `responsive-${personId}`, testmodus: { personId } });
    req.session = sitzungen.get(personId);
    return testApp(req, res, next);
  });

  const server = await new Promise((resolve) => {
    const s = huelle.listen(port, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  let gestoppt = false;
  return {
    url,
    ids,
    db: sp.db,
    mailer,
    async stop() {
      if (gestoppt) return;
      gestoppt = true;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      try { sp.db.close(); } catch { /* schon zu */ }
      try { echteDb.close(); } catch { /* schon zu */ }
      entferneDir();
      process.removeListener('exit', entferneDir);
    },
  };
}
