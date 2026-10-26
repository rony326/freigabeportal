// Kommentare an Rechnungen/Spesenpositionen (docs/superpowers/specs/2026-10-25-kommentare-design.md).
// Sichtbarkeit = canViewJobPdf ODER das Recht, das /admin/vorgaenge schützt (vorgaenge_einsehen,
// inkl. Superadmin-/Manager-Bundle über personHasPermission). Niemand sonst, auch nicht über @Name.
import { getKontoById } from '../db/kontenRepo.js';
import { getEffectiveFreigeber2Id, getJobById } from '../db/jobsRepo.js';
import { getPersonById, listActivePersonsInGroup } from '../db/personenRepo.js';
import { personHasPermission } from '../middleware/permissions.js';
import { canViewJobPdf } from './jobAuthorization.js';
import { ermittleZustaendigkeit, LAUFENDE_STATUS } from './vorgangZustaendigkeit.js';
import { getAktivenVertreter } from './vertretung.js';
import { reiheBenachrichtigungEin, renderBenachrichtigung } from './notify.js';
import { getVorlage } from './mailTemplates.js';
import { getDefaultConfigValue } from '../db/adminConfigRepo.js';
import { logMailAttempt } from '../db/mailLogRepo.js';
import { stelleEintraegeZu } from './mailZustellung.js';

export const KOMMENTAR_GESCHLOSSEN_STATUS = ['abgeschlossen', 'abgeholt', 'archiviert', 'geloescht'];
export const KOMMENTAR_MAX_LAENGE = 2000;

const name = (p) => `${p.vorname} ${p.nachname}`;

export function darfKommentareSehen(db, config, person, job) {
  if (!person || person.aktiv === false || !job) return false;
  return canViewJobPdf(db, config, person, job) || personHasPermission(db, config, person, 'vorgaenge_einsehen');
}

// Geschlossen: die Status oben, dazu ein aufgesplitteter Elternvorgang, sobald sein Gruppen-PDF
// erzeugt ist (gruppe_pdf_pfad) — danach erreicht ein neuer Kommentar das archivierte PDF nicht mehr.
export function istKommentarGeschlossen(job) {
  if (!job) return true;
  return KOMMENTAR_GESCHLOSSEN_STATUS.includes(job.status) || (job.status === 'aufgesplittet' && Boolean(job.gruppe_pdf_pfad));
}

export function darfKommentieren(db, config, person, job) {
  return darfKommentareSehen(db, config, person, job) && !istKommentarGeschlossen(job);
}

// Alle aktiven Personen in EINER Abfrage (gleiche Form wie getPersonById).
function aktivePersonen(db) {
  return db
    .prepare('SELECT * FROM personen WHERE aktiv = 1')
    .all()
    .map((row) => ({ ...row, gruppen: JSON.parse(row.gruppen), aktiv: Boolean(row.aktiv), ct_person_unresolved: Boolean(row.ct_person_unresolved) }));
}

// Wie darfKommentareSehen, aber für viele Personen eines Vorgangs: Konto, Vertretungen und
// Rechte-Inhaber werden einmal vorab geladen, danach prüft das Prädikat nur noch im Speicher.
// Spiegelt canViewJobPdf (jobAuthorization.js) und personHasPermission('vorgaenge_einsehen')
// exakt; der Unit-Test "Sichtbarkeits-Prädikat = darfKommentareSehen" hält beides gleich.
function sichtbarkeitFuer(db, config, job) {
  const gruppe = (key) => (config.churchtools?.[key] ? String(config.churchtools[key]) : null);
  const admin = gruppe('groupIdAdmin');
  const buchhaltung = gruppe('groupIdBuchhaltung');
  const manager = gruppe('groupIdManager');
  const inGruppe = (p, g) => Boolean(g) && p.gruppen.includes(g);
  const ueberRolle = new Set();
  if (job.status !== 'unzugewiesen') {
    const mitVertretung = (id) => {
      if (!id) return;
      ueberRolle.add(id);
      const vertreter = getAktivenVertreter(db, id);
      if (vertreter) ueberRolle.add(vertreter);
    };
    mitVertretung(job.zugewiesen_an);
    if (job.eingereicht_von) ueberRolle.add(job.eingereicht_von);
    const konto = job.konto_id ? getKontoById(db, job.konto_id) : null;
    if (konto) mitVertretung(getEffectiveFreigeber2Id(job, konto));
  }
  const mitRecht = new Set(
    db.prepare("SELECT person_id FROM person_berechtigungen WHERE berechtigung = 'vorgaenge_einsehen'").all().map((r) => r.person_id)
  );
  return (p) => {
    if (!p || p.aktiv === false) return false;
    if (inGruppe(p, admin) || inGruppe(p, manager)) return true;
    if (mitRecht.has(p.churchtools_person_id)) return true;
    if (job.status === 'unzugewiesen') return inGruppe(p, buchhaltung);
    return ueberRolle.has(p.churchtools_person_id);
  };
}

