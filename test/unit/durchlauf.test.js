// Durchlauf-Test (scripts/durchlauf/, docs/durchlauf-test.md): reine Logik ohne Browser.
// Konfiguration, Sicherheitsprüfungen, Erkennung neuer Belege und Status aus den echten Views, Formularwerte, Bericht.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  leseKonfiguration, leseArgumente, parseKonfigText, pruefeZielUrl, zahlungszielAb, testRechnungsnummer,
} from '../../scripts/durchlauf/konfiguration.js';
import {
  pruefeNichtLive, pruefeSitzungsDatei, pruefePersonenVerschieden, istBestaetigt, nurPortalSitzung, sitzungsDatei,
} from '../../scripts/durchlauf/sicherheit.js';
import {
  angemeldetAls, versionAusFusszeile, belegeAufDashboard, stand, neueBelege, fehlerMeldungen, auffaelligkeitenTitel,
  abgeschlossenStatus, seitenAnzahl, exportStufe, entschluesseln, bexioVersandAusSeite,
} from '../../scripts/durchlauf/seiten.js';
import { kontierungsWerte, kontonummerAusOption } from '../../scripts/durchlauf/formular.js';
import {
  neuerBeleg, setzeSchritt, formatBericht, formatHandpruefung, exitCode, formatDauer, dateiTeil,
} from '../../scripts/durchlauf/bericht.js';
import { belegVorschlaege } from '../../scripts/durchlauf/testbelege.js';

const VIEWS = fileURLToPath(new URL('../../views/', import.meta.url));
const render = (datei, daten) => ejs.renderFile(`${VIEWS}${datei}`, daten);
const ZIEL = new URL('https://test-portal.example.org');
const MINIMAL = { DURCHLAUF_ZIEL_URL: 'https://test-portal.example.org/irgendwo', DURCHLAUF_KONTO: '9999' };

test('Konfiguration: Minimalangaben ergeben sinnvolle Standardwerte, Ziel nur als Ursprung', () => {
  const { konfig, fehler } = leseKonfiguration(MINIMAL);
  assert.deepEqual(fehler, []);
  assert.equal(konfig.zielUrl.href, 'https://test-portal.example.org/');
  assert.equal(konfig.konto, '9999');
  assert.equal(konfig.anzahl, 1);
  assert.equal(konfig.ende, 'abgeholt');
  assert.equal(konfig.n8nApiKey, null);
  assert.equal(konfig.zeitlimitEingangMs, 15 * 60_000);
  assert.equal(konfig.abfrageMs, 20_000);
  assert.equal(konfig.auffaelligkeiten, 'bestaetigen');
  assert.equal(konfig.ordner, '.durchlauf');
});

test('Konfiguration: Zieladresse ist Pflicht und hat keinen Standardwert', () => {
  const { konfig, fehler } = leseKonfiguration({ DURCHLAUF_KONTO: '9999' });
  assert.equal(konfig.zielUrl, null);
  assert.match(fehler.join(' '), /DURCHLAUF_ZIEL_URL fehlt/);
  // PRUEF_ZIEL_URL wird nie als Ersatz genommen.
  const mitPruef = leseKonfiguration({ DURCHLAUF_KONTO: '9999', PRUEF_ZIEL_URL: 'https://irgendwo.example.org' });
  assert.equal(mitPruef.konfig.zielUrl, null);
});

test('Konfiguration: http nur für localhost, keine Zugangsdaten in der Adresse', () => {
  assert.match(pruefeZielUrl('http://test-portal.example.org').fehler, /https/);
  assert.equal(pruefeZielUrl('http://127.0.0.1:3000').fehler, null);
  assert.equal(pruefeZielUrl('http://localhost:3000/pool').url.href, 'http://localhost:3000/');
  assert.match(pruefeZielUrl('https://u:p@test-portal.example.org').fehler, /Zugangsdaten/);
  assert.match(pruefeZielUrl('ftp://test-portal.example.org').fehler, /https/);
  assert.match(pruefeZielUrl('kein url').fehler, /keine gültige Adresse/);
});

