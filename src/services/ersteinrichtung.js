import { getConfigValue, setConfigValue } from '../db/adminConfigRepo.js';

const TAGE_7_MS = 7 * 24 * 60 * 60 * 1000;

// Reihenfolge und Pflicht-Flags sind verbindlich (Spec Ersteinrichtung).
export const SCHRITTE = [
  { id: 'grundlagen', titel: 'Technische Grundlagen', beschreibung: 'Prüft, ob alle nötigen Einstellungen des Servers vorhanden und gültig sind.', pflicht: true, link: '/admin/betrieb/status', manuell: false },
  { id: 'rollen', titel: 'Superadmin festlegen', beschreibung: 'Mindestens eine aktive Person muss in der ChurchTools-Gruppe der Superadmins sein.', pflicht: true, link: '/admin/personen', manuell: false },
  { id: 'churchtools', titel: 'ChurchTools verbinden', beschreibung: 'Der Abgleich der Personen mit ChurchTools muss einmal erfolgreich gelaufen sein.', pflicht: true, link: '/admin/sync', manuell: false },
  { id: 'mail', titel: 'E-Mail-Versand testen', beschreibung: 'Verschicke eine Testmail, damit sicher ist, dass Benachrichtigungen ankommen.', pflicht: true, link: '/admin/ersteinrichtung#technik-mailserver', linkText: 'Zum Mailserver (Technische Grundlagen)', manuell: false },
  { id: 'konten', titel: 'Erstes Konto anlegen', beschreibung: 'Lege mindestens ein aktives Konto mit Freigeber 1 und Freigeber 2 an.', pflicht: true, link: '/admin/konten', manuell: false },
  { id: 'zeitstempel', titel: 'Zeitstempel einrichten', beschreibung: 'Trage einen Zeitstempeldienst ein oder verzichte bewusst darauf.', pflicht: true, link: '/admin/zeitstempel', manuell: false },
  { id: 'sicherung', titel: 'Datensicherung prüfen', beschreibung: 'Die automatische Sicherung muss in den letzten 7 Tagen erfolgreich gelaufen sein.', pflicht: true, link: '/admin/backup', manuell: false },
  { id: 'kontakt', titel: 'Kontakt für Fragen', beschreibung: 'Hinterlege eine E-Mail-Adresse, an die sich Personen bei Fragen wenden können.', pflicht: true, link: '/admin/betrieb/datenschutz', manuell: false },
  { id: 'branding', titel: 'Erscheinungsbild', beschreibung: 'Passe Titel, Logo und Farben des Portals an deine Organisation an.', pflicht: false, link: '/admin/erscheinungsbild', manuell: false },
  { id: 'kreditoren', titel: 'Lieferanten erfassen', beschreibung: 'Erfasse die wichtigsten Lieferanten (Kreditoren), damit Rechnungen schneller zugeordnet werden.', pflicht: false, link: '/admin/kreditoren', manuell: false },
  { id: 'module', titel: 'Module prüfen', beschreibung: 'Schalte Module wie Spesen oder Kreditkarten ein oder aus.', pflicht: false, link: '/admin/module', manuell: true },
  { id: 'mailvorlagen', titel: 'Mail-Vorlagen prüfen', beschreibung: 'Kontrolliere die Texte der automatischen Mails und passe sie bei Bedarf an.', pflicht: false, link: '/admin/mail-einstellungen', manuell: true },
  { id: 'monitoring', titel: 'Überwachung einrichten', beschreibung: 'Erzeuge einen Schlüssel, damit ein Überwachungsdienst den Zustand des Portals prüfen kann.', pflicht: false, link: '/admin/betrieb/status', manuell: false },
  { id: 'jobs', titel: 'Geplante Jobs prüfen', beschreibung: 'Die wichtigsten automatischen Aufgaben sollen mindestens einmal gelaufen sein.', pflicht: false, link: '/admin/geplante-jobs', manuell: false },
];

const hat = (db, sql, ...args) => Boolean(db.prepare(sql).get(...args));
const cfg = (db, key) => (getConfigValue(db, key) || '').trim();

export const STANDARD_TITEL = 'Freigabeportal';
const ABSCHLUSS_KEY = 'einrichtung_abgeschlossen_am';

// Einmal festgehaltener Abschluss (ISO), sonst null. Wird nie zurückgesetzt.
export function einrichtungAbgeschlossenAm(db) {
  return cfg(db, ABSCHLUSS_KEY) || null;
}

const DATUM = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' });
export function datumAnzeige(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? DATUM.format(d) : '';
}

// Letzte erfolgreiche Sicherung jünger als 7 Tage.
export function sicherungAktuell(db, jetzt = new Date()) {
  const ok = db.prepare("SELECT beendet_am FROM cron_log WHERE job = 'datenbank-sicherung' AND status = 'erfolg' ORDER BY id DESC LIMIT 1").get();
  const t = ok?.beendet_am ? new Date(ok.beendet_am).getTime() : NaN;
  return Number.isFinite(t) && jetzt.getTime() - t < TAGE_7_MS;
}

// Nur die Messung der Mailprüfung ist separat, damit sie einzeln testbar ist.
export function mailErledigt(db) {
  return hat(db, "SELECT 1 FROM mail_log WHERE typ = 'testmail' AND status = 'versendet' LIMIT 1");
}

// Namen (ohne E-Mail) der aktiven Personen einer ChurchTools-Gruppe, alphabetisch.
function namenInGruppe(db, gid) {
  return db.prepare('SELECT vorname, nachname, gruppen FROM personen WHERE aktiv = 1').all()
    .filter((r) => JSON.parse(r.gruppen).includes(String(gid)))
    .map((r) => `${r.vorname || ''} ${r.nachname || ''}`.trim())
    .sort((a, b) => a.localeCompare(b, 'de'));
}

