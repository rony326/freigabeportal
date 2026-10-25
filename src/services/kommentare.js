// Kommentare an Rechnungen/Spesenpositionen (docs/superpowers/specs/2026-10-25-kommentare-design.md).
// Sichtbarkeit = canViewJobPdf ODER das Recht, das /admin/vorgaenge schützt (vorgaenge_einsehen,
// inkl. Superadmin-/Manager-Bundle über personHasPermission). Niemand sonst, auch nicht über @Name.
import { getKontoById } from '../db/kontenRepo.js';
import { getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { personHasPermission } from '../middleware/permissions.js';
import { canViewJobPdf } from './jobAuthorization.js';
import { ermittleZustaendigkeit } from './vorgangZustaendigkeit.js';
import { getAktivenVertreter, istAktiveVertretungFuer } from './vertretung.js';
import { sendNotification } from './notify.js';

export const KOMMENTAR_GESCHLOSSEN_STATUS = ['abgeschlossen', 'abgeholt', 'archiviert', 'geloescht'];
export const KOMMENTAR_MAX_LAENGE = 2000;

const name = (p) => `${p.vorname} ${p.nachname}`;

export function darfKommentareSehen(db, config, person, job) {
  if (!person || person.aktiv === false || !job) return false;
  return canViewJobPdf(db, config, person, job) || personHasPermission(db, config, person, 'vorgaenge_einsehen');
}

export function darfKommentieren(db, config, person, job) {
  return darfKommentareSehen(db, config, person, job) && !KOMMENTAR_GESCHLOSSEN_STATUS.includes(job.status);
}

function aktivePersonen(db) {
  return db
    .prepare('SELECT churchtools_person_id FROM personen WHERE aktiv = 1')
    .all()
    .map((r) => getPersonById(db, r.churchtools_person_id));
}

export function erwaehnbarePersonen(db, config, job) {
  return aktivePersonen(db)
    .filter((p) => darfKommentareSehen(db, config, p, job))
    .map((p) => ({ id: p.churchtools_person_id, name: name(p) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

const WORTZEICHEN = /[\p{L}\p{N}_-]/u;

// Erkennt "@Vorname Nachname" (gross/klein egal, längster passender Name gewinnt, danach muss eine
// Wortgrenze folgen). Ein "@" mitten in einem Wort (E-Mail-Adresse) ist keine Erwähnung. Ein "@"
// ohne passenden Kandidaten landet mit dem folgenden Wort (bzw. zwei, wenn das zweite gross
// beginnt) in `unbekannt`. Gleichnamige Kandidaten liefern alle ihre IDs.
export function findeErwaehnungen(text, kandidaten) {
  const sortiert = [...kandidaten].sort((a, b) => b.name.length - a.name.length);
  const ids = [];
  const unbekannt = [];
  const s = String(text ?? '');
  const klein = s.toLocaleLowerCase('de');
  for (let i = s.indexOf('@'); i !== -1; i = s.indexOf('@', i + 1)) {
    if (i > 0 && WORTZEICHEN.test(s[i - 1])) continue;
    const rest = klein.slice(i + 1);
    let laenge = 0;
    for (const k of sortiert) {
      const kName = k.name.toLocaleLowerCase('de');
      if (laenge && kName.length < laenge) break;
      if (rest.startsWith(kName) && !WORTZEICHEN.test(rest.charAt(kName.length))) {
        laenge = kName.length;
        if (!ids.includes(k.id)) ids.push(k.id);
      }
    }
    if (!laenge) {
      const m = s.slice(i + 1).match(/^[\p{L}\p{N}_-]+(?:[ \t]+\p{Lu}[\p{L}\p{N}_-]*)?/u);
      if (m && !unbekannt.includes(m[0])) unbekannt.push(m[0]);
    }
  }
  return { ids, unbekannt };
}

// Spec Entscheidung 3. Rollenbasierte Kandidaten: zuständige Person (+ aktive Vertretung),
// Freigeber 1 und effektiver Freigeber 2 des Kontos (je + aktive Vertretung), einreichende Person,
// frühere Kommentierende; dazu die Erwähnten. Admins ohne Rolle kommen damit nur über @Name (oder
// als frühere Kommentierende) hinein. Gefiltert auf darfKommentareSehen, ohne Schreiber, eindeutig.
export function beteiligte(db, config, job, { schreiberId, erwaehntIds = [] } = {}) {
  const kandidaten = [];
  const mitVertretung = (id) => {
    if (!id) return;
    kandidaten.push(id);
    const vertreter = getAktivenVertreter(db, id);
    if (vertreter) kandidaten.push(vertreter);
  };
  const zustaendig = ermittleZustaendigkeit(db, job);
  if (zustaendig.art === 'person') mitVertretung(zustaendig.personId);
  const konto = job.konto_id ? getKontoById(db, job.konto_id) : null;
  if (konto) {
    mitVertretung(konto.freigeber1_id);
    mitVertretung(getEffectiveFreigeber2Id(job, konto));
  }
  if (job.eingereicht_von) kandidaten.push(job.eingereicht_von);
  for (const r of db.prepare('SELECT DISTINCT person_id FROM kommentare WHERE job_id = ? ORDER BY id').all(job.id)) {
    kandidaten.push(r.person_id);
  }
  kandidaten.push(...erwaehntIds);

  const ergebnis = [];
  for (const id of kandidaten) {
    if (!id || id === schreiberId || ergebnis.includes(id)) continue;
    const person = getPersonById(db, id);
    if (person && darfKommentareSehen(db, config, person, job)) ergebnis.push(id);
  }
  return ergebnis;
}

function workflowLink(config, job) {
  const basis = config.publicBaseUrl;
  if (job.status === 'unzugewiesen') return `${basis}/pool`;
  if (job.status === 'freigabe2') return `${basis}/freigabe2/${job.id}`;
  if (job.status === 'abgelehnt') return `${basis}/abgelehnt/${job.id}`;
  return job.quelle === 'spesen' ? `${basis}/spesen-freigabe1/${job.id}` : `${basis}/kontierung/${job.id}`;
}

// Link je Empfänger: wer am Vorgang arbeitet (oder ihn nur über die Arbeitsseite sehen darf, z.B.
// Buchhaltung im Pool), bekommt den Link der Arbeitsseite; wer ihn nur über das Admin-Recht sieht,
// die Vorgang-Detailseite.
function linkFuer(db, config, empfaenger, job) {
  const nurAdmin = personHasPermission(db, config, empfaenger, 'vorgaenge_einsehen') && !istArbeitsbeteiligt(db, empfaenger, job);
  if (nurAdmin || !canViewJobPdf(db, config, empfaenger, job)) return `${config.publicBaseUrl}/admin/vorgaenge/${job.id}`;
  return workflowLink(config, job);
}

function istArbeitsbeteiligt(db, person, job) {
  const id = person.churchtools_person_id;
  if (job.zugewiesen_an === id || istAktiveVertretungFuer(db, id, job.zugewiesen_an)) return true;
  if (job.eingereicht_von === id) return true;
  const konto = job.konto_id ? getKontoById(db, job.konto_id) : null;
  if (!konto) return false;
  const f2 = getEffectiveFreigeber2Id(job, konto);
  return f2 === id || istAktiveVertretungFuer(db, id, f2);
}

export async function erfasseKommentar(db, config, mailer, { job, person, text, jetzt = new Date() }) {
  const sauber = String(text ?? '').trim();
  const fehler = [];
  if (!darfKommentieren(db, config, person, job)) {
    return {
      ok: false,
      fehler: [KOMMENTAR_GESCHLOSSEN_STATUS.includes(job?.status) && darfKommentareSehen(db, config, person, job)
        ? 'Dieser Vorgang ist abgeschlossen; neue Kommentare sind nicht mehr möglich.'
        : 'Du darfst diesen Vorgang nicht kommentieren.'],
    };
  }
  if (sauber.length < 1) fehler.push('Bitte einen Kommentar eingeben.');
  if (sauber.length > KOMMENTAR_MAX_LAENGE) fehler.push(`Der Kommentar ist zu lang (höchstens ${KOMMENTAR_MAX_LAENGE} Zeichen).`);

  const sichtbar = erwaehnbarePersonen(db, config, job);
  const { ids, unbekannt } = findeErwaehnungen(sauber, sichtbar);
  if (unbekannt.length) {
    // Zweiter Durchgang gegen alle aktiven Personen, nur um "gibt es nicht" von "darf nicht sehen"
    // zu unterscheiden. Gleichnamige sichtbare Personen gelten als gemeint, nicht als Fehler.
    const sichtbareNamen = new Set(sichtbar.map((p) => p.name.toLocaleLowerCase('de')));
    const alle = aktivePersonen(db).map((p) => ({ id: p.churchtools_person_id, name: name(p) }));
    const zweiter = findeErwaehnungen(sauber, alle);
    const gesperrt = alle.filter((p) => zweiter.ids.includes(p.id) && !sichtbareNamen.has(p.name.toLocaleLowerCase('de')));
    for (const p of new Map(gesperrt.map((x) => [x.name, x])).values()) {
      fehler.push(`${p.name} darf diesen Vorgang nicht sehen und kann nicht erwähnt werden.`);
    }
    for (const u of zweiter.unbekannt) fehler.push(`Unbekannte Person: @${u}`);
    if (!fehler.length) for (const u of unbekannt) fehler.push(`Unbekannte Person: @${u}`);
  }
  if (fehler.length) return { ok: false, fehler };

  const id = Number(
    db
      .prepare('INSERT INTO kommentare (job_id, person_id, text, erwaehnt, erstellt_am) VALUES (?, ?, ?, ?, ?)')
      .run(job.id, person.churchtools_person_id, sauber, JSON.stringify(ids), jetzt.toISOString()).lastInsertRowid
  );

  const verfasserName = name(person);
  for (const empfaengerId of beteiligte(db, config, job, { schreiberId: person.churchtools_person_id, erwaehntIds: ids })) {
    const empfaenger = getPersonById(db, empfaengerId);
    if (!empfaenger?.email) continue;
    await sendNotification(db, mailer, {
      to: empfaenger.email,
      typ: 'kommentar',
      jobId: job.id,
      variablen: {
        empfaengerName: name(empfaenger),
        verfasserName,
        kommentarText: sauber,
        jobId: job.id,
        jobDateiname: job.dateiname,
        link: linkFuer(db, config, empfaenger, job),
      },
    });
  }
  return { ok: true, id };
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

export function markiereGelesen(db, jobId, personId, jetzt = new Date()) {
  db.prepare(
    `INSERT INTO kommentar_gelesen (job_id, person_id, zuletzt_am) VALUES (?, ?, ?)
     ON CONFLICT(job_id, person_id) DO UPDATE SET zuletzt_am = MAX(kommentar_gelesen.zuletzt_am, excluded.zuletzt_am)`
  ).run(jobId, personId, jetzt.toISOString());
}