test('Konfiguration: ungültige Werte werden gemeldet', () => {
  const { fehler } = leseKonfiguration({
    ...MINIMAL, DURCHLAUF_ANZAHL: '0', DURCHLAUF_ENDE: 'paperless', DURCHLAUF_BETRAG: '12,345', DURCHLAUF_IBAN_ENDUNG: '12',
    DURCHLAUF_AUFFAELLIGKEITEN: 'egal', DURCHLAUF_ABFRAGE_S: '1', DURCHLAUF_RECHNUNGSNUMMER_PRAEFIX: 'a b',
  });
  const text = fehler.join('\n');
  for (const name of ['DURCHLAUF_ANZAHL', 'DURCHLAUF_ENDE', 'DURCHLAUF_BETRAG', 'DURCHLAUF_IBAN_ENDUNG', 'DURCHLAUF_AUFFAELLIGKEITEN', 'DURCHLAUF_ABFRAGE_S', 'DURCHLAUF_RECHNUNGSNUMMER_PRAEFIX']) {
    assert.match(text, new RegExp(name), name);
  }
  assert.equal(leseKonfiguration({ ...MINIMAL }).fehler.length, 0);
  assert.match(leseKonfiguration({ DURCHLAUF_ZIEL_URL: 'https://test-portal.example.org' }).fehler.join(' '), /DURCHLAUF_KONTO fehlt/);
});

test('Konfiguration: DURCHLAUF_ENDE=bexio_gemeldet ohne API-Schlüssel (Quittung steht auf der Belegseite)', () => {
  const { konfig, fehler } = leseKonfiguration({ ...MINIMAL, DURCHLAUF_ENDE: 'bexio_gemeldet' });
  assert.deepEqual(fehler, []);
  assert.equal(konfig.ende, 'bexio_gemeldet');
  assert.match(leseKonfiguration({ ...MINIMAL, DURCHLAUF_ENDE: 'bexio' }).fehler.join(' '), /bexio_gemeldet/);
});

test('Konfiguration: archiv_bestaetigt braucht den API-Schlüssel, ausser mit --nur-portal', () => {
  const ohne = leseKonfiguration({ ...MINIMAL, DURCHLAUF_ENDE: 'archiv_bestaetigt' });
  assert.match(ohne.fehler.join(' '), /DURCHLAUF_N8N_API_KEY/);
  assert.deepEqual(leseKonfiguration({ ...MINIMAL, DURCHLAUF_ENDE: 'archiv_bestaetigt' }, { nurPortal: true }).fehler, []);
  const mit = leseKonfiguration({ ...MINIMAL, DURCHLAUF_ENDE: 'archiv_bestaetigt', DURCHLAUF_N8N_API_KEY: 'k' });
  assert.deepEqual(mit.fehler, []);
  assert.equal(mit.konfig.n8nApiKey, 'k');
});

test('Konfiguration: .env-Text, Betrag mit Komma, IBAN-Endung gross', () => {
  const werte = parseKonfigText('# Kommentar\nDURCHLAUF_ZIEL_URL=https://test-portal.example.org\nDURCHLAUF_KONTO=9999\nDURCHLAUF_BETRAG=12,50\nDURCHLAUF_IBAN_ENDUNG=ab12\nDURCHLAUF_N8N_API_KEY=\n');
  const { konfig, fehler } = leseKonfiguration(werte);
  assert.deepEqual(fehler, []);
  assert.equal(konfig.betrag, '12.50');
  assert.equal(konfig.ibanEndung, 'AB12');
  assert.equal(konfig.n8nApiKey, null);
});

test('Argumente: Flags, Person und unbekannte Angaben', () => {
  assert.deepEqual(leseArgumente(['--ja', '--nur-portal', '--konfig', 'x.env']), { ja: true, nurPortal: true, sichtbar: false, konfigDatei: 'x.env', person: null, fehler: [] });
  assert.equal(leseArgumente(['B']).person, 'b');
  assert.match(leseArgumente(['--konfig']).fehler[0], /Dateinamen/);
  assert.match(leseArgumente(['--gas']).fehler[0], /Unbekannte Angabe/);
});

test('Testwerte: Zahlungsziel und eindeutige Rechnungsnummer', () => {
  const jetzt = new Date('2026-11-16T09:05:00Z');
  assert.equal(zahlungszielAb(jetzt, 30), '2026-12-16');
  assert.equal(testRechnungsnummer('DT', jetzt, 42), 'DT-202611160905-42');
});