export function erwaehnbarePersonen(db, config, job) {
  const sieht = sichtbarkeitFuer(db, config, job);
  return aktivePersonen(db)
    .filter(sieht)
    .map((p) => ({ id: p.churchtools_person_id, name: name(p) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

const WORTZEICHEN = /[\p{L}\p{N}_-]/u;
const escapeRegex = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameSchluessel = (n) => String(n).normalize('NFC').trim().split(/\s+/).join(' ').toLocaleLowerCase('de');

// Interner Parser: je "@"-Erwähnung die Gruppe gleichnamiger Kandidaten (längster Name gewinnt).
// Text und Namen werden NFC-normalisiert; zwischen den Namensteilen passt jede Folge von Leerraum
// (auch NBSP/Zeilenumbruch). Gross/klein über das Regex-Flag `i` (Unicode), also ohne Index-
// Verschiebung durch eine kleingeschriebene Kopie des Textes.
function parseErwaehnungen(text, kandidaten) {
  const muster = kandidaten
    .map((k) => {
      const teile = String(k.name).normalize('NFC').trim().split(/\s+/).filter(Boolean);
      return {
        id: k.id,
        name: teile.join(' '),
        schluessel: nameSchluessel(k.name),
        re: new RegExp(`^${teile.map(escapeRegex).join('\\s+')}(?![\\p{L}\\p{N}_-])`, 'iu'),
      };
    })
    .filter((m) => m.name)
    .sort((x, y) => y.name.length - x.name.length);
  const treffer = [];
  const unbekannt = [];
  const s = String(text ?? '').normalize('NFC');
  for (let i = s.indexOf('@'); i !== -1; i = s.indexOf('@', i + 1)) {
    if (i > 0 && WORTZEICHEN.test(s[i - 1])) continue;
    const rest = s.slice(i + 1);
    const erster = muster.find((m) => m.re.test(rest));
    if (erster) {
      const ids = muster.filter((m) => m.schluessel === erster.schluessel && m.re.test(rest)).map((m) => m.id);
      if (!treffer.some((t) => t.schluessel === erster.schluessel)) treffer.push({ name: erster.name, schluessel: erster.schluessel, ids });
      continue;
    }
    // Nur "@Wort Wort" (erstes Wort beginnt mit einem Buchstaben, das zweite mit einem Grossbuchstaben)
    // gilt als Versuch, eine Person zu erwähnen. "@10 Uhr", "@CHF 20" oder ein einzelnes "@Wort" bleiben
    // gewöhnlicher Text.
    const m = rest.match(/^\p{L}[\p{L}\p{N}_-]*[ \t\u00A0]+\p{Lu}[\p{L}\p{N}_-]*/u);
    if (m) {
      const wort = m[0].replace(/\s+/g, ' ');
      if (!unbekannt.includes(wort)) unbekannt.push(wort);
    }
  }
  return { treffer, unbekannt };
}

// Erkennt "@Vorname Nachname" (gross/klein egal, längster passender Name gewinnt, danach muss eine
// Wortgrenze folgen). Ein "@" mitten in einem Wort (E-Mail-Adresse) ist keine Erwähnung. Ein
// "@Wort Wort" ohne passenden Kandidaten (erstes Wort mit Buchstabe, zweites mit Grossbuchstabe am
// Anfang) landet in `unbekannt`; "@10 Uhr", "@CHF 20" oder ein einzelnes "@Wort" sind normaler Text.
// Gleichnamige Kandidaten liefern alle ihre IDs.
export function findeErwaehnungen(text, kandidaten) {
  const { treffer, unbekannt } = parseErwaehnungen(text, kandidaten);
  const ids = [];
  for (const t of treffer) for (const id of t.ids) if (!ids.includes(id)) ids.push(id);
  return { ids, unbekannt };
}

// Wer muss jetzt handeln? Zuständige Person samt aktiver Vertretung; bei einer Eskalation an die
// Admin-Gruppe deren aktive Mitglieder (nur Superadmins dürfen dann Kontierung/Freigabe 2 öffnen,
// siehe kontierungZugriff.js / freigabe2.js).
function aktuellVerantwortlich(db, config, job) {
  const ids = new Set();
  const zustaendig = ermittleZustaendigkeit(db, job);
  if (zustaendig.art === 'person' && zustaendig.personId) {
    ids.add(zustaendig.personId);
    const vertreter = getAktivenVertreter(db, zustaendig.personId);
    if (vertreter) ids.add(vertreter);
  } else if (zustaendig.art === 'admin' && config.churchtools?.groupIdAdmin) {
    for (const p of listActivePersonsInGroup(db, config.churchtools.groupIdAdmin)) ids.add(p.churchtools_person_id);
  }
  return ids;
}

function ermittleEmpfaenger(db, config, job, { schreiberId, erwaehntIds = [] } = {}) {
  const verantwortlich = aktuellVerantwortlich(db, config, job);
  const kandidaten = [...verantwortlich];
  const mitVertretung = (id) => {
    if (!id) return;
    kandidaten.push(id);
    const vertreter = getAktivenVertreter(db, id);
    if (vertreter) kandidaten.push(vertreter);
  };
  mitVertretung(job.zugewiesen_an);
  const konto = job.konto_id ? getKontoById(db, job.konto_id) : null;
  if (konto) {
    mitVertretung(konto.freigeber1_id);
    mitVertretung(getEffectiveFreigeber2Id(job, konto));
  }
  if (job.eingereicht_von) kandidaten.push(job.eingereicht_von);
  for (const r of db.prepare('SELECT person_id FROM kommentare WHERE job_id = ? GROUP BY person_id ORDER BY MIN(id)').all(job.id)) {
    kandidaten.push(r.person_id);
  }
  kandidaten.push(...erwaehntIds);

  const ergebnis = [];
  const gesehen = new Set();
  for (const id of kandidaten) {
    if (!id || id === schreiberId || gesehen.has(id)) continue;
    gesehen.add(id);
    const person = getPersonById(db, id);
    if (person && darfKommentareSehen(db, config, person, job)) {
      ergebnis.push({ person, link: linkFuer(db, config, person, job, verantwortlich) });
    }
  }
  return ergebnis;
}

// Spec Entscheidung 3 plus Rulings: zuständige Person bzw. bei Admin-Eskalation die Admin-Gruppe
// (je + aktive Vertretung), job.zugewiesen_an (Freigeber 1 des Vorgangs) + Vertretung, Freigeber 1
// und effektiver Freigeber 2 des Kontos (je + Vertretung), einreichende Person, frühere
// Kommentierende, Erwähnte. Gefiltert auf darfKommentareSehen, ohne Schreiber, eindeutig.
export function beteiligte(db, config, job, optionen = {}) {
  return ermittleEmpfaenger(db, config, job, optionen).map((e) => e.person.churchtools_person_id);
}

// Arbeitsseite der zuständigen Person, oder null, wenn diese Person dort keinen Zugang hätte:
// Pool-Vorgänge haben keine zuständige Person, eine abgelehnte Spesen-Position hat keine
// Arbeitsseite (/abgelehnt verweigert Spesen), und /spesen-freigabe1 öffnet nur die zugewiesene
// Prüfperson bzw. bei Eskalation die Admins — nicht deren Ferienvertretung.
function workflowLink(config, job, personId) {
  const basis = config.publicBaseUrl;
  if (job.status === 'freigabe2') return `${basis}/freigabe2/${job.id}`;
  if (job.status === 'abgelehnt') return job.quelle === 'spesen' ? null : `${basis}/abgelehnt/${job.id}`;
  if (job.status !== 'zugewiesen') return null;
  if (job.quelle === 'spesen') {
    return job.freigabe1_eskaliert_an_admin || job.zugewiesen_an === personId ? `${basis}/spesen-freigabe1/${job.id}` : null;
  }
  // KK-Abrechnungen bearbeitet man im Abgleich (/kontierung/:id leitet dorthin um).
  return job.kreditkarte_id ? `${basis}/kontierung/${job.id}/kk-abgleich` : `${basis}/kontierung/${job.id}`;
}

// Sieht die Person den Vorgang über eine eigene Rolle (canViewJobPdf ohne den Superadmin-Freipass)?
function siehtUeberRolle(db, config, person, job) {
  const adminGruppe = config.churchtools?.groupIdAdmin ? String(config.churchtools.groupIdAdmin) : null;
  const ohneAdmin = adminGruppe ? { ...person, gruppen: (person.gruppen || []).filter((g) => String(g) !== adminGruppe) } : person;
  return canViewJobPdf(db, config, ohneAdmin, job);
}

export const KEIN_DIREKTLINK = 'kein Direktlink (der Vorgang ist nicht mehr in Bearbeitung; die Kommentare stehen auf dem archivierten PDF)';

// Ruling Fix-Runde 1 + Abschlussprüfung 3–5: jeder Link führt auf eine Seite, die die Person
// öffnen darf. Aktuell zuständig → Arbeitsseite (sofern sie dort Zugang hat); über eine eigene Rolle
// sichtbar → /zeitstempel-pruefen?jobId=… (canViewJobPdf-geschützt); nur über das Vorgänge-Recht
// sichtbar → Admin-Vorgang-Detail, aber nur für laufende Vorgänge (sonst 404) — danach die
// Zeitstempel-Prüfseite, wenn canViewJobPdf (Superadmins), sonst kein Link, nur ein kurzer Hinweis.
function linkFuer(db, config, person, job, verantwortlich) {
  const basis = config.publicBaseUrl;
  const id = person.churchtools_person_id;
  const pruefseite = `${basis}/zeitstempel-pruefen?jobId=${job.id}#kommentare`;
  const arbeit = verantwortlich.has(id) ? workflowLink(config, job, id) : null;
  if (arbeit) return `${arbeit}#kommentare`;
  if (siehtUeberRolle(db, config, person, job)) return pruefseite;
  if (LAUFENDE_STATUS.includes(job.status) && personHasPermission(db, config, person, 'vorgaenge_einsehen')) {
    return `${basis}/admin/vorgaenge/${job.id}#kommentare`;
  }
  if (canViewJobPdf(db, config, person, job)) return pruefseite;
  return KEIN_DIREKTLINK;
}

// Vorlage `kommentar`; fehlt ein Teil (gelöscht/leer), gilt die Werkseinstellung (Ruling 2): ein
// kaputtes Admin-Setup darf keinen Kommentar verlieren.
function kommentarVorlage(db) {
  const v = getVorlage(db, 'kommentar');
  const oder = (wert, key) => (typeof wert === 'string' && wert.trim() ? wert : getDefaultConfigValue(key));
  return {
    betreff: oder(v.betreff, 'mail_vorlage_kommentar_betreff'),
    text: oder(v.text, 'mail_vorlage_kommentar_text'),
  };
}

// Rendert die Mail für einen Empfänger. Scheitert das trotz Rückfall, bleibt der Kommentar stehen:
// Fehler loggen (wie sendNotification) und den Versuch als 'fehlgeschlagen' in mail_log festhalten.
function rendereKommentarMail(db, vorlage, { to, jobId, variablen }) {
  try {
    return renderBenachrichtigung(db, 'kommentar', variablen, vorlage);
  } catch (err) {
    console.error('erfasseKommentar: Mail-Vorlage konnte nicht gerendert werden, Kommentar bleibt gespeichert', err);
    try {
      logMailAttempt(db, {
        typ: 'kommentar',
        jobId,
        empfaenger: to,
        betreff: '(Vorlage konnte nicht gerendert werden)',
        text: '(Vorlage konnte nicht gerendert werden)',
        status: 'fehlgeschlagen',
        fehlerDetails: err.message,
      });
    } catch (logErr) {
      console.error('erfasseKommentar: logMailAttempt nach Vorlagenfehler gescheitert', logErr);
    }
    return null;
  }
}

// Validiert, speichert den Kommentar und reiht die Mails in EINER Transaktion ein (kein Kommentar →
// keine Mail; keine Mail ohne Kommentar). Die SMTP-Zustellung läuft danach im Hintergrund und
// blockiert die Anfrage nicht; scheitert sie, wiederholt der mail-zustellung-Job die eingereihten
// Zeilen. `zustellung` ist das Promise dieser Zustellung (für Tests; Routen müssen es nicht abwarten).
// Ein Vorlagenfehler verhindert nur die betroffene Mail, nie den Kommentar (Ruling 2); scheitert das
// Speichern oder Einreihen selbst (DB), wird alles zurückgerollt und der Fehler geworfen.
//
// NICHT innerhalb einer Transaktion des Aufrufers aufrufen (N1): der SAVEPOINT funktioniert zwar
// geschachtelt, aber die Hintergrund-Zustellung startet direkt nach RELEASE — also bevor der
// Aufrufer COMMIT/ROLLBACK macht. Ein späteres ROLLBACK des Aufrufers würde Kommentar und mail_log-
// Zeilen verwerfen, während die Mails schon unterwegs sind. Die Route /kommentare ruft die Funktion
// deshalb ausserhalb jeder Transaktion auf.
export async function erfasseKommentar(db, config, mailer, { job, person, text, jetzt = new Date() }) {
  const sauber = String(text ?? '').normalize('NFC').trim();
  const fehler = [];
  if (!darfKommentieren(db, config, person, job)) {
    return {
      ok: false,
      fehler: [job && istKommentarGeschlossen(job) && darfKommentareSehen(db, config, person, job)
        ? 'Dieser Vorgang ist abgeschlossen; neue Kommentare sind nicht mehr möglich.'
        : 'Du darfst diesen Vorgang nicht kommentieren.'],
    };
  }
  if (sauber.length < 1) fehler.push('Bitte einen Kommentar eingeben.');
  if (sauber.length > KOMMENTAR_MAX_LAENGE) fehler.push(`Der Kommentar ist zu lang (höchstens ${KOMMENTAR_MAX_LAENGE} Zeichen).`);

  // Ein Durchgang gegen alle aktiven Personen (längster Name gewinnt), danach Einordnung: von einer
  // gleichnamigen Gruppe gelten die sichtbaren als gemeint; ist keine sichtbar → Fehler mit Namen.
  const alle = aktivePersonen(db);
  const sichtbar = new Set(alle.filter(sichtbarkeitFuer(db, config, job)).map((p) => p.churchtools_person_id));
  const { treffer, unbekannt } = parseErwaehnungen(sauber, alle.map((p) => ({ id: p.churchtools_person_id, name: name(p) })));
  const ids = [];
  for (const t of treffer) {
    const erlaubt = t.ids.filter((id) => sichtbar.has(id));
    if (!erlaubt.length) fehler.push(`${t.name} darf diesen Vorgang nicht sehen und kann nicht erwähnt werden.`);
    for (const id of erlaubt) if (!ids.includes(id)) ids.push(id);
  }
  for (const u of unbekannt) fehler.push(`Unbekannte Person: @${u}`);
  if (fehler.length) return { ok: false, fehler };

  let id;
  const eintraege = [];
  db.exec('SAVEPOINT kommentar_erfassen');
  try {
    id = Number(
      db
        .prepare('INSERT INTO kommentare (job_id, person_id, text, erwaehnt, erstellt_am) VALUES (?, ?, ?, ?, ?)')
        .run(job.id, person.churchtools_person_id, sauber, JSON.stringify(ids), jetzt.toISOString()).lastInsertRowid
    );
    const verfasserName = name(person);
    const vorlage = kommentarVorlage(db);
    for (const { person: empfaenger, link } of ermittleEmpfaenger(db, config, job, { schreiberId: person.churchtools_person_id, erwaehntIds: ids })) {
      if (!empfaenger.email) continue;
      const variablen = { empfaengerName: name(empfaenger), verfasserName, kommentarText: sauber, jobId: job.id, jobDateiname: job.dateiname, link };
      const gerendert = rendereKommentarMail(db, vorlage, { to: empfaenger.email, jobId: job.id, variablen });
      if (!gerendert) continue;
      eintraege.push(reiheBenachrichtigungEin(db, { to: empfaenger.email, typ: 'kommentar', jobId: job.id, variablen, gerendert }));
    }
    db.exec('RELEASE kommentar_erfassen');
  } catch (err) {
    // N2: scheitert das Zurückrollen selbst, bleibt der ursprüngliche Fehler der geworfene.
    try {
      db.exec('ROLLBACK TO kommentar_erfassen');
      db.exec('RELEASE kommentar_erfassen');
    } catch (rollbackErr) {
      console.error('erfasseKommentar: ROLLBACK TO kommentar_erfassen gescheitert', rollbackErr);
    }
    throw err;
  }
  const zustellung = stelleEintraegeZu(db, mailer, eintraege).catch((err) => {
    console.error('erfasseKommentar: Zustellung fehlgeschlagen, mail-zustellung wiederholt', err);
  });
  return { ok: true, id, zustellung };
}

export function listeKommentare(db, jobId) {
  return db
    .prepare(
      `SELECT k.id, k.text, k.erstellt_am, k.person_id,
              COALESCE(p.vorname || ' ' || p.nachname, 'Unbekannte Person') AS verfasser_name
       FROM kommentare k LEFT JOIN personen p ON p.churchtools_person_id = k.person_id
       WHERE k.job_id = ? ORDER BY k.erstellt_am, k.id`
    )
    .all(jobId)
    .map((r) => ({ ...r }));
}

export function kommentarInfo(db, jobIds, personId) {
  const info = new Map();
  const ids = [...new Set(jobIds.map(Number))];
  if (!ids.length) return info;
  const rows = db
    .prepare(
      `SELECT k.job_id,
              COUNT(*) AS anzahl,
              SUM(CASE WHEN k.person_id <> ? AND (g.zuletzt_am IS NULL OR k.erstellt_am > g.zuletzt_am) THEN 1 ELSE 0 END) AS neu
       FROM kommentare k
       LEFT JOIN kommentar_gelesen g ON g.job_id = k.job_id AND g.person_id = ?
       WHERE k.job_id IN (SELECT value FROM json_each(?))
       GROUP BY k.job_id`
    )
    .all(personId, personId, JSON.stringify(ids));
  for (const r of rows) info.set(r.job_id, { anzahl: r.anzahl, neu: r.neu });
  return info;
}

// Wie kommentarInfo, aber nur für Vorgänge, deren Kommentare die Person sehen darf (darfKommentareSehen).
// Eine Abfrage für die Zählung; die Sichtprüfung läuft nur für Vorgänge MIT Kommentaren und entfällt
// ganz, wenn die Person ohnehin alles sieht (vorgaenge_einsehen).
export function kommentarInfoFuer(db, config, person, jobIds) {
  const info = kommentarInfo(db, jobIds, person.churchtools_person_id);
  if (!info.size || personHasPermission(db, config, person, 'vorgaenge_einsehen')) return info;
  for (const id of [...info.keys()]) {
    if (!darfKommentareSehen(db, config, person, getJobById(db, id))) info.delete(id);
  }
  return info;
}

export function markiereGelesen(db, jobId, personId, jetzt = new Date()) {
  db.prepare(
    `INSERT INTO kommentar_gelesen (job_id, person_id, zuletzt_am) VALUES (?, ?, ?)
     ON CONFLICT(job_id, person_id) DO UPDATE SET zuletzt_am = MAX(kommentar_gelesen.zuletzt_am, excluded.zuletzt_am)`
  ).run(jobId, personId, jetzt.toISOString());
}
