import { getConfigValue, setConfigValue } from '../db/adminConfigRepo.js';

const TAGE_7_MS = 7 * 24 * 60 * 60 * 1000;

// Reihenfolge und Pflicht-Flags sind verbindlich (Spec Ersteinrichtung).
export const SCHRITTE = [
  { id: 'grundlagen', titel: 'Technische Grundlagen', beschreibung: 'Prüft, ob alle nötigen Einstellungen des Servers vorhanden und gültig sind.', pflicht: true, link: '/admin/betrieb/status', manuell: false },
  { id: 'rollen', titel: 'Superadmin festlegen', beschreibung: 'Mindestens eine aktive Person muss in der ChurchTools-Gruppe der Superadmins sein.', pflicht: true, link: '/admin/personen', manuell: false },
  { id: 'churchtools', titel: 'ChurchTools verbinden', beschreibung: 'Der Abgleich der Personen mit ChurchTools muss einmal erfolgreich gelaufen sein.', pflicht: true, link: '/admin/sync', manuell: false },
  { id: 'mail', titel: 'E-Mail-Versand testen', beschreibung: 'Verschicke eine Testmail, damit sicher ist, dass Benachrichtigungen ankommen.', pflicht: true, link: '/admin/mail-einstellungen', manuell: false },
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

const KERN_JOBS = ['pool-erinnerungen', 'mail-zustellung'];

const hat = (db, sql, ...args) => Boolean(db.prepare(sql).get(...args));
const cfg = (db, key) => (getConfigValue(db, key) || '').trim();

// Nur die Messung der Mailprüfung ist separat, damit sie einzeln testbar ist.
export function mailErledigt(db) {
  return hat(db, "SELECT 1 FROM mail_log WHERE typ = 'testmail' AND status = 'versendet' LIMIT 1");
}

function superadminVorhanden(db, config) {
  const gid = config?.churchtools?.groupIdAdmin;
  if (!gid) return false;
  return db.prepare('SELECT gruppen FROM personen WHERE aktiv = 1').all()
    .some((r) => JSON.parse(r.gruppen).includes(String(gid)));
}

function messe(id, db, config, jetzt, technik) {
  switch (id) {
    case 'grundlagen': {
      if (!technik) return { erledigt: false, hinweis: 'noch nicht geprüft' };
      const pruefungen = Array.isArray(technik) ? technik : (technik.pruefungen || []);
      const schlecht = pruefungen.filter((p) => p.status === 'fehlt' || p.status === 'ungültig');
      return schlecht.length ? { erledigt: false, hinweis: `${schlecht.length} Prüfung(en) nicht in Ordnung` } : { erledigt: true };
    }
    case 'rollen': return { erledigt: superadminVorhanden(db, config) };
    case 'churchtools': {
      const r = db.prepare('SELECT status FROM sync_log WHERE beendet_am IS NOT NULL ORDER BY id DESC LIMIT 1').get();
      return { erledigt: r?.status === 'erfolg' };
    }
    case 'mail': return { erledigt: mailErledigt(db) };
    case 'konten':
      return { erledigt: hat(db, 'SELECT 1 FROM konten WHERE aktiv = 1 AND freigeber1_id IS NOT NULL AND freigeber2_id IS NOT NULL LIMIT 1') };
    case 'zeitstempel':
      return { erledigt: cfg(db, 'zeitstempel_tsa_url') !== '' || cfg(db, 'einrichtung_ohne_zeitstempel') === '1' };
    case 'sicherung': {
      const ok = db.prepare("SELECT beendet_am FROM cron_log WHERE job = 'datenbank-sicherung' AND status = 'erfolg' ORDER BY id DESC LIMIT 1").get();
      const t = ok?.beendet_am ? new Date(ok.beendet_am).getTime() : NaN;
      return { erledigt: Number.isFinite(t) && jetzt.getTime() - t < TAGE_7_MS };
    }
    case 'kontakt': return { erledigt: cfg(db, 'betrieb_kontakt_email') !== '' };
    case 'branding': return { erledigt: cfg(db, 'seiten_titel') !== '' };
    case 'kreditoren': return { erledigt: hat(db, 'SELECT 1 FROM kreditoren LIMIT 1') };
    case 'module':
    case 'mailvorlagen': return { erledigt: cfg(db, `einrichtung_markiert_${id}`) === '1' };
    case 'monitoring': return { erledigt: cfg(db, 'monitoring_secret') !== '' };
    case 'jobs': {
      const sync = hat(db, 'SELECT 1 FROM sync_log LIMIT 1');
      const kern = KERN_JOBS.every((j) => hat(db, "SELECT 1 FROM cron_log WHERE job = ? AND status != 'laufend' LIMIT 1", j));
      return { erledigt: sync && kern };
    }
    default: return { erledigt: false };
  }
}

export function einrichtungsStand(db, config, { jetzt = new Date(), technik } = {}) {
  const schritte = SCHRITTE.map(({ manuell, ...s }) => {
    const m = messe(s.id, db, config, jetzt, technik);
    return { ...s, erledigt: m.erledigt, ...(m.hinweis ? { hinweis: m.hinweis } : {}) };
  });
  const pflicht = schritte.filter((s) => s.pflicht);
  return { schritte, pflichtGesamt: pflicht.length, pflichtOffen: pflicht.filter((s) => !s.erledigt).length };
}

export function markiereSchritt(db, id, wert) {
  const s = SCHRITTE.find((x) => x.id === id);
  if (!s || !s.manuell) throw new Error(`Schritt "${id}" kann nicht von Hand markiert werden.`);
  setConfigValue(db, `einrichtung_markiert_${id}`, wert ? '1' : '0');
}

export function setzeOhneZeitstempel(db, wert) {
  setConfigValue(db, 'einrichtung_ohne_zeitstempel', wert ? '1' : '0');
}