test('Sicherheit: Ziel auf dem Host von PRUEF_ZIEL_URL wird abgelehnt', () => {
  assert.equal(pruefeNichtLive(ZIEL, {}), null);
  assert.equal(pruefeNichtLive(ZIEL, { PRUEF_ZIEL_URL: 'https://anderes.example.org' }), null);
  assert.match(pruefeNichtLive(ZIEL, { PRUEF_ZIEL_URL: 'https://TEST-portal.example.org/x' }), /Live-Adresse/);
  assert.equal(pruefeNichtLive(ZIEL, { PRUEF_ZIEL_URL: 'kaputt' }), null);
});

test('Sicherheit: gespeicherte Sitzung (storageState) prüfen', () => {
  const jetzt = Date.parse('2026-11-16T10:00:00Z');
  const cookie = (name, domain, abInStunden) => ({ name, domain, value: 'x', path: '/', expires: (jetzt + abInStunden * 3600_000) / 1000 });
  assert.equal(sitzungsDatei('a'), 'person-a.json');
  assert.match(pruefeSitzungsDatei(null, ZIEL, jetzt, 'a').grund, /npm run durchlauf:anmelden -- a/);
  const gut = pruefeSitzungsDatei({ cookies: [cookie('__Host-portal.sid', 'test-portal.example.org', 7)] }, ZIEL, jetzt, 'b');
  assert.equal(gut.ok, true);
  assert.equal(gut.gueltigBis.toISOString(), '2026-11-16T17:00:00.000Z');
  const knapp = pruefeSitzungsDatei({ cookies: [cookie('__Host-portal.sid', 'test-portal.example.org', 0.25)] }, ZIEL, jetzt, 'b');
  assert.equal(knapp.ok, false);
  assert.match(knapp.grund, /abgelaufen.*-- b/);
  const fremd = pruefeSitzungsDatei({ cookies: [cookie('__Host-portal.sid', 'anderes.example.org', 7)] }, ZIEL, jetzt, 'a');
  assert.match(fremd.grund, /gehört nicht zu/);
  assert.equal(pruefeSitzungsDatei({ cookies: [cookie('connect.sid', '127.0.0.1', 7)] }, new URL('http://127.0.0.1:3000'), jetzt).ok, true);
});

test('Sicherheit: nur Portal-Cookies werden gespeichert (keine ChurchTools-Anmeldung)', () => {
  const state = {
    cookies: [{ name: '__Host-portal.sid', domain: 'test-portal.example.org' }, { name: 'ChurchTools_ct', domain: '.ct.example.org' }],
    origins: [{ origin: 'https://test-portal.example.org', localStorage: [] }, { origin: 'https://ct.example.org', localStorage: [] }],
  };
  const gefiltert = nurPortalSitzung(state, ZIEL);
  assert.deepEqual(gefiltert.cookies.map((c) => c.name), ['__Host-portal.sid']);
  assert.deepEqual(gefiltert.origins.map((o) => o.origin), ['https://test-portal.example.org']);
});

test('Sicherheit: Vier-Augen-Prinzip und Bestätigung', () => {
  assert.equal(pruefePersonenVerschieden('Anna Test', 'Ben Test'), null);
  assert.match(pruefePersonenVerschieden('Anna  Test', 'anna test'), /dieselbe Person/);
  assert.match(pruefePersonenVerschieden('Anna Test', null), /nicht feststellbar/);
  assert.equal(istBestaetigt(' Ja '), true);
  for (const nein of ['', 'j', 'yes', 'jaa', undefined]) assert.equal(istBestaetigt(nein), false);
});

test('Seiten: Name aus der Kopfzeile und Version aus der Fusszeile', () => {
  assert.equal(angemeldetAls('<span class="text-muted small d-none d-md-inline">Angemeldet als Zoë &amp; Co M&#39;Test</span>'), "Zoë & Co M'Test");
  assert.equal(angemeldetAls('<p>nichts</p>'), null);
  assert.equal(versionAusFusszeile('<footer>© 2026 · <a href="r">GitHub</a>\n (<a href="t">v1.3.0</a>)</footer>'), 'v1.3.0');
  assert.equal(versionAusFusszeile('<footer>© 2026 Freigabeportal</footer>'), null);
  assert.equal(entschluesseln('&#252;'), 'ü');
});

