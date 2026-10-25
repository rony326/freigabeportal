import { Router } from 'express';
import { getPersonById, listAllPersons } from '../../db/personenRepo.js';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { uebersicht, personDetail } from '../../services/nutzungAuswertung.js';
import { pruefeBannerEingabe, zurichLokalZuIso, isoZuZurichLokal, BANNER_ARTEN } from '../../services/banner.js';
import { zeitpunktAnzeige } from '../../services/auditLog.js';
import { createHash, randomBytes } from 'node:crypto';
import { createStatusCache, DEFAULTS as STATUS_DEFAULTS } from '../../services/statusPruefungen.js';
import { createTsaErreichbarkeit } from '../../services/statusTsa.js';

// Dienste der Statusseite: Schlüssel, Name, Link (adminNav-Flag steuert die Sichtbarkeit).
const STATUS_DIENSTE = [
  ['datenbank', 'Datenbank', null],
  ['sicherung', 'Sicherung', ['/admin/backup', 'backup']],
  ['mailversand', 'Mailversand', ['/admin/mails', 'mails']],
  ['churchtools', 'ChurchTools', ['/admin/sync', 'sync']],
  ['zeitstempel', 'Zeitstempel', ['/admin/zeitstempel', 'zeitstempel']],
  ['audit_nachweis', 'Audit-Nachweis', ['/admin/zeitstempel', 'zeitstempel']],
  ['archivuebergabe', 'Archivübergabe', ['/admin/vorgaenge', 'vorgaenge']],
  ['speicher', 'Speicher', null],
  ['jobs', 'Geplante Jobs', ['/admin/geplante-jobs', 'geplanteJobs']],
  ['sicherheitsalarme', 'Sicherheitsalarme', ['/admin/backup', 'backup']],
  ['einrichtung', 'Ersteinrichtung', ['/admin/ersteinrichtung', 'ersteinrichtung']],
];
// Grenzwert-Felder: Schlüssel, Beschriftung, Einheit
const GRENZWERT_FELDER = [
  ['status_sicherung_warnung_stunden', 'Sicherung: Warnung nach', 'Stunden'],
  ['status_sicherung_fehler_stunden', 'Sicherung: Fehler nach', 'Stunden'],
  ['status_mail_wartezeit_fehler_minuten', 'Mailversand: Fehler bei Wartezeit über', 'Minuten'],
  ['status_churchtools_warnung_stunden', 'ChurchTools: Warnung nach', 'Stunden'],
  ['status_churchtools_fehler_stunden', 'ChurchTools: Fehler nach', 'Stunden'],
  ['status_zeitstempel_crl_warnung_tage', 'Zeitstempel: Warnung vor Ablauf der Sperrliste', 'Tage'],
  ['status_archiv_warnung_stunden', 'Archivübergabe: Warnung nach', 'Stunden'],
  ['status_archiv_fehler_tage', 'Archivübergabe: Fehler nach', 'Tage'],
  ['status_speicher_warnung_prozent', 'Speicher: Warnung unter', '% frei'],
  ['status_speicher_fehler_prozent', 'Speicher: Fehler unter', '% frei'],
];

function leseGrenzwerte(db) {
  return Object.fromEntries(GRENZWERT_FELDER.map(([k]) => {
    const roh = getConfigValue(db, k);
    return [k, roh !== null && roh !== '' ? String(roh) : String(STATUS_DEFAULTS[k])];
  }));
}