function messe(id, db, config, jetzt, technik, tsaErgebnis) {
  switch (id) {
    case 'grundlagen': {
      if (!technik) return { erledigt: false, hinweis: 'noch nicht geprüft' };
      const pruefungen = Array.isArray(technik) ? technik : (technik.pruefungen || []);
      const schlecht = pruefungen.filter((p) => p.status === 'fehlt' || p.status === 'ungültig');
      return schlecht.length ? { erledigt: false, hinweis: `${schlecht.length} Prüfung(en) nicht in Ordnung` } : { erledigt: true };
    }
    case 'rollen': {
      const ct = config?.churchtools || {};
      const admin = ct.groupIdAdmin ? namenInGruppe(db, ct.groupIdAdmin) : [];
      const manager = ct.groupIdManager ? namenInGruppe(db, ct.groupIdManager) : null;
      return { erledigt: admin.length > 0, rollenPersonen: { admin, manager } };
    }
    case 'churchtools': {
      const r = db.prepare('SELECT status FROM sync_log WHERE beendet_am IS NOT NULL ORDER BY id DESC LIMIT 1').get();
      return { erledigt: r?.status === 'erfolg' };
    }
    case 'mail': return { erledigt: mailErledigt(db) };
    case 'konten':
      return { erledigt: hat(db, 'SELECT 1 FROM konten WHERE aktiv = 1 AND freigeber1_id IS NOT NULL AND freigeber2_id IS NOT NULL LIMIT 1') };
    case 'zeitstempel': {
      if (cfg(db, 'einrichtung_ohne_zeitstempel') === '1') return { erledigt: true };
      if (cfg(db, 'zeitstempel_tsa_url') === '') return { erledigt: false };
      // Ohne Vertrauensanker lassen sich die Zeitstempel nicht prüfen.
      if (!config?.tsaTrustAnchorsFile || !config?.tsaTrustAnchorsSha256) {
        return { erledigt: false, hinweis: 'Vertrauensanker fehlen: TSA_TRUST_ANCHORS_FILE und TSA_TRUST_ANCHORS_SHA256 beim Hoster eintragen.' };
      }
      // Zwischengespeichertes Ergebnis der TSA-Probe; unbekannt (null) blockiert nicht.
      if (tsaErgebnis?.erreichbar === false) return { erledigt: false, hinweis: 'Zeitstempeldienst nicht erreichbar.' };
      return { erledigt: true };
    }
    case 'sicherung': return { erledigt: sicherungAktuell(db, jetzt) };
    case 'kontakt': return { erledigt: cfg(db, 'betrieb_kontakt_email') !== '' };
    case 'branding': {
      const titel = cfg(db, 'seiten_titel');
      const logo = cfg(db, 'branding_logo_pfad') !== '' || cfg(db, 'branding_logo_dunkel_pfad') !== '';
      return { erledigt: (titel !== '' && titel !== STANDARD_TITEL) || logo };
    }
    case 'kreditoren': return { erledigt: hat(db, 'SELECT 1 FROM kreditoren LIMIT 1') };
    case 'module':
    case 'mailvorlagen': return { erledigt: cfg(db, `einrichtung_markiert_${id}`) === '1' };
    case 'monitoring': return { erledigt: cfg(db, 'monitoring_secret') !== '' };
    case 'jobs': {
      // mail-zustellung protokolliert nur Läufe mit fälligen Mails und taugt nicht als Nachweis.
      const sync = hat(db, 'SELECT 1 FROM sync_log LIMIT 1');
      const pool = hat(db, "SELECT 1 FROM cron_log WHERE job = 'pool-erinnerungen' AND status != 'laufend' LIMIT 1");
      return { erledigt: sync && pool };
    }
    default: return { erledigt: false };
  }
}

// Misst den aktuellen Stand. Sind erstmals alle Pflichtschritte erledigt, wird der Abschluss
// einmalig festgehalten (einrichtung_abgeschlossen_am); danach bleibt er, auch wenn ein Schritt
// später wieder offen ist. Die Schritte zeigen trotzdem immer den echten Stand.
export function einrichtungsStand(db, config, { jetzt = new Date(), technik, tsaErgebnis = null } = {}) {
  const schritte = SCHRITTE.map(({ manuell, ...s }) => {
    const { erledigt, hinweis, ...details } = messe(s.id, db, config, jetzt, technik, tsaErgebnis);
    return { ...s, erledigt, ...(hinweis ? { hinweis } : {}), ...details };
  });
  const pflicht = schritte.filter((s) => s.pflicht);
  const pflichtOffen = pflicht.filter((s) => !s.erledigt).length;
  let abgeschlossenAm = einrichtungAbgeschlossenAm(db);
  if (!abgeschlossenAm && pflichtOffen === 0) {
    abgeschlossenAm = jetzt.toISOString();
    setConfigValue(db, ABSCHLUSS_KEY, abgeschlossenAm);
  }
  return { schritte, pflichtGesamt: pflicht.length, pflichtOffen, abgeschlossenAm };
}

export function markiereSchritt(db, id, wert) {
  const s = SCHRITTE.find((x) => x.id === id);
  if (!s || !s.manuell) throw new Error(`Schritt "${id}" kann nicht von Hand markiert werden.`);
  setConfigValue(db, `einrichtung_markiert_${id}`, wert ? '1' : '0');
}

export function setzeOhneZeitstempel(db, wert) {
  setConfigValue(db, 'einrichtung_ohne_zeitstempel', wert ? '1' : '0');
}