test('Seiten: neue Belege aus der echten Aufgabenliste (Tabelle und Kacheln)', async () => {
  const jobs = (ids) => ids.map((id) => ({ id, dateiname: `R${id}.pdf`, quelle: 'lieferant', eingang_am: '2026-11-16T10:00:00Z', status: 'unzugewiesen' }));
  const dashboard = async (pool, kontierung, freigabe2) => [
    await render('_job_table.ejs', { jobs: jobs(pool), idPrefix: 'pool', istPoolArtig: true }),
    await render('_job_kacheln.ejs', { jobs: jobs(pool), idPrefix: 'pool', istPoolArtig: true }),
    await render('_job_table.ejs', { jobs: jobs(kontierung), idPrefix: 'kontierung', linkPrefix: '/kontierung', aktionLabel: 'Kontieren' }),
    await render('_job_table.ejs', { jobs: jobs(freigabe2), idPrefix: 'freigabe2', linkPrefix: '/freigabe2', aktionLabel: 'Freigeben' }),
  ].join('\n');

  const vorher = stand(belegeAufDashboard(await dashboard([3], [5], [9])));
  assert.deepEqual([...vorher.ids].sort(), [3, 5, 9]);
  assert.equal(vorher.maxId, 9);
  const eintraege = belegeAufDashboard(await dashboard([3, 11, 4], [5, 12], [9, 13]));
  // Zeile und Kachel desselben Belegs zählen einmal.
  assert.equal(eintraege.filter((e) => e.id === 11).length, 1);
  // 4 ist älter als alles Bekannte (zurück in den Pool gelegt), 13 liegt nur bei Freigabe 2: beides kein neuer Eingang.
  assert.deepEqual(neueBelege(vorher, eintraege), [{ id: 11, bereich: 'pool' }, { id: 12, bereich: 'kontierung' }]);
  // Leerer Stand: jeder Beleg in Pool oder eigener Kontierung zählt.
  assert.deepEqual(neueBelege(stand([]), eintraege).map((e) => e.id), [3, 4, 5, 11, 12]);
});

test('Seiten: Status auf «Abgeschlossene Rechnungen» aus den echten Views', async () => {
  const jobs = [
    { id: 21, dateiname: 'a.pdf', status: 'abgeschlossen', zeitstempel_gesetzt_am: null },
    { id: 22, dateiname: 'b.pdf', status: 'abgeholt', zeitstempel_gesetzt_am: '2026-11-16T10:00:00Z' },
  ];
  const tabelle = abgeschlossenStatus(await render('_abgeschlossen_table.ejs', { jobs }));
  assert.deepEqual([...tabelle], [[21, 'abgeschlossen'], [22, 'abgeholt']]);
  const kacheln = abgeschlossenStatus(await render('_abgeschlossen_kacheln.ejs', { jobs }));
  assert.deepEqual([...kacheln], [[21, 'abgeschlossen'], [22, 'abgeholt']]);
  assert.equal(seitenAnzahl('<span class="page-link">Seite 1 von 3</span>'), 3);
  assert.equal(seitenAnzahl(''), 1);
});

test('Seiten: Fehlermeldungen und Prüf-Popup aus den echten Views', async () => {
  const liste = await render('_fehler_liste.ejs', { errors: ['Bitte einen Betrag angeben.', 'Konto & mehr'], feldFehler: { betrag: 'Bitte einen Betrag angeben.' } });
  assert.deepEqual(fehlerMeldungen(liste), ['Bitte einen Betrag angeben.', 'Konto & mehr']);
  assert.deepEqual(fehlerMeldungen('<p class="alert alert-danger">Du bist für die Freigabe 2 dieses Jobs nicht zuständig.</p>'), ['Du bist für die Freigabe 2 dieses Jobs nicht zuständig.']);
  assert.deepEqual(fehlerMeldungen('<p>ok</p>'), []);
  const modal = await render('_auffaelligkeiten_modal.ejs', {
    auffaelligkeiten: { befunde: [{ schwere: 'rot', titel: 'Mögliche Dublette', text: 't' }, { schwere: 'gelb', titel: 'Neue IBAN', text: 't' }], hash: 'h', zeigeTelefonHinweis: false, belegFelder: [] },
    values: {},
  });
  assert.deepEqual(auffaelligkeitenTitel(modal), ['Mögliche Dublette', 'Neue IBAN']);
  assert.deepEqual(auffaelligkeitenTitel('<form></form>'), []);
});