// Alle zehn Werte müssen ganze Zahlen > 0 sein; Fehlergrenze nie vor der Warnungsgrenze.
function pruefeGrenzwerte(body) {
  const werte = {};
  const fehler = [];
  for (const [k, label] of GRENZWERT_FELDER) {
    const roh = typeof body[k] === 'string' ? body[k].trim() : '';
    werte[k] = roh;
    if (!/^\d{1,6}$/.test(roh) || Number(roh) <= 0) fehler.push(`${label}: bitte eine ganze Zahl grösser als 0 angeben.`);
  }
  if (fehler.length) return { werte, fehler };
  const n = (k) => Number(werte[k]);
  if (n('status_sicherung_fehler_stunden') < n('status_sicherung_warnung_stunden')) fehler.push('Sicherung: Die Fehlergrenze darf nicht unter der Warnungsgrenze liegen.');
  if (n('status_churchtools_fehler_stunden') < n('status_churchtools_warnung_stunden')) fehler.push('ChurchTools: Die Fehlergrenze darf nicht unter der Warnungsgrenze liegen.');
  if (n('status_archiv_fehler_tage') * 24 < n('status_archiv_warnung_stunden')) fehler.push('Archivübergabe: Die Fehlergrenze darf nicht unter der Warnungsgrenze liegen.');
  if (n('status_speicher_fehler_prozent') > n('status_speicher_warnung_prozent')) fehler.push('Speicher: Die Fehlergrenze muss gleich oder unter der Warnungsgrenze liegen.');
  if (n('status_speicher_warnung_prozent') > 100) fehler.push('Speicher: Prozentwerte höchstens 100.');
  return { werte, fehler };
}

const ZEITRAEUME = [7, 30, 90];
const STANDARD_TAGE = 30;
const MELDUNG_STATUS = ['offen', 'in_arbeit', 'erledigt'];
const NOTIZ_MAX = 2000;
const DATENSCHUTZ_MAX = 20000;
// Request-IDs sind UUIDs: Hex am Anfang, danach Hex und Bindestriche (Präfix oder voll).
const FEHLER_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;
const LISTE_MAX = 200;

// Locker: leer oder genau ein "@" ohne Leerzeichen, mit Text davor und danach.
function emailLockerGueltig(wert) {
  return wert === '' || /^[^\s@]+@[^\s@]+$/.test(wert);
}

function namenVerzeichnis(db) {
  const namen = new Map(listAllPersons(db).map((p) => [p.churchtools_person_id, `${p.vorname} ${p.nachname}`]));
  return (id) => (id == null ? '—' : namen.get(String(id)) || `Person ${id}`);
}

// Gemeinsame Werte aller Betrieb-Seiten.
function basis(db, reiter) {
  return { reiter, name: namenVerzeichnis(db), zeit: zeitpunktAnzeige };
}

function findeFehler(db, id) {
  if (typeof id !== 'string' || !FEHLER_ID.test(id)) return null;
  const treffer = db.prepare("SELECT * FROM betrieb_fehler WHERE request_id LIKE ? ESCAPE '\\' ORDER BY zeitpunkt DESC LIMIT 2").all(`${id.toLowerCase()}%`);
  return treffer.length === 1 ? treffer[0] : null;
}

function bannerFormular(banner) {
  if (!banner) return { id: null, art: 'info', text: '', link: '', von: '', bis: '' };
  return { id: banner.id, art: banner.art, text: banner.text, link: banner.link || '', von: isoZuZurichLokal(banner.von), bis: isoZuZurichLokal(banner.bis) };
}