test('Seiten: Exportstufe aus Status und offenen Archivquittungen', () => {
  assert.deepEqual(exportStufe(1, 'abgeschlossen', null), { abgeholt: false, archivBestaetigt: null });
  assert.deepEqual(exportStufe(1, 'abgeholt', null), { abgeholt: true, archivBestaetigt: null });
  assert.deepEqual(exportStufe(1, 'abgeholt', new Set([1])), { abgeholt: true, archivBestaetigt: false });
  assert.deepEqual(exportStufe(1, 'abgeholt', new Set([2])), { abgeholt: true, archivBestaetigt: true });
  // Noch nicht abgeholt erscheint ein Beleg nie in archivierung-ausstehend: das ist keine Quittung.
  assert.deepEqual(exportStufe(1, 'abgeschlossen', new Set()), { abgeholt: false, archivBestaetigt: false });
  assert.deepEqual(exportStufe(1, undefined, new Set()), { abgeholt: false, archivBestaetigt: false });
});

const KONFIG = leseKonfiguration(MINIMAL).konfig;
const FORMULAR = {
  kontoOptionen: [{ value: '', text: '— wählen —' }, { value: '4', text: '1000 — Allgemein' }, { value: '7', text: '9999 — Testkonto' }],
  kreditorOptionen: [{ value: '', text: '— wählen —' }, { value: '3', text: 'Testlieferant AG', ibanPflicht: true }, { value: '5', text: 'Bar GmbH', ibanPflicht: false }],
  kreditorId: '', absender: '', betrag: '', zahlungsziel: '', rechnungsnummer: '', qrIban: '',
};

test('Formular: QR-Vorbelegung wird übernommen, Fehlendes erzeugt', () => {
  const jetzt = new Date('2026-11-16T09:05:00Z');
  const { werte, fehler, herkunft } = kontierungsWerte({ ...FORMULAR, kreditorId: '3', betrag: '487.35', qrIban: 'CH00', absender: 'rechnung@x.invalid' }, KONFIG, { jobId: 42, jetzt });
  assert.deepEqual(fehler, []);
  assert.deepEqual(werte, {
    kontoId: '7', kreditorId: '3', lieferant: 'Testlieferant AG', betrag: '487.35', ibanEndung: null,
    rechnungsnummer: 'DT-202611160905-42', zahlungsziel: '2026-12-16', absender: 'rechnung@x.invalid',
  });
  assert.equal(herkunft.lieferant, 'vorbelegt (QR/IBAN)');
  assert.equal(kontonummerAusOption('9999 — Testkonto'), '9999');
});

test('Formular: ohne QR braucht es Lieferant, Betrag und IBAN-Endung aus der Konfiguration', () => {
  const ohne = kontierungsWerte(FORMULAR, KONFIG, { jobId: 1 });
  assert.equal(ohne.werte, null);
  assert.match(ohne.fehler.join(' '), /DURCHLAUF_LIEFERANT/);
  assert.match(ohne.fehler.join(' '), /DURCHLAUF_BETRAG/);

  const halb = kontierungsWerte(FORMULAR, { ...KONFIG, lieferant: 'testlieferant ag', betrag: '10.00' }, { jobId: 1 });
  assert.match(halb.fehler.join(' '), /DURCHLAUF_IBAN_ENDUNG/);

  const voll = kontierungsWerte(FORMULAR, { ...KONFIG, lieferant: 'Testlieferant AG', betrag: '10.00', ibanEndung: '3456' }, { jobId: 1 });
  assert.deepEqual(voll.fehler, []);
  assert.equal(voll.werte.ibanEndung, '3456');
  assert.equal(voll.werte.absender, 'durchlauf-test@example.invalid');

  // Lieferant ohne IBAN-Pflicht (z. B. Barzahlung): keine Endung nötig.
  assert.equal(kontierungsWerte(FORMULAR, { ...KONFIG, lieferant: 'Bar GmbH', betrag: '1' }, { jobId: 1 }).werte.ibanEndung, null);
  assert.match(kontierungsWerte(FORMULAR, { ...KONFIG, lieferant: 'Gibt es nicht', betrag: '1' }, { jobId: 1 }).fehler.join(' '), /nicht zur Auswahl/);
});

test('Formular: fehlendes Testkonto wird verständlich gemeldet', () => {
  const { fehler } = kontierungsWerte({ ...FORMULAR, kreditorId: '3', betrag: '1', qrIban: 'CH' }, { ...KONFIG, konto: '4711' }, { jobId: 1 });
  assert.match(fehler[0], /Konto 4711 steht bei Person A nicht zur Auswahl/);
});

test('Bericht: Tabelle, Handprüfung und Exit-Code', () => {
  const b = neuerBeleg(42);
  Object.assign(b, { dateiname: 'R1.pdf', betrag: '487.35', lieferant: 'Testlieferant AG', rechnungsnummer: 'DT-1-42' });
  setzeSchritt(b, 'eingang', 'ok', { dauerMs: 61_000 });
  setzeSchritt(b, 'kontierung', 'ok', { dauerMs: 3_200 });
  setzeSchritt(b, 'freigabe2', 'ok', { dauerMs: 900 });
  setzeSchritt(b, 'abgeholt', 'ok', { dauerMs: 125_000 });
  setzeSchritt(b, 'archiv', 'nicht_gemeldet');
  setzeSchritt(b, 'bexio', 'nicht_gemeldet');
  const ergebnis = { belege: [b], allgemein: [] };
  const text = formatBericht(ergebnis);
  assert.match(text, /#42\s+Eingang im Portal\s+✓\s+1 min 01 s/);
  assert.match(text, /Archiv bestätigt\s+\?\s+nicht gemeldet – in Paperless von Hand prüfen/);
  assert.match(text, /An Bexio gemeldet\s+\?\s+nicht gemeldet – bei Bexio von Hand prüfen/);
  assert.equal(exitCode(ergebnis), 0, 'nicht gemeldetes Archiv bzw. nicht gemeldeter Bexio-Versand ist kein Fehler');
  assert.doesNotMatch(formatHandpruefung([b]), /Message-ID/);
  assert.match(formatHandpruefung([b]), /#42 · R1\.pdf · CHF 487\.35 · Testlieferant AG · Rechnungsnummer DT-1-42/);

  setzeSchritt(b, 'archiv', 'fehler', { ursache: 'keine Archivquittung' });
  assert.equal(exitCode(ergebnis), 1);
  setzeSchritt(b, 'archiv', 'uebersprungen');
  assert.equal(exitCode(ergebnis), 0);
  setzeSchritt(b, 'bexio', 'fehler', { ursache: 'keine Versandquittung' });
  assert.equal(exitCode(ergebnis), 1, 'bei DURCHLAUF_ENDE=bexio_gemeldet ist die fehlende Quittung ein Fehler');
  setzeSchritt(b, 'bexio', 'ok', { ursache: '16.11.2026 10:15, an bexio@example.invalid, Message-ID <m1@x>' });
  b.bexioVersand = [{ zeitpunkt: '16.11.2026 10:15', empfaenger: 'bexio@example.invalid', messageId: '<m1@x>' }];
  assert.equal(exitCode(ergebnis), 0);
  const liste = formatHandpruefung([b]);
  assert.match(liste, /Bexio-Versand gemeldet: 16\.11\.2026 10:15, an bexio@example\.invalid, Message-ID <m1@x>/);
  assert.match(liste, /Mail mit dieser Message-ID bei Bexio angekommen/);
  assert.match(formatBericht(ergebnis), /übersprungen \(--nur-portal\)/);

  const offen = neuerBeleg(43);
  setzeSchritt(offen, 'eingang', 'ok');
  setzeSchritt(offen, 'kontierung', 'fehler', { ursache: 'x' });
  assert.equal(exitCode({ belege: [b, offen] }), 1);
  assert.equal(exitCode({ belege: [b], allgemein: [{ schritt: 'Eingang', status: 'fehler' }] }), 1);
  assert.equal(exitCode({ belege: [] }), 1, 'ohne Beleg nie erfolgreich');
  assert.match(formatHandpruefung([offen]), /keine freigegebenen Belege/);
  assert.throws(() => setzeSchritt(b, 'paperless', 'ok'), /Unbekannter Schritt/);
});

test('Bericht: Dauer und Dateinamen', () => {
  assert.equal(formatDauer(null), '');
  assert.equal(formatDauer(450), '450 ms');
  assert.equal(formatDauer(42_400), '42 s');
  assert.equal(formatDauer(185_000), '3 min 05 s');
  assert.equal(dateiTeil('beleg 12/kontierung: ü'), 'beleg-12-kontierung-u');
});

test('Testbelege: Standardfälle vorschlagen, Sonderfälle nicht', () => {
  const dateien = ['R1_Testlieferant_Rechnung-1001_QR.pdf', 'R2_Testlieferant_Rechnung-1001_KOPIE.pdf', 'R3_Testlieferant_Rechnung-1003_FALSCHE-IBAN.pdf', 'R4_Testlieferant_Rechnung-2001_ohne-QR.pdf', 'R7a_ZweiterLieferant_Rechnung-5001_QR.pdf'];
  assert.deepEqual(belegVorschlaege(dateien).map((v) => v.datei), ['R1_Testlieferant_Rechnung-1001_QR.pdf', 'R4_Testlieferant_Rechnung-2001_ohne-QR.pdf']);
  assert.deepEqual(belegVorschlaege([]), []);
});

test('Testbelege: die vorgeschlagene IBAN-Endung passt zur IBAN des Testlieferanten in gen.mjs', () => {
  const gen = readFileSync(new URL('../../docs/testdrehbuch/belege/gen.mjs', import.meta.url), 'utf8');
  const bban = /const IBAN_TEST = ibanCH\('(\d+)'\)/.exec(gen)[1];
  const vorlage = readFileSync(new URL('../../.env.durchlauf.example', import.meta.url), 'utf8');
  assert.match(vorlage, new RegExp(`R4…: ${bban.slice(-4)}\\)`));
});

test('Vorlage .env.durchlauf.example: nur Platzhalter-Adresse, kein Schlüssel', () => {
  const vorlage = readFileSync(new URL('../../.env.durchlauf.example', import.meta.url), 'utf8');
  const werte = parseKonfigText(vorlage);
  assert.equal(new URL(werte.DURCHLAUF_ZIEL_URL).hostname.endsWith('.example.org'), true);
  assert.equal(werte.DURCHLAUF_N8N_API_KEY, '');
  assert.deepEqual(leseKonfiguration(werte).fehler, []);
});

// Der Bexio-Block der echten View views/zeitstempel-pruefen.ejs (ohne Seitenrahmen gerendert).
function bexioBlockVorlage() {
  const view = readFileSync(`${VIEWS}zeitstempel-pruefen.ejs`, 'utf8');
  const start = view.indexOf('<% if (locals.bexioVersand) { %>');
  const ende = view.indexOf('<% if (!ergebnis) { %>');
  assert.ok(start >= 0 && ende > start, 'Bexio-Block in zeitstempel-pruefen.ejs gefunden');
  return view.slice(start, ende);
}

test('Seiten: Bexio-Versandquittung auf der Belegseite (echte View, beide Varianten)', () => {
  const vorlage = bexioBlockVorlage();
  const gemeldet = ejs.render(vorlage, { bexioVersand: [
    { zeitpunkt: '16.11.2026 10:15', empfaenger: 'bexio@example.invalid', messageId: '<abc&1@mail.example.org>' },
    { zeitpunkt: '16.11.2026 11:00', empfaenger: 'bexio@example.invalid, kopie@example.invalid', messageId: '<def@mail.example.org>' },
  ] });
  assert.deepEqual(bexioVersandAusSeite(gemeldet), [
    { zeitpunkt: '16.11.2026 10:15', empfaenger: 'bexio@example.invalid', messageId: '<abc&1@mail.example.org>' },
    { zeitpunkt: '16.11.2026 11:00', empfaenger: 'bexio@example.invalid, kopie@example.invalid', messageId: '<def@mail.example.org>' },
  ]);
  const offen = ejs.render(vorlage, { bexioVersand: [] });
  assert.match(offen, /noch nicht gemeldet/);
  assert.deepEqual(bexioVersandAusSeite(offen), []);
  // Ohne Bexio-Block (Rapport, nicht abgeschlossen) bzw. auf einer anderen Seite: null.
  assert.equal(bexioVersandAusSeite(ejs.render(vorlage, { bexioVersand: null })), null);
  assert.equal(bexioVersandAusSeite('<p>Kein Zugriff auf diesen Job.</p>'), null);
});