export function createBetriebRouter({
  db, config = {}, tsaErreichbarkeit = createTsaErreichbarkeit(), tsaVersuch,
  statusCache = createStatusCache({ db, config, tsaErreichbarkeit, tsaVersuch }), csrfProtection = (req, res, next) => next(),
}) {
  const router = Router();

  const schluesselVorhanden = () => /^[0-9a-f]{64}$/.test(getConfigValue(db, 'monitoring_secret') || '');

  function zeigeStatus(req, res, { status = 200, werte = null, fehler = [], gespeichert = false, neuerSchluessel = null, neu = false } = {}) {
    const ergebnis = statusCache.ergebnis({ neu });
    const nav = res.locals.adminNav || {};
    const dienste = STATUS_DIENSTE.map(([key, name, ziel]) => ({
      key, name, ...ergebnis.dienste[key], link: ziel && nav[ziel[1]] ? ziel[0] : null,
    }));
    if (neuerSchluessel) res.set('Cache-Control', 'no-store');
    res.status(status).render('admin/betrieb-status', {
      ...basis(db, 'status'), gesamt: ergebnis.status, geprueftAm: ergebnis.geprueft_am, dienste,
      felder: GRENZWERT_FELDER, werte: werte || leseGrenzwerte(db), fehler, gespeichert, neuerSchluessel,
      schluesselVorhanden: schluesselVorhanden(),
      baseUrl: String(config.publicBaseUrl || '').replace(/\/+$/, '') || 'https://<deine-domain>',
    });
  }

  router.get('/status', (req, res) => zeigeStatus(req, res, { gespeichert: req.query.gespeichert === '1', neu: req.query.neu === '1' }));

  router.post('/status/grenzwerte', csrfProtection, (req, res) => {
    const { werte, fehler } = pruefeGrenzwerte(req.body);
    if (fehler.length) return zeigeStatus(req, res, { status: 400, werte, fehler });
    for (const [k] of GRENZWERT_FELDER) setConfigValue(db, k, werte[k]);
    statusCache.leeren();
    res.redirect('/admin/betrieb/status?gespeichert=1');
  });

  router.post('/status/schluessel', csrfProtection, (req, res) => {
    const aktion = req.body.aktion;
    if (aktion === 'erzeugen') {
      if (schluesselVorhanden() && req.body.bestaetigt !== '1') {
        return zeigeStatus(req, res, { status: 400, fehler: ['Bitte bestätige, dass der bisherige Schlüssel ungültig wird.'] });
      }
      const schluessel = randomBytes(32).toString('hex');
      // Nur der SHA-256 wird gespeichert; der Klartext wird genau einmal angezeigt.
      setConfigValue(db, 'monitoring_secret', createHash('sha256').update(schluessel).digest('hex'));
      return zeigeStatus(req, res, { neuerSchluessel: schluessel });
    }
    if (aktion === 'entfernen') {
      setConfigValue(db, 'monitoring_secret', '');
      return res.redirect('/admin/betrieb/status?gespeichert=1');
    }
    return zeigeStatus(req, res, { status: 400, fehler: ['Unbekannte Aktion.'] });
  });

  router.get('/', (req, res) => {
    const tage = ZEITRAEUME.includes(Number(req.query.tage)) ? Number(req.query.tage) : STANDARD_TAGE;
    const personen = listAllPersons(db);
    const personId = typeof req.query.person === 'string' && personen.some((p) => p.churchtools_person_id === req.query.person) ? req.query.person : '';
    const bis = new Date();
    const von = new Date(bis.getTime() - tage * 24 * 3600 * 1000);
    const daten = uebersicht(db, { von: von.toISOString(), bis: bis.toISOString(), personId: personId || null });
    res.render('admin/betrieb-uebersicht', { ...basis(db, 'uebersicht'), daten, tage, zeitraeume: ZEITRAEUME, personen, personId });
  });

  router.get('/personen/:id', (req, res) => {
    const person = getPersonById(db, req.params.id);
    if (!person) return res.status(404).render('error', { message: 'Person nicht gefunden.' });
    res.render('admin/betrieb-person', { ...basis(db, 'uebersicht'), person, detail: personDetail(db, person.churchtools_person_id) });
  });

  router.get('/fehler', (req, res) => {
    const suche = typeof req.query.suche === 'string' ? req.query.suche.trim() : '';
    const sucheGueltig = FEHLER_ID.test(suche);
    const fehler = sucheGueltig
      ? db.prepare("SELECT id, request_id, zeitpunkt, person_id, methode, pfad, status, meldung FROM betrieb_fehler WHERE request_id LIKE ? ESCAPE '\\' ORDER BY zeitpunkt DESC LIMIT ?").all(`${suche.toLowerCase()}%`, LISTE_MAX)
      : db.prepare('SELECT id, request_id, zeitpunkt, person_id, methode, pfad, status, meldung FROM betrieb_fehler ORDER BY zeitpunkt DESC LIMIT ?').all(LISTE_MAX);
    res.render('admin/betrieb-fehler', {
      ...basis(db, 'fehler'), fehler, suche, sucheUngueltig: suche !== '' && !sucheGueltig, einzelfehler: null, meldungen: [],
    });
  });

  router.get('/fehler/:requestId', (req, res) => {
    const einzelfehler = findeFehler(db, req.params.requestId);
    if (!einzelfehler) return res.status(404).render('error', { message: 'Fehler nicht gefunden.' });
    const meldungen = db.prepare('SELECT * FROM betrieb_fehlermeldungen WHERE request_id = ? ORDER BY zeitpunkt DESC').all(einzelfehler.request_id);
    res.render('admin/betrieb-fehler', { ...basis(db, 'fehler'), fehler: [], suche: '', sucheUngueltig: false, einzelfehler, meldungen });
  });

  router.get('/meldungen', (req, res) => {
    const status = MELDUNG_STATUS.includes(req.query.status) ? req.query.status : '';
    const meldungen = status
      ? db.prepare('SELECT * FROM betrieb_fehlermeldungen WHERE status = ? ORDER BY zeitpunkt DESC, id DESC LIMIT ?').all(status, LISTE_MAX)
      : db.prepare('SELECT * FROM betrieb_fehlermeldungen ORDER BY zeitpunkt DESC, id DESC LIMIT ?').all(LISTE_MAX);
    res.render('admin/betrieb-meldungen', { ...basis(db, 'meldungen'), meldungen, status, meldung: null, fehlerText: null, gespeichert: false });
  });

  function zeigeMeldung(res, meldung, { status = 200, fehlerText = null, gespeichert = false } = {}) {
    res.status(status).render('admin/betrieb-meldungen', { ...basis(db, 'meldungen'), meldungen: [], status: '', meldung, fehlerText, gespeichert });
  }

  router.get('/meldungen/:id', (req, res) => {
    const meldung = db.prepare('SELECT * FROM betrieb_fehlermeldungen WHERE id = ?').get(Number(req.params.id));
    if (!meldung) return res.status(404).render('error', { message: 'Meldung nicht gefunden.' });
    zeigeMeldung(res, meldung, { gespeichert: req.query.gespeichert === '1' });
  });

  router.post('/meldungen/:id', csrfProtection, (req, res) => {
    const meldung = db.prepare('SELECT * FROM betrieb_fehlermeldungen WHERE id = ?').get(Number(req.params.id));
    if (!meldung) return res.status(404).render('error', { message: 'Meldung nicht gefunden.' });
    const status = req.body.status;
    const notiz = typeof req.body.notiz === 'string' ? req.body.notiz.trim() : '';
    if (!MELDUNG_STATUS.includes(status)) return zeigeMeldung(res, meldung, { status: 400, fehlerText: 'Ungültiger Status.' });
    if (notiz.length > NOTIZ_MAX) return zeigeMeldung(res, { ...meldung, notiz }, { status: 400, fehlerText: `Die Notiz darf höchstens ${NOTIZ_MAX} Zeichen lang sein.` });
    db.prepare('UPDATE betrieb_fehlermeldungen SET status = ?, notiz = ?, bearbeitet_von = ?, bearbeitet_am = ? WHERE id = ?')
      .run(status, notiz || null, req.currentPerson.churchtools_person_id, new Date().toISOString(), meldung.id);
    res.redirect(`/admin/betrieb/meldungen/${meldung.id}?gespeichert=1`);
  });

  function zeigeBanner(res, { status = 200, formular = bannerFormular(null), fehler = [], gespeichert = false } = {}) {
    const banner = db.prepare('SELECT * FROM banner ORDER BY aktiv DESC, von DESC, id DESC').all();
    res.status(status).render('admin/betrieb-banner', { ...basis(db, 'banner'), banner, formular, fehler, gespeichert, arten: BANNER_ARTEN });
  }

  // Formularwerte lesen und prüfen; von/bis kommen als datetime-local in Zürcher Ortszeit.
  function leseBanner(body) {
    const formular = {
      art: typeof body.art === 'string' ? body.art : '',
      text: typeof body.text === 'string' ? body.text.replace(/\r\n/g, '\n').trim() : '',
      link: typeof body.link === 'string' ? body.link.trim() : '',
      von: typeof body.von === 'string' ? body.von : '',
      bis: typeof body.bis === 'string' ? body.bis : '',
    };
    const werte = { ...formular, von: zurichLokalZuIso(formular.von), bis: zurichLokalZuIso(formular.bis) };
    return { formular, werte, fehler: pruefeBannerEingabe(werte) };
  }

  router.get('/banner', (req, res) => zeigeBanner(res, { gespeichert: req.query.gespeichert === '1' }));

  router.post('/banner', csrfProtection, (req, res) => {
    const { formular, werte, fehler } = leseBanner(req.body);
    if (fehler.length) return zeigeBanner(res, { status: 400, formular: { ...formular, id: null }, fehler });
    db.prepare('INSERT INTO banner (art, text, link, von, bis, erstellt_von, erstellt_am, aktiv) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
      .run(werte.art, werte.text, werte.link || null, werte.von, werte.bis, req.currentPerson.churchtools_person_id, new Date().toISOString());
    res.redirect('/admin/betrieb/banner?gespeichert=1');
  });

  router.get('/banner/:id', (req, res) => {
    const banner = db.prepare('SELECT * FROM banner WHERE id = ?').get(Number(req.params.id));
    if (!banner) return res.status(404).render('error', { message: 'Banner nicht gefunden.' });
    zeigeBanner(res, { formular: bannerFormular(banner) });
  });

  router.post('/banner/:id', csrfProtection, (req, res) => {
    const banner = db.prepare('SELECT * FROM banner WHERE id = ?').get(Number(req.params.id));
    if (!banner) return res.status(404).render('error', { message: 'Banner nicht gefunden.' });
    const { formular, werte, fehler } = leseBanner(req.body);
    if (fehler.length) return zeigeBanner(res, { status: 400, formular: { ...formular, id: banner.id }, fehler });
    db.prepare('UPDATE banner SET art = ?, text = ?, link = ?, von = ?, bis = ? WHERE id = ?')
      .run(werte.art, werte.text, werte.link || null, werte.von, werte.bis, banner.id);
    res.redirect('/admin/betrieb/banner?gespeichert=1');
  });

  router.post('/banner/:id/deaktivieren', csrfProtection, (req, res) => {
    const ergebnis = db.prepare('UPDATE banner SET aktiv = 0 WHERE id = ?').run(Number(req.params.id));
    if (ergebnis.changes === 0) return res.status(404).render('error', { message: 'Banner nicht gefunden.' });
    res.redirect('/admin/betrieb/banner?gespeichert=1');
  });

  function zeigeDatenschutz(res, { status = 200, text, kontaktEmail, fehlerText = null, gespeichert = false }) {
    res.status(status).render('admin/betrieb-datenschutz', { ...basis(db, 'datenschutz'), text, kontaktEmail, fehlerText, gespeichert });
  }

  router.get('/datenschutz', (req, res) => {
    zeigeDatenschutz(res, {
      text: getConfigValue(db, 'datenschutz_text') || '',
      kontaktEmail: getConfigValue(db, 'betrieb_kontakt_email') || '',
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/datenschutz', csrfProtection, (req, res) => {
    const text = typeof req.body.datenschutzText === 'string' ? req.body.datenschutzText.replace(/\r\n/g, '\n').trim() : '';
    const kontaktEmail = typeof req.body.kontaktEmail === 'string' ? req.body.kontaktEmail.trim() : '';
    let fehlerText = null;
    if (text.length < 1 || text.length > DATENSCHUTZ_MAX) fehlerText = `Der Datenschutztext muss zwischen 1 und ${DATENSCHUTZ_MAX} Zeichen lang sein.`;
    else if (!emailLockerGueltig(kontaktEmail)) fehlerText = 'Die Kontaktadresse ist ungültig (leer lassen oder eine Adresse mit genau einem @).';
    if (fehlerText) return zeigeDatenschutz(res, { status: 400, text, kontaktEmail, fehlerText });
    setConfigValue(db, 'datenschutz_text', text);
    setConfigValue(db, 'betrieb_kontakt_email', kontaktEmail);
    res.redirect('/admin/betrieb/datenschutz?gespeichert=1');
  });

  return router;
}
