// Vorgänge (Tabelle `jobs`) – das Herzstück des Portals: Lieferantenrechnungen, Gutschriften, Rapporte, Spesenpositionen,
// Kreditkartenabrechnungen und deren Teilvorgänge (Aufsplitten). Reine SQL-Schicht ohne Geschäftsregeln der Oberfläche;
// Routen und Services (routes/kontierung.js, routes/freigabe2.js, services/aufsplitten.js …) rufen diese Funktionen auf.
//
// Status-Lebenslauf (Details: docs/rechnungs-workflow.md):
//   unzugewiesen (Pool) → zugewiesen (Kontierung) → freigabe2 → abgeschlossen → abgeholt (n8n) → archiviert
//   Seitenwege: abgelehnt (mit Wiederöffnen), aufgesplittet (Elternvorgang einer Aufteilung), kenntnisnahme (Rapport),
//   geloescht (weich gelöscht, Datei bleibt). 'zugewiesen' trägt die Stufe Freigabe 1, 'freigabe2' die Stufe Freigabe 2.
//
// Konventionen:
//   - Übergangsfunktionen liefern `true`/`false` (oder null), wenn die WHERE-Bedingung auf den Status keine Zeile traf –
//     so verlieren gleichzeitige Aufrufer ehrlich, statt zu überschreiben.
//   - Eskalationsflags (`freigabeN_eskaliert_*`) gehören zur Rechnung, nicht zu einem Durchlauf; wer sie wann löscht,
//     steht an den jeweiligen Funktionen.
//   - Manche Felder sind per Trigger unveränderlich, sobald gesetzt (Zeitstempel, Freigabe-Snapshot, Endhash): siehe securitySchema.js.

import { getKontoById } from './kontenRepo.js';
import { getPersonById } from './personenRepo.js';
import { listZuweisungsregeln } from './zuweisungsregelnRepo.js';
import { getKreditorById, istKreditorVollstaendig } from './kreditorenRepo.js';

// Wiederverwendet von listZugewiesenJobsForPerson/listFreigabe2JobsForPerson/listAbgelehntJobsForPerson weiter unten:
// trifft jede Person, deren aktiver Ferienmodus (heute liegt zwischen ferienmodus_von..ferienmodus_bis) den gebundenen
// Parameter als Stellvertretung nennt. Die Einzelvorgang-Variante derselben Prüfung steht in src/services/vertretung.js.
//
// Die EXISTS-Klausel verlangt, dass die Stellvertretung (== der gebundene Parameter, da ferienmodus_stellvertreter_id = ?
// beide schon gleichsetzt) weiterhin aktiv = 1 ist — entspricht der gleichen Absicherung in getAktivenVertreter und
// schliesst hier dieselbe Lücke: eine deaktivierte Stellvertretung darf die vertretenen Vorgänge nicht mehr im eigenen
// Dashboard sehen. Das aktiv-Flag der abwesenden Person selbst bleibt absichtlich unberührt; das hat diese Unterabfrage nie geprüft.
const VERTRETUNG_ZIEL_SUBQUERY = `
  SELECT churchtools_person_id FROM personen
  WHERE ferienmodus_stellvertreter_id = ?
    AND ferienmodus_von IS NOT NULL
    AND date('now') BETWEEN ferienmodus_von AND ferienmodus_bis
    AND EXISTS (
      SELECT 1 FROM personen stellvertreter
      WHERE stellvertreter.churchtools_person_id = personen.ferienmodus_stellvertreter_id AND stellvertreter.aktiv = 1
    )
`;

// Effektive Freigabe-2-Person in SQL -- muss exakt getEffectiveFreigeber2Id (unten) entsprechen,
// test/unit/effektiverFreigeber2.test.js prüft beide gegeneinander. Admin-Eskalation
// (freigabe2_eskaliert_an_admin) prüft jeder Aufrufer weiterhin selbst. Setzt
// "FROM jobs JOIN konten ON konten.id = jobs.konto_id" voraus.
export const EFFEKTIVER_FREIGEBER2_SQL = `(CASE
    WHEN jobs.freigabe2_umgeleitet_an IS NOT NULL THEN jobs.freigabe2_umgeleitet_an
    WHEN jobs.freigabe2_eskaliert_von IS NOT NULL THEN konten.stellvertreter2_id
    ELSE konten.freigeber2_id
  END)`;

// Domain-Teil einer Adresse in Kleinschreibung, oder null ohne "@".
function extractDomain(email) {
  const at = email.lastIndexOf('@');
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

// n8n reicht den Absender unverändert aus dem From:-Header der Rechnungsmail weiter; das kann eine nackte Adresse
// ("rechnung@lieferant.ch") oder eine Form mit Anzeigenamen ("Lieferant AG <rechnung@lieferant.ch>") sein. Würde man naiv
// das letzte "@" im Rohheader nehmen, könnte ein präparierter Wert mit mehreren Adressen (z. B.
// "billing@attacker.example, buchhaltung@lieferant.ch") über die Adresse mit dem letzten "@" eine legitime Regel treffen —
// und eine von aussen eingespeiste Rechnung auf ein gewähltes Konto/einen gewählten Freigeber lenken. Deshalb genau EINE
// saubere Adresse extrahieren (bevorzugt die letzte "<...>") und bei Mehrdeutigkeit nicht raten: kein Treffer, der Vorgang
// landet im Pool, statt das Falsche zu treffen.
const EMAIL_PATTERN = /^[^\s@,<>"]+@[^\s@,<>"]+$/;

/**
 * Macht aus dem rohen From:-Header genau eine saubere E-Mail-Adresse (siehe Begründung oben).
 * @param {string|null|undefined} absender Rohwert aus der Rechnungsmail
 * @returns {string|null} die Adresse, oder null, wenn sie fehlt oder mehrdeutig ist
 */
export function normalizeAbsender(absender) {
  if (!absender) return null;
  const trimmed = absender.trim();
  const angleMatch = trimmed.match(/<([^<>]+)>\s*$/);
  if (!angleMatch) {
    return EMAIL_PATTERN.test(trimmed) ? trimmed : null;
  }
  // Ablehnen, wenn vor dem letzten "<...>" noch etwas steht, das eine weitere Adresse verstecken könnte — ein nacktes "@"
  // oder ein "," zwischen mehreren Adressen —, nachdem in Anführungszeichen stehende Anzeigenamen entfernt wurden. Ohne das
  // würde "billing@attacker.example <buchhaltung@lieferant.ch>" nur die hintere Adresse in Klammern extrahieren und die
  // vordere still ignorieren — genau die Mehrdeutigkeit, die diese Funktion verweigern statt erraten soll.
  const prefix = trimmed.slice(0, angleMatch.index).replace(/"[^"]*"/g, '');
  if (/[@,]/.test(prefix)) return null;
  const candidate = angleMatch[1].trim();
  return EMAIL_PATTERN.test(candidate) ? candidate : null;
}

// 'exakt' = ganze Adresse gleich (case-insensitive), 'domain' = Muster ohne @ passt auf die Domain
// oder eine Subdomain davon. Gleiche Regeln wie bisher in findMatchingZuweisungsregel, jetzt auch
// für die Kreditkarten-Erkennung nutzbar.
export function bewerteAbsenderMuster(absender, muster) {
  const normalized = normalizeAbsender(absender);
  if (!normalized || !muster) return null;
  const absenderLower = normalized.toLowerCase();
  const musterLower = muster.toLowerCase();
  if (musterLower === absenderLower) return 'exakt';
  if (musterLower.includes('@')) return null;
  const domain = extractDomain(absenderLower);
  if (domain && (domain === musterLower || domain.endsWith(`.${musterLower}`))) return 'domain';
  return null;
}

// Sucht die Zuweisungsregel zum Absender: erst ein exakter Adress-Treffer, dann ein Domain-Treffer, sonst null.
export function findMatchingZuweisungsregel(db, absender) {
  const regeln = listZuweisungsregeln(db);
  return (
    regeln.find((r) => bewerteAbsenderMuster(absender, r.absender_muster) === 'exakt') ||
    regeln.find((r) => bewerteAbsenderMuster(absender, r.absender_muster) === 'domain') ||
    null
  );
}

// Speichert die aus dem PDF-Text gelesenen Beträge der Kreditkartenabrechnung (JSON, services/kkTextAnalyse.js).
export function setKkTextAnalyse(db, jobId, analyse) {
  db.prepare('UPDATE jobs SET kk_text_betraege = ? WHERE id = ?').run(JSON.stringify(analyse), jobId);
}

// Sucht einen Vorgang mit identischen PDF-Bytes (Duplikaterkennung Szenario 1, exakt gleiche Datei).
export function findJobByDateiHash(db, dateiHash) {
  return db.prepare('SELECT * FROM jobs WHERE datei_hash = ? ORDER BY id LIMIT 1').get(dateiHash) ?? null;
}

// Abgelehnte Vorgänge werden bewusst weiterhin gefunden — taucht die Rechnungsnummer eines abgelehnten Vorgangs bei einem
// neuen wieder auf, ist das trotzdem eine Meldung wert, auch wenn es für sich kein Risiko einer Doppelzahlung gibt.
// Nur 'geloescht' (weich gelöschte) Zeilen sind ausgeschlossen.
export function findJobsByKreditorUndRechnungsnummer(db, kreditorId, rechnungsnummer, excludeJobId) {
  if (!kreditorId || !rechnungsnummer) return [];
  return db
    .prepare("SELECT * FROM jobs WHERE kreditor_id = ? AND rechnungsnummer = ? AND status != 'geloescht' AND id != ? ORDER BY id")
    .all(kreditorId, rechnungsnummer, excludeJobId);
}

// Duplikaterkennung Szenario 2: dieselbe Rechnung zweimal gescannt (andere PDF-Bytes, Rechnungsnummer
// evtl. unterschiedlich abgetippt). Treffer = gleicher Kreditor, gleicher Betrag (numerisch), gleiches
// Zahlungsziel, Eingang höchstens `tage` Tage auseinander — das Fenster verhindert Fehlalarme bei
// Lieferanten, die monatlich denselben Betrag verrechnen. Teile derselben aufgesplitteten Rechnung
// (Eltern- und Geschwisterjobs) zählen nicht.
export const DOPPELRECHNUNG_FENSTER_TAGE = 14;

export function findMoeglicheDoppelrechnungen(db, { job, kreditorId, betrag, zahlungsziel, tage = DOPPELRECHNUNG_FENSTER_TAGE }) {
  const betragZahl = Number(String(betrag ?? '').replace(',', '.'));
  if (!kreditorId || !zahlungsziel || !betrag || !Number.isFinite(betragZahl) || !job?.eingang_am) return [];
  const familie = job.aufgesplittet_von ?? job.id;
  return db
    .prepare(
      `SELECT * FROM jobs
       WHERE kreditor_id = ? AND zahlungsziel = ? AND betrag IS NOT NULL
         AND abs(CAST(betrag AS REAL) - ?) < 0.005
         AND abs(julianday(eingang_am) - julianday(?)) <= ?
         AND status != 'geloescht' AND id != ?
         AND id != ? AND (aufgesplittet_von IS NULL OR aufgesplittet_von != ?)
       ORDER BY id`
    )
    .all(kreditorId, zahlungsziel, betragZahl, job.eingang_am, tage, job.id, familie, familie);
}

/**
 * Legt einen eingehenden Vorgang an (Eingang per n8n). Greift eine Zuweisungsregel auf den Absender und sind Kreditor
 * (aktiv, mit IBAN wo nötig) und dessen Standardkonto brauchbar, startet der Vorgang gleich als 'zugewiesen' beim
 * Freigeber 1 des Kontos; sonst landet er als 'unzugewiesen' im Pool.
 * @returns {number} id des neuen Vorgangs
 */
export function createJob(db, { eingangAm, quelle, absender, dateiname, pdfPfad, dateiHash, pdfDateiname }) {
  const regel = findMatchingZuweisungsregel(db, absender);
  let kontoId = null;
  let zugewiesenAn = null;
  let status = 'unzugewiesen';
  let kreditorId = null;
  let lieferant = null;

  if (regel) {
    const kreditor = getKreditorById(db, regel.kreditor_id);
    if (kreditor && kreditor.aktiv && istKreditorVollstaendig(db, kreditor)) {
      kreditorId = kreditor.id;
      lieferant = kreditor.name;
      // Ein Kreditor ohne eigenes Standardkonto füllt den Lieferanten trotzdem automatisch aus, aber es gibt kein Konto, aus dem
      // sich ein Freigeber 1 ableiten liesse — der Vorgang bleibt 'unzugewiesen', wie bei keinem Treffer.
      if (kreditor.konto_id) {
        const konto = getKontoById(db, kreditor.konto_id);
        if (konto && konto.aktiv) {
          kontoId = konto.id;
          zugewiesenAn = konto.freigeber1_id;
          status = 'zugewiesen';
        }
      }
    }
  }

  const result = db
    .prepare(
      `INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad, status, konto_id, zugewiesen_an, kreditor_id, lieferant, datei_hash, pdf_dateiname)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(eingangAm, quelle, absender ?? null, dateiname, pdfPfad, status, kontoId, zugewiesenAn, kreditorId, lieferant, dateiHash ?? null, pdfDateiname || null);

  return Number(result.lastInsertRowid);
}

// @returns {object|null} die Zeile aus `jobs` oder null
export function getJobById(db, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
}

// Pool: unzugewiesene Vorgänge (ohne Spesen und ohne Rückläufer), älteste zuerst.
export function listPoolJobs(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'unzugewiesen' AND quelle != 'spesen' AND pool_rueckgesendet_bemerkung IS NULL ORDER BY eingang_am").all();
}

// Rückläufer: von einer Person an die Gruppe zurückgeschickte Vorgänge im Pool (mit Bemerkung).
export function listPoolRuecklaeufer(db) {
  return db
    .prepare("SELECT * FROM jobs WHERE status = 'unzugewiesen' AND quelle != 'spesen' AND pool_rueckgesendet_bemerkung IS NOT NULL ORDER BY pool_rueckgesendet_am")
    .all();
}

// Person beansprucht einen Pool-Vorgang. @returns {boolean} false, wenn er nicht mehr 'unzugewiesen' ist (jemand war schneller)
export function claimJob(db, id, personId) {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'zugewiesen', zugewiesen_an = ?,
           pool_rueckgesendet_bemerkung = NULL, pool_rueckgesendet_von = NULL, pool_rueckgesendet_am = NULL
       WHERE id = ? AND status = 'unzugewiesen'`
    )
    .run(personId, id);
  return result.changes > 0;
}

// Wie claimJob, aber die Buchhaltung weist den Vorgang einer anderen Person zu (Pool-Weiterleitung ohne Kontierung).
export function assignJobToPerson(db, jobId, personId) {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'zugewiesen', zugewiesen_an = ?,
           pool_rueckgesendet_bemerkung = NULL, pool_rueckgesendet_von = NULL, pool_rueckgesendet_am = NULL
       WHERE id = ? AND status = 'unzugewiesen'`
    )
    .run(personId, jobId);
  return result.changes > 0;
}

// listAbholbereitJobs läuft vollständig synchron (node:sqlite kennt kein asynchrones I/O); das SELECT und das UPDATE je
// Zeile unten können sich in diesem einen Node-Prozess also mit keiner anderen Anfrage überschneiden — sicher ohne
// ausdrückliche Transaktion. Bei mehreren Prozessen wäre eine nötig.
// nurMitZeitstempel: Ist die RFC3161-Funktion aktiv (eine TSA-URL ist konfiguriert), darf ein Vorgang ohne Zeitstempel
// noch nicht zu n8n gelangen — er bleibt für /abholbereit unsichtbar, bis der Zeitstempel gesetzt ist (durch den Abschluss
// von Freigabe 2 oder den Cron-Job zeitstempel-nachholen). Ist die Funktion aus (keine TSA), übergibt der Aufrufer false,
// und nichts ändert sich.
// istExportierbar: optionaler Filter (Export-/Zahlungsnachweis, siehe services/exportSnapshot.js);
// ein gesperrter Beleg wird weder angeboten noch als abgeholt vorgemerkt.
// Rückgabe: die abholbereiten Vorgänge; jeder wird dabei als "von n8n geholt" markiert (erneut angeboten erst nach `staleAfterMs`).
export function listAbholbereitJobs(db, staleAfterMs = 15 * 60 * 1000, nurMitZeitstempel = false, istExportierbar = () => true) {
  const staleThreshold = new Date(Date.now() - staleAfterMs).toISOString();
  const zeitstempelBedingung = nurMitZeitstempel ? ' AND zeitstempel_gesetzt_am IS NOT NULL' : ' AND (zeitstempel_erforderlich = 0 OR zeitstempel_gesetzt_am IS NOT NULL)';
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'abgeschlossen' AND aufgesplittet_von IS NULL AND COALESCE(typ, '') <> 'rapport'
       AND (fetched_by_n8n_at IS NULL OR fetched_by_n8n_at < ?)${zeitstempelBedingung}`
    )
    .all(staleThreshold)
    .filter((row) => istExportierbar(row));

  const now = new Date().toISOString();
  for (const row of rows) {
    db.prepare('UPDATE jobs SET fetched_by_n8n_at = ? WHERE id = ?').run(now, row.id);
    row.fetched_by_n8n_at = now;
  }
  return rows;
}

// Zu nurMitZeitstempel siehe listAbholbereitJobs oben — das ist die zweite Hälfte derselben Sperre: Auch ein Vorgang, den
// n8n schon kennt (z. B. aus der Zeit vor Aktivierung der Funktion), darf bei aktiver Funktion nicht ohne Zeitstempel
// bestätigt werden. Rückgabe: der Vorgang (jetzt 'abgeholt') oder null, wenn die Bestätigung nicht zulässig war.
export function confirmAbholung(db, id, nurMitZeitstempel = false) {
  const zeitstempelBedingung = nurMitZeitstempel ? " AND zeitstempel_gesetzt_am IS NOT NULL" : ' AND (zeitstempel_erforderlich = 0 OR zeitstempel_gesetzt_am IS NOT NULL)';
  const result = db
    .prepare(`UPDATE jobs SET status = 'abgeholt' WHERE id = ? AND status = 'abgeschlossen' AND COALESCE(typ, '') <> 'rapport'${zeitstempelBedingung}`)
    .run(id);
  if (result.changes === 0) return null;
  return getJobById(db, id);
}

// Hinterlegt den Pfad der Vorschaubild-Datei.
export function setThumbnailPfad(db, id, thumbnailPfad) {
  db.prepare('UPDATE jobs SET thumbnail_pfad = ? WHERE id = ?').run(thumbnailPfad, id);
}

// Speichert die aus dem Swiss-QR-Code gelesenen Zahlungsdaten (services/qrBill.js) samt Erkennungszeitpunkt.
export function setQrDaten(db, id, { qrIban, qrReferenz, qrBetrag, qrWaehrung, qrCreditorName }) {
  db.prepare(
    `UPDATE jobs SET qr_iban = ?, qr_referenz = ?, qr_betrag = ?, qr_waehrung = ?, qr_creditor_name = ?, qr_erkannt_am = ?
     WHERE id = ?`
  ).run(qrIban ?? null, qrReferenz ?? null, qrBetrag ?? null, qrWaehrung ?? null, qrCreditorName ?? null, new Date().toISOString(), id);
}

// setKontierung, eskalierenFreigabe1, abschliessenFreigabe1 und eskalierenFreigabe2 brauchen keinen WHERE-Status-Schutz:
// Jede Route, die sie aufruft, ist ein vollständig synchroner Handler ohne `await` zwischen Berechtigungs-/Statusprüfung
// und COMMIT, und die synchrone Ausführung von node:sqlite schliesst ein Verschränken mit einer anderen Anfrage aus.
// abschliessenFreigabe2 ist geschützt, weil seine Route vor dem Abschluss auf stampAndFinalize wartet. ablehnenJob ist
// ebenfalls geschützt, obwohl sein Routenpfad kein solches await hat — es folgt der Semantik von abschliessenFreigabe2
// ("Endübergang mit ehrlichem Boolean-Ergebnis"), statt Erfolg vorauszusetzen, und die Einheitlichkeit kostet nichts.
export function setKontierung(db, jobId, kontoId) {
  db.prepare('UPDATE jobs SET konto_id = ? WHERE id = ?').run(kontoId, jobId);
}

// Schmale Ein-Feld-Änderung — bewusst getrennt von updateKontierungMetadaten, das jedes Feld verlangt und bei einem
// alleinigen Betrag absender/zahlungsziel/usw. auf NULL setzen würde. Wird vom Aufsplitten genutzt, um einen Betrag zu
// erfassen, der im Hauptformular der Kontierung nie gespeichert wurde (Kontieren schliesst dort Freigabe 1 sofort ab und
// nimmt den Vorgang aus 'zugewiesen' — es taugt fürs Aufsplitten also nicht mehr als Schritt "erst den Betrag speichern").
export function setJobBetrag(db, jobId, betrag) {
  db.prepare('UPDATE jobs SET betrag = ? WHERE id = ?').run(betrag || null, jobId);
}

// Beim Aufsplitten gewählter Lieferant: am Elternjob gespeichert, bevor die Kinder ihn über
// createSplitJob übernehmen.
// (Kreditor und Lieferantenname gemeinsam setzen.)
export function setJobKreditor(db, jobId, { kreditorId, lieferant }) {
  db.prepare('UPDATE jobs SET kreditor_id = ?, lieferant = ? WHERE id = ?').run(kreditorId, lieferant, jobId);
}

// Setzt den Vorgangstyp ('rechnung' | 'gutschrift' | 'rapport' …).
export function setJobTyp(db, jobId, typ) {
  db.prepare('UPDATE jobs SET typ = ? WHERE id = ?').run(typ, jobId);
}

// Speichert die Formularfelder der Kontierung auf einmal (leere Werte werden NULL, der Typ fällt auf 'rechnung' zurück).
export function updateKontierungMetadaten(db, jobId, { absender, betrag, zahlungsziel, rechnungsnummer, lieferant, kreditorId, typ }) {
  db.prepare('UPDATE jobs SET absender = ?, betrag = ?, zahlungsziel = ?, rechnungsnummer = ?, lieferant = ?, kreditor_id = ?, typ = ? WHERE id = ?').run(
    absender || null,
    betrag || null,
    zahlungsziel || null,
    rechnungsnummer || null,
    lieferant || null,
    kreditorId || null,
    typ || 'rechnung',
    jobId
  );
}

// Freigabe 1 wegen Interessenskonflikt an die Stellvertretung übergeben (merkt Person und Grund).
export function eskalierenFreigabe1(db, jobId, { eskaliertVon, grund, stellvertreterId }) {
  db.prepare(
    'UPDATE jobs SET zugewiesen_an = ?, freigabe1_eskaliert_von = ?, freigabe1_eskalationsgrund = ? WHERE id = ?'
  ).run(stellvertreterId, eskaliertVon, grund, jobId);
}

// Pool-Weiterleitung: der Vorgang geht an den eigentlichen Freigeber 1 des Kontos.
export function weiterleitenAnEchtenFreigeber1(db, jobId, freigeber1Id) {
  db.prepare('UPDATE jobs SET zugewiesen_an = ? WHERE id = ?').run(freigeber1Id, jobId);
}

// Schliesst Freigabe 1 ab: Status → 'freigabe2', Uhr für Erinnerung/Eskalation startet. Ist die für Freigabe 2
// zuständige Person schon als befangen bekannt, geht der Vorgang gleich an die Admin-Gruppe.
export function abschliessenFreigabe1(db, jobId) {
  // freigabe1_eskaliert_an_admin wird hier bewusst NICHT zurückgesetzt (Korrektur aus Batch 4 — eine frühere Version dieser
  // Funktion löschte es). Ein erklärter Interessenskonflikt gehört zur Rechnung, nicht zu einem Kontierungsversuch: Lehnt
  // Freigabe 2 den Vorgang später aus einem anderen Grund ab und er wird über wiederOeffnenJob wieder geöffnet, muss die
  // ausgeschlossene Stellvertretung 1 weiterhin ausgeschlossen bleiben — dasselbe Prinzip gilt schon für
  // freigabe2_eskaliert_von (siehe den Kommentar bei wiederOeffnenJob). Das Flag wird nur durch einen echten vollständigen
  // Rücksprung in den Pool gelöscht (releaseJob, forceReleaseJob), wo der Vorgang praktisch neu beginnt, womöglich sogar
  // unter einem anderen Konto.
  // freigabe2_reminder_gesendet_at/freigabe2_eskalation_gesendet_at werden hier ebenfalls gelöscht (gleiche Begründung wie
  // bei eskalierenFreigabe2 einige Zeilen weiter unten): Ein Vorgang, der nach einer Überarbeitung erneut hier ankommt
  // (bei Freigabe 2 abgelehnt, wiederOeffnenJob, neu kontiert), startet die Zuständigkeit bei Freigabe 2 neu, aber eine frühere
  // Runde kann schon eine oder beide Mails verschickt haben. Da listFreigabe2JobsForReminder/listFreigabe2JobsForEskalation auf
  // `..._gesendet_at IS NULL` filtern, bliebe der Vorgang bei einer gesetzten Marke aus der letzten Runde in allen weiteren
  // Runden dauerhaft für beide Abfragen unsichtbar.
  db.prepare(
    "UPDATE jobs SET status = 'freigabe2', freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL, freigabe2_seit = ?, freigabe2_reminder_gesendet_at = NULL, freigabe2_eskalation_gesendet_at = NULL WHERE id = ?"
  ).run(new Date().toISOString(), jobId);
  // Ein Freigabe-2-Konflikt gehört ebenfalls zur Rechnung. Erreicht der Vorgang Freigabe 2 erneut
  // (Admin-Umhängen, Ablehnung, Überarbeitung) und wäre die effektive Freigabe-2-Person jemand,
  // der dafür schon einen Konflikt erklärt hat, geht er an die Admin-Gruppe -- wie beim zweiten
  // Konflikt in freigabe2.js. Die Aufrufer lesen den Job danach neu und benachrichtigen
  // entsprechend die Admin-Gruppe statt der ausgeschlossenen Person.
  db.prepare(
    `UPDATE jobs SET freigabe2_eskaliert_an_admin = 1, freigabe2_umgeleitet_an = NULL
     WHERE id = ? AND status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 0
       AND EXISTS (
         SELECT 1 FROM konten, freigaben f
         WHERE konten.id = jobs.konto_id AND f.job_id = jobs.id AND f.rolle = 'freigabe2_eskalation'
           AND f.person_id = ${EFFEKTIVER_FREIGEBER2_SQL}
       )`
  ).run(jobId);
}

// Freigabe 2 wegen Interessenskonflikt an die Stellvertretung 2 übergeben (Uhr startet neu, siehe Kommentar).
export function eskalierenFreigabe2(db, jobId, { eskaliertVon, grund }) {
  // freigabe2_seit startet hier neu (und beide gesendet_at-Marken werden gelöscht): Die Zuständigkeit ist gerade an die
  // Stellvertretung 2 gegangen, die Erinnerungs-/Eskalationsuhr für die *neue* zuständige Person muss bei null beginnen,
  // statt zu erben, wie lange der ursprüngliche Freigeber 2 den Vorgang schon liegen liess.
  db.prepare(
    'UPDATE jobs SET freigabe2_eskaliert_von = ?, freigabe2_eskalationsgrund = ?, freigabe2_seit = ?, freigabe2_reminder_gesendet_at = NULL, freigabe2_eskalation_gesendet_at = NULL WHERE id = ?'
  ).run(eskaliertVon, grund, new Date().toISOString(), jobId);
}

// Schliesst Freigabe 2 ab: Status → 'abgeschlossen'. @returns {boolean} false, wenn der Vorgang nicht (mehr) in 'freigabe2' war
export function abschliessenFreigabe2(db, jobId) {
  // Löscht auch freigabe2_eskaliert_an_admin: Das ist die einzige Stelle, an der Freigabe 2 regulär abgeschlossen wird
  // (egal ob durch Admin oder eine normale Person), also die richtige einzige Quelle, um die Nur-Admin-Zugriffssperre
  // zurückzusetzen (siehe loadAuthorized in freigabe2.js). Ohne das bliebe ein einmal an den Admin eskalierter Vorgang
  // dauerhaft nur für Portal-Admins zugänglich, auch über spätere, unabhängige Überarbeitungsrunden hinweg. (Das
  // Gegenstück bei Freigabe 1, freigabe1_eskaliert_an_admin, wird seit diesem Batch bewusst NICHT gleich behandelt — warum
  // sich die beiden Flags jetzt unterscheiden, steht im Kommentar bei abschliessenFreigabe1.)
  const result = db
    .prepare(
      "UPDATE jobs SET status = 'abgeschlossen', abgeschlossen_am = ?, freigabe2_eskaliert_von = NULL, freigabe2_eskalationsgrund = NULL, freigabe2_eskaliert_an_admin = 0, freigabe2_umgeleitet_an = NULL WHERE id = ? AND status = 'freigabe2'"
    )
    .run(new Date().toISOString(), jobId);
  return result.changes > 0;
}

// Jeder abgeschlossene Vorgang, der noch keinen RFC3161-Zeitstempel hat — die Arbeitsliste des Cron-Jobs
// zeitstempel-nachholen (cronJobs.js). Bewusst das genaue Gegenstück zur Sperre `zeitstempel_gesetzt_am IS NOT NULL`
// in listAbholbereitJobs/confirmAbholung oben: Was n8n noch nicht abholen darf, muss der Nachhol-Job noch stempeln.
export function listZeitstempelAusstehendJobs(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'abgeschlossen' AND zeitstempel_gesetzt_am IS NULL").all();
}

// Speist den Warnbanner im Admin-Dashboard: zählt abgeschlossene Vorgänge, deren RFC3161-Zeitstempel nach
// schwellenStunden Stunden noch fehlt. `abgeschlossen_am IS NOT NULL` ist nur ein Sicherheitsnetz — db/index.js füllt
// abgeschlossen_am bei der Migration für jeden schon abgeschlossenen Vorgang nach, ein Vorgang in diesem Zustand ohne die
// Spalte sollte also nicht mehr vorkommen; die Bedingung bleibt, damit ein NULL nie still als "unendlich überfällig" gilt.
export function countZeitstempelUeberfaellig(db, schwellenStunden) {
  const schwelle = new Date(Date.now() - schwellenStunden * 60 * 60 * 1000).toISOString();
  const row = db
    .prepare(
      "SELECT COUNT(*) AS anzahl FROM jobs WHERE status = 'abgeschlossen' AND zeitstempel_gesetzt_am IS NULL AND abgeschlossen_am IS NOT NULL AND abgeschlossen_am < ?"
    )
    .get(schwelle);
  return row.anzahl;
}

// SYNC-8: eine Eskalation der zweiten Stufe, ausgelöst, wenn auch die Person, an die bereits eskaliert wurde (Stufe 1),
// einen eigenen Interessenskonflikt hat — leitet den Vorgang an einen beliebigen aktiven Portal-Admin, statt zu blockieren.
// zugewiesen_an bleibt bewusst unberührt: Ist dieses Flag gesetzt, prüft die Vorgangsberechtigung zugewiesen_an für diese
// Stufe gar nicht mehr (siehe kontierung.js/freigabe2.js), das Feld bleibt also als historischer Hinweis auf die letzte
// genannte Person der Kette stehen, ohne einen Platzhalterwert zu brauchen.
// (Stufe 2 der Eskalation bei Freigabe 1: an die Admin-Gruppe, Begründung siehe oben.)
export function eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon, grund }) {
  db.prepare(
    'UPDATE jobs SET freigabe1_eskaliert_an_admin = 1, freigabe1_eskaliert_von = ?, freigabe1_eskalationsgrund = ? WHERE id = ?'
  ).run(eskaliertVon, grund, jobId);
}

// Wie eskalierenFreigabe1AnAdmin, für Freigabe 2; eine eventuelle Admin-Umleitung wird dabei aufgehoben.
export function eskalierenFreigabe2AnAdmin(db, jobId, { eskaliertVon, grund }) {
  db.prepare(
    'UPDATE jobs SET freigabe2_eskaliert_an_admin = 1, freigabe2_eskaliert_von = ?, freigabe2_eskalationsgrund = ?, freigabe2_umgeleitet_an = NULL WHERE id = ?'
  ).run(eskaliertVon, grund, jobId);
}

/**
 * Die zugewiesene Person gibt den Vorgang in den Pool zurück (echter Neustart, siehe Kommentar).
 * @param {object} [opts] `hinweisKontoId`: Konto, das später als Hinweis bei der nächsten Kontierung erscheint
 * @returns {boolean} false, wenn der Vorgang nicht (mehr) dieser Person zugewiesen war
 */
export function releaseJob(db, jobId, personId, { hinweisKontoId } = {}) {
  // Löscht auch freigabe1_eskaliert_von/-grund: Eine Stellvertretung 1, an die eskaliert wurde, kann den Vorgang ebenfalls
  // freigeben (loadAuthorizedJob prüft nur das aktuelle zugewiesen_an), und wer ihn neu beansprucht, darf keinen veralteten
  // Eskalationseintrag aus einer früheren Runde erben. Löscht ausserdem reminder_gesendet_at/eskalation_gesendet_at, damit ein
  // frischer Pool-Durchlauf nach der Freigabe eine eigene Erinnerung/Eskalation bekommen kann, statt still übersprungen zu
  // werden, weil die *vorherige* Runde schon eine verschickt hat. Löscht auch freigabe1_eskaliert_an_admin: Anders als
  // wiederOeffnenJob (das das Flag bewusst behält, weil bei einer Überarbeitung desselben Vorgangs/Kontos der Konflikt echt
  // bleibt) ist releaseJob ein echter Neustart — der Vorgang kann einem ganz anderen Konto zugewiesen werden, für das der
  // alte Ausschluss nicht mehr gilt. hinweis_konto_id wird immer geschrieben (mit dem übergebenen Wert oder NULL), nicht
  // unberührt gelassen, aus demselben "Neustart"-Grund — ein Hinweis aus einer früheren, womöglich falschen Freigabe darf
  // nicht still in den nächsten Pool-Durchlauf übergehen, nur weil dieser keinen neuen setzt. Löscht ausserdem
  // pool_rueckgesendet_bemerkung/-von/-am: Ein Vorgang kann beansprucht und wieder freigegeben werden, während er noch eine
  // veraltete Rückläufer-Markierung aus der Zeit vor der letzten Beanspruchung trägt; ohne das würde er still (und dauerhaft)
  // im Bereich Rückläufer statt in der normalen Pool-Liste erscheinen, obwohl ihn in dieser Runde niemand zurückgeschickt hat.
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'unzugewiesen', zugewiesen_an = NULL, konto_id = NULL,
           freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL,
           freigabe1_eskaliert_an_admin = 0,
           freigabe2_eskaliert_von = NULL, freigabe2_eskalationsgrund = NULL,
           freigabe2_eskaliert_an_admin = 0,
           freigabe2_umgeleitet_an = NULL,
           reminder_gesendet_at = NULL, eskalation_gesendet_at = NULL,
           hinweis_konto_id = ?,
           pool_rueckgesendet_bemerkung = NULL, pool_rueckgesendet_von = NULL, pool_rueckgesendet_am = NULL
       WHERE id = ? AND zugewiesen_an = ? AND status = 'zugewiesen'`
    )
    .run(hinweisKontoId || null, jobId, personId);
  return result.changes > 0;
}

// Derselbe "echte Neustart"-Reset wie bei releaseJob (die Begründung zu jedem Feld steht dort) — ein an die Gruppe
// zurückgeschickter Vorgang kann von jeder Person neu beansprucht werden, womöglich unter einem ganz anderen Konto; jede
// veraltete Spur von konto_id/Eskalation/Erinnerung aus dem eben zurückgeschickten Versuch darf also nicht still in den
// nächsten Pool-Durchlauf übergehen. Die drei Spalten pool_rueckgesendet_* sind die einzige Ausnahme: sie sind der
// ganze Zweck dieser Funktion und werden mit den übergebenen Werten geschrieben, nicht gelöscht.
// Rückläufer: die zugewiesene Person schickt ihren Vorgang mit Bemerkung zurück in den Pool (echter Neustart wie releaseJob,
// aber mit Rückläufer-Markierung). @returns {boolean} false, wenn er nicht mehr 'zugewiesen' und dieser Person zugewiesen war
export function sendJobBackToGroup(db, jobId, currentZugewiesenAn, { bemerkung }) {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'unzugewiesen', zugewiesen_an = NULL, konto_id = NULL,
           freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL,
           freigabe1_eskaliert_an_admin = 0,
           freigabe2_eskaliert_von = NULL, freigabe2_eskalationsgrund = NULL,
           freigabe2_eskaliert_an_admin = 0,
           freigabe2_umgeleitet_an = NULL,
           reminder_gesendet_at = NULL, eskalation_gesendet_at = NULL,
           pool_rueckgesendet_bemerkung = ?, pool_rueckgesendet_von = ?, pool_rueckgesendet_am = ?
       WHERE id = ? AND zugewiesen_an = ? AND status = 'zugewiesen'`
    )
    .run(bemerkung, currentZugewiesenAn, new Date().toISOString(), jobId, currentZugewiesenAn);
  return result.changes > 0;
}

// Akzeptiert sowohl 'freigabe2' (die ursprüngliche Ablehnung bei Freigabe 2) als auch 'zugewiesen' (Ablehnung direkt in
// der Kontierungs-/Freigabe-1-Phase, später ergänzt — eine Rechnung kann ungültig oder ein Duplikat sein, bevor überhaupt
// jemand ein Konto gewählt hat; die Ablehnung erst bei Freigabe 2 zu erlauben, wäre für die kontierende Person eine Sackgasse).
// Lehnt einen Vorgang ab (Status 'abgelehnt', mit Person und Grund). @returns {boolean} false, wenn die Phase nicht passte
export function ablehnenJob(db, jobId, { abgelehntVon, grund }) {
  const result = db
    .prepare(
      "UPDATE jobs SET status = 'abgelehnt', abgelehnt_von = ?, ablehnungsgrund = ?, freigabe2_umgeleitet_an = NULL WHERE id = ? AND status IN ('freigabe2', 'zugewiesen')"
    )
    .run(abgelehntVon, grund, jobId);
  return result.changes > 0;
}

// wiederOeffnenJob löscht freigabe2_eskaliert_von/-grund bewusst NICHT: Wurde der Vorgang von einer Stellvertretung 2
// abgelehnt, die nach einem Freigabe-2-Konflikt eingesprungen war, ist dieser Konflikt nach der Überarbeitung weiterhin
// echt — die nächste Freigabe-2-Runde des wieder geöffneten Vorgangs soll wieder zur selben Stellvertretung 2 gehen und
// nicht still zum ursprünglichen (befangenen) freigeber2_id zurückspringen. (freigabe1_eskaliert_von/-grund brauchen hier
// keinen solchen Hinweis: abschliessenFreigabe1 löscht sie schon, bevor ein Vorgang überhaupt in freigabe2/abgelehnt landen kann.)
// Öffnet einen abgelehnten Vorgang zur Überarbeitung wieder (zurück zu 'zugewiesen'); nur die Person, der er zugewiesen ist.
// @returns {boolean} false, wenn er nicht (mehr) abgelehnt oder anderen Personen zugewiesen ist
export function wiederOeffnenJob(db, jobId, personId) {
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'zugewiesen', abgelehnt_von = NULL, ablehnungsgrund = NULL
       WHERE id = ? AND zugewiesen_an = ? AND status = 'abgelehnt'`
    )
    .run(jobId, personId);
  return result.changes > 0;
}

// Abgelehnte Vorgänge, die bei der Person (oder ihrer Vertretung) zur Überarbeitung liegen.
export function listAbgelehntJobsForPerson(db, personId) {
  return db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'abgelehnt' AND freigabe1_eskaliert_an_admin = 0 AND quelle != 'spesen'
       AND (zugewiesen_an = ? OR zugewiesen_an IN (${VERTRETUNG_ZIEL_SUBQUERY}))
       ORDER BY eingang_am`
    )
    .all(personId, personId);
}

// Admin-weit, anders als listAbgelehntJobsForPerson: Ein Portal-Admin, der abgelehnte Rechnungen aufräumt, muss alle sehen,
// nicht nur die ihm persönlich zugewiesenen oder an ihn eskalierten.
// (siehe Kommentar oben)
export function listAlleAbgelehntenJobs(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'abgelehnt' ORDER BY eingang_am").all();
}

// Liefert die Vorgangszeile so, wie sie unmittelbar vor der Löschung war (pdf_pfad/thumbnail_pfad/dateiname braucht der
// Aufrufer für das Aufräumen der Dateien und den Eintrag in job_loeschungen, danach lassen sie sich nicht mehr nachschlagen),
// oder null, wenn er nicht im Status 'abgelehnt' war — gelöscht werden darf bewusst nur ein bereits abgelehnter Vorgang,
// nie ein offener/aktiver. Löscht auch die freigaben-Zeilen des Vorgangs: Sie verweisen ohne erzwungenen Fremdschlüssel auf
// job_id, und sie als Waisen zurückzulassen, wenn der Vorgang weg ist, hat keinen Zweck.
// Weiches Löschen: Die Zeile und ihr PDF/Thumbnail bleiben mit Status 'geloescht' für Compliance/Audit erhalten (siehe
// job_loeschungen), statt hart gelöscht zu werden.
// Löscht einen abgelehnten Vorgang weich (Status 'geloescht').
export function loeschenJob(db, jobId) {
  const job = getJobById(db, jobId);
  if (!job || job.status !== 'abgelehnt') return null;
  db.prepare("UPDATE jobs SET status = 'geloescht' WHERE id = ?").run(jobId);
  return job;
}

// Pool-Vorgänge, die seit mehr als `stunden` Stunden unbeansprucht sind und noch keine Erinnerung bekamen.
export function listPoolJobsForReminder(db, stunden) {
  const schwelle = new Date(Date.now() - stunden * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'unzugewiesen' AND reminder_gesendet_at IS NULL AND eingang_am < ? ORDER BY eingang_am"
    )
    .all(schwelle);
}

// Nur setzen, wenn noch nicht gesetzt: liefert false, wenn ein paralleler Lauf schneller war.
// Merkt, dass die Pool-Erinnerung verschickt wurde (damit sie nur einmal kommt).
export function markReminderGesendet(db, jobId) {
  return db.prepare('UPDATE jobs SET reminder_gesendet_at = ? WHERE id = ? AND reminder_gesendet_at IS NULL').run(new Date().toISOString(), jobId).changes > 0;
}

// Pool-Vorgänge, die seit mehr als `stunden` Stunden unbeansprucht sind und noch nicht eskaliert wurden.
export function listPoolJobsForEskalation(db, stunden) {
  const schwelle = new Date(Date.now() - stunden * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'unzugewiesen' AND eskalation_gesendet_at IS NULL AND eingang_am < ? ORDER BY eingang_am"
    )
    .all(schwelle);
}

// Nur setzen, wenn noch nicht gesetzt: liefert false, wenn ein paralleler Lauf schneller war.
// Merkt, dass die Pool-Eskalation verschickt wurde.
export function markEskalationGesendet(db, jobId) {
  return db.prepare('UPDATE jobs SET eskalation_gesendet_at = ? WHERE id = ? AND eskalation_gesendet_at IS NULL').run(new Date().toISOString(), jobId).changes > 0;
}

// Vorgänge in Freigabe 2, die seit mehr als `stunden` Stunden warten und noch keine Erinnerung bekamen.
export function listFreigabe2JobsForReminder(db, stunden) {
  const schwelle = new Date(Date.now() - stunden * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 0 " +
      "AND freigabe2_reminder_gesendet_at IS NULL AND freigabe2_seit < ? ORDER BY freigabe2_seit"
    )
    .all(schwelle);
}

// Nur setzen, wenn noch nicht gesetzt: liefert false, wenn ein paralleler Lauf schneller war.
export function markFreigabe2ReminderGesendet(db, jobId) {
  return db.prepare('UPDATE jobs SET freigabe2_reminder_gesendet_at = ? WHERE id = ? AND freigabe2_reminder_gesendet_at IS NULL').run(new Date().toISOString(), jobId).changes > 0;
}

// Vorgänge in Freigabe 2, die seit mehr als `stunden` Stunden warten und noch nicht an die Admin-Gruppe eskaliert wurden.
export function listFreigabe2JobsForEskalation(db, stunden) {
  const schwelle = new Date(Date.now() - stunden * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 0 " +
      "AND freigabe2_eskalation_gesendet_at IS NULL AND freigabe2_seit < ? ORDER BY freigabe2_seit"
    )
    .all(schwelle);
}

// Nur setzen, wenn noch nicht gesetzt: liefert false, wenn ein paralleler Lauf schneller war.
export function markFreigabe2EskalationGesendet(db, jobId) {
  return db.prepare('UPDATE jobs SET freigabe2_eskalation_gesendet_at = ? WHERE id = ? AND freigabe2_eskalation_gesendet_at IS NULL').run(new Date().toISOString(), jobId).changes > 0;
}

// Von n8n abgeholte Vorgänge, die noch auf die Archivquittung warten.
export function listAbgeholtJobs(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'abgeholt' ORDER BY id").all();
}

// Setzt einen abgeholten Vorgang auf 'archiviert' (nach der Archivquittung von n8n).
export function archivierenJob(db, id) {
  const result = db
    .prepare("UPDATE jobs SET status = 'archiviert', archiviert_am = ? WHERE id = ? AND status = 'abgeholt'")
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

// Hält Zeitpunkt und Datei-Hash des RFC3161-Zeitstempels fest (danach per Trigger unveränderlich).
export function markZeitstempelGesetzt(db, jobId, zeitpunkt, hash = null) {
  db.prepare('UPDATE jobs SET zeitstempel_gesetzt_am = ?, zeitstempel_datei_hash = ? WHERE id = ?').run(zeitpunkt, hash, jobId);
}

// "Meine Kontierungen": Vorgänge in Freigabe 1, die der Person (oder einer von ihr vertretenen Person) zugewiesen sind.
export function listZugewiesenJobsForPerson(db, personId) {
  return db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'zugewiesen' AND freigabe1_eskaliert_an_admin = 0 AND quelle != 'spesen'
       AND (zugewiesen_an = ? OR zugewiesen_an IN (${VERTRETUNG_ZIEL_SUBQUERY}))
       ORDER BY eingang_am`
    )
    .all(personId, personId);
}

// AND NOT (quelle = 'spesen' AND eingereicht_von = ?): Eine Spesenposition, deren Einreicher:in selbst Freigeber 2 bzw.
// Stellvertretung 2 dieses Kontos ist, wird beim Abschluss von Freigabe 1 von ihr weggeleitet (siehe den Zweig "Freigeben"
// in spesenFreigabe1.js, der eskalierenFreigabe2 aufruft, um sie an die Stellvertretung 2 zu geben) — aber die einreichende
// Person, die auf einem *anderen* Vorgang noch nominell zur freigeber2/stellvertreter2-Bedingung dieser Abfrage passt, darf
// ihren EIGENEN nun eskalierten Vorgang auch hier nie aufgelistet sehen. Sonst zeigte der Bereich "Meine Freigaben" des
// Pool-Dashboards einen Vorgang, der beim Anklicken sofort mit 403 antwortet (siehe die Einreicher-Prüfung in loadAuthorized
// von freigabe2.js) — eine Sackgasse statt einer fehlenden Zeile.
// "Meine Freigaben": Vorgänge in Freigabe 2, bei denen die Person (oder Stellvertretung/Umleitung) zuständig ist.
export function listFreigabe2JobsForPerson(db, personId) {
  return db
    .prepare(
      `SELECT jobs.* FROM jobs
       JOIN konten ON konten.id = jobs.konto_id
       WHERE jobs.status = 'freigabe2'
         AND jobs.freigabe2_eskaliert_an_admin = 0
         AND (${EFFEKTIVER_FREIGEBER2_SQL} = ? OR ${EFFEKTIVER_FREIGEBER2_SQL} IN (${VERTRETUNG_ZIEL_SUBQUERY}))
         AND NOT (jobs.quelle = 'spesen' AND jobs.eingereicht_von = ?)
         AND NOT EXISTS (SELECT 1 FROM freigaben f WHERE f.job_id = jobs.id AND f.rolle = 'freigabe2_eskalation' AND f.person_id = ?)
       ORDER BY jobs.eingang_am`
    )
    .all(personId, personId, personId, personId);
}

// listAbgeschlossenJobsForPerson speist die eigene Seite "Meine abgeschlossenen Rechnungen" (/meine-abgeschlossenen) —
// die abgeschlossenen Rechnungen einer Person wachsen nur, deshalb wird seitenweise geblättert statt gekappt: standardmässig
// die neueste Seite (ORDER BY eingang_am DESC), auf Wunsch jede Seite.
const ABGESCHLOSSEN_SEITENGROESSE = 20;

// Dieselbe Konto-Zugehörigkeitslogik wie listFreigabe2JobsForPerson (inklusive der Bedingung freigabe2_eskaliert_an_admin = 0:
// ein an den Admin eskalierter Vorgang bleibt aus den eigenen Listen des befangenen freigeber2/stellvertreter2 ausgeschlossen,
// wie es listFreigabe2JobsForPerson beabsichtigt), erweitert auf die drei Status "abgeschlossen und danach" (damit ein
// Vorgang auch nach dem Abholen/Archivieren durch n8n gelistet bleibt, obwohl seine PDF-Datei dann nicht mehr zur Vorschau/
// Prüfung verfügbar ist) plus einen direkten zugewiesen_an-Treffer (die Person, die kontiert hat, nicht zwingend der
// Freigeber 2). In der Praxis setzt abschliessenFreigabe2 freigabe2_eskaliert_an_admin bis 'abgeschlossen' immer auf 0
// zurück, die Bedingung ist also eine zusätzliche Absicherung und nichts, was normale Abschlüsse auslösen könnten — sie hält
// aber die Zugriffsregeln beider Abfragen identisch, statt sich darauf zu verlassen, dass diese Invariante ewig hält.
//
// Gibt { jobs, gesamtAnzahl, seite, proSeite } statt eines nackten Arrays zurück (analog zur Seitenform von
// queryGlobalAuditLog) — eine Seite hinter der letzten echten Seite (z. B. weil Vorgänge inzwischen archiviert wurden, oder
// bei einer von Hand geänderten URL) wird auf die letzte gültige Seite begrenzt, statt eine leere Seite ohne Rückweg zu rendern.
export function listAbgeschlossenJobsForPerson(db, personId, { seite = 1, proSeite = ABGESCHLOSSEN_SEITENGROESSE } = {}) {
  const seiteGewuenscht = Math.max(1, Math.trunc(seite) || 1);
  const proSeiteSicher = Math.max(1, Math.trunc(proSeite) || ABGESCHLOSSEN_SEITENGROESSE);

  // Die dritte Bedingung deckt die Person ab, die Freigabe 2 tatsächlich erteilt hat: nach einer
  // Admin-Umleitung ist freigabe2_umgeleitet_an beim Abschluss bereits wieder gelöscht.
  // Rapporte haben kein Konto (daher LEFT JOIN): sichtbar für Markierer und jede (auch frühere)
  // Empfängerin -- nur solange der Job ein Rapport ist, sonst machte eine Zeile aus einer
  // aufgehobenen Markierung eine spätere Rechnung sichtbar.
  const where = `WHERE jobs.status IN ('abgeschlossen', 'abgeholt', 'archiviert')
         AND jobs.freigabe2_eskaliert_an_admin = 0
         AND (
           jobs.zugewiesen_an = ?
           OR ${EFFEKTIVER_FREIGEBER2_SQL} = ?
           OR EXISTS (SELECT 1 FROM freigaben f WHERE f.job_id = jobs.id AND f.rolle = 'freigeber2' AND f.person_id = ?)
           OR (jobs.typ = 'rapport' AND (
             jobs.rapport_markiert_von = ?
             OR EXISTS (SELECT 1 FROM kenntnisnahmen k WHERE k.job_id = jobs.id AND k.person_id = ?)
           ))
         )`;
  const params = [personId, personId, personId, personId, personId];

  const gesamtAnzahl = db
    .prepare(`SELECT COUNT(*) AS anzahl FROM jobs LEFT JOIN konten ON konten.id = jobs.konto_id ${where}`)
    .get(...params).anzahl;
  const gesamtSeiten = Math.max(1, Math.ceil(gesamtAnzahl / proSeiteSicher));
  const seiteSicher = Math.min(seiteGewuenscht, gesamtSeiten);
  const offset = (seiteSicher - 1) * proSeiteSicher;

  const jobs = db
    .prepare(
      `SELECT jobs.* FROM jobs
       LEFT JOIN konten ON konten.id = jobs.konto_id
       ${where}
       ORDER BY jobs.eingang_am DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, proSeiteSicher, offset);

  return { jobs, gesamtAnzahl, seite: seiteSicher, proSeite: proSeiteSicher };
}

// listZugewiesenJobsForPerson und listFreigabe2JobsForPerson schliessen an den Admin eskalierte Vorgänge
// (freigabeN_eskaliert_an_admin = 1) bewusst aus — sie sind "meine Vorgänge"-Listen für die Person, von der weg eskaliert
// wurde, nicht für die Admin-Gruppe, an die eskaliert wurde. Ohne diese beiden Funktionen würde ein solcher Vorgang im
// Dashboard nirgends für die Portal-Admin-Gruppe aufgelistet, an die eine Eskalation der zweiten Stufe im Stil von SYNC-8
// (siehe kontierung.js/freigabe2.js) tatsächlich geleitet wird — er existiert in der Datenbank und seine Benachrichtigungsmail
// verlinkt direkt darauf, aber es gibt keine Liste, in der ein Portal-Admin ihn finden könnte, ohne die ID schon zu kennen.
// (Siehe Kommentar oben) Vorgänge in Freigabe 1, die an die Admin-Gruppe eskaliert wurden.
export function listAdminEskalierteKontierungen(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'zugewiesen' AND freigabe1_eskaliert_an_admin = 1 AND quelle != 'spesen' ORDER BY eingang_am").all();
}

// Vorgänge in Freigabe 2, die an die Admin-Gruppe eskaliert wurden.
export function listAdminEskalierteFreigaben(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 1 ORDER BY eingang_am").all();
}

// Muss exakt EFFEKTIVER_FREIGEBER2_SQL (oben) entsprechen. Die Admin-Eskalation prüfen die
// Aufrufer selbst (sie hat Vorrang vor allem hier).
// Effektive Freigabe-2-Person eines Vorgangs: Admin-Umleitung vor Stellvertretung 2 (nach Eskalation) vor Freigeber 2.
export function getEffectiveFreigeber2Id(job, konto) {
  if (job.freigabe2_umgeleitet_an) return job.freigabe2_umgeleitet_an;
  return job.freigabe2_eskaliert_von ? konto.stellvertreter2_id : konto.freigeber2_id;
}

// SYNC-3: Ein Vorgang "hängt", wenn die aktuell nötige handelnde Person nicht mehr handeln kann — deaktiviert oder in
// ChurchTools nicht mehr auflösbar, beides vom Personen-Sync gesetzt. Geprüft wird je Status: bei 'zugewiesen'/'abgelehnt'
// ist die handelnde Person zugewiesen_an direkt; bei 'freigabe2' der effektive Freigeber 2, ausser der Vorgang trägt schon
// das Admin-Eskalationsflag aus SYNC-8 — ein an den Admin geleiteter Vorgang "hängt" nach dieser Definition nie (ein
// gleichzeitiger Ausfall der gesamten Portal-Admin-Gruppe ist nicht vorgesehen).
// Vorgänge, bei denen die aktuell nötige Person nicht mehr handeln kann (deaktiviert/nicht auflösbar).
export function listStalledJobs(db) {
  const ergebnisse = [];

  for (const job of db.prepare("SELECT * FROM jobs WHERE status IN ('zugewiesen', 'abgelehnt')").all()) {
    const akteur = getPersonById(db, job.zugewiesen_an);
    if (!akteur || !akteur.aktiv || akteur.ct_person_unresolved) {
      ergebnisse.push({ job, akteurId: job.zugewiesen_an, grund: !akteur || !akteur.aktiv ? 'inaktiv' : 'nicht_aufloesbar' });
    }
  }

  for (const job of db.prepare("SELECT * FROM jobs WHERE status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 0").all()) {
    const konto = getKontoById(db, job.konto_id);
    if (!konto) continue;
    const akteurId = getEffectiveFreigeber2Id(job, konto);
    const akteur = getPersonById(db, akteurId);
    if (!akteur || !akteur.aktiv || akteur.ct_person_unresolved) {
      ergebnisse.push({ job, akteurId, grund: !akteur || !akteur.aktiv ? 'inaktiv' : 'nicht_aufloesbar' });
    }
  }

  return ergebnisse;
}

// Setzt einen hängenden 'zugewiesen'/'abgelehnt'-Vorgang auf 'unzugewiesen' zurück, damit ihn jede Person neu beanspruchen
// kann — in diesen Phasen ist noch nichts Unumkehrbares passiert (keine Freigabe 1/2 verbucht), der vollständige Reset
// ist also sicher. Löscht dieselben Felder, die releaseJob/wiederOeffnenJob schon löschen.
// Gibt einen hängenden Vorgang ohne Zutun der Person in den Pool frei (Systemaktion des Personen-Syncs).
export function forceReleaseJob(db, jobId) {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'unzugewiesen', zugewiesen_an = NULL, konto_id = NULL,
           freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL, freigabe1_eskaliert_an_admin = 0,
           freigabe2_eskaliert_von = NULL, freigabe2_eskalationsgrund = NULL, freigabe2_eskaliert_an_admin = 0,
           freigabe2_umgeleitet_an = NULL,
           abgelehnt_von = NULL, ablehnungsgrund = NULL,
           reminder_gesendet_at = NULL, eskalation_gesendet_at = NULL,
           pool_rueckgesendet_bemerkung = NULL, pool_rueckgesendet_von = NULL, pool_rueckgesendet_am = NULL
       WHERE id = ? AND status IN ('zugewiesen', 'abgelehnt')`
    )
    .run(jobId);
  return result.changes > 0;
}

// Ein hängender 'freigabe2'-Vorgang wird NICHT in den Pool freigegeben — das würde die bereits abgeschlossene und
// verbuchte Freigabe-1-Zustimmung verwerfen und Kontierung + Freigabe 1 ohne Grund erneut erzwingen. Stattdessen bekommt er
// das Admin-Eskalationsflag aus SYNC-8, die richtige nächste Instanz für einen Vorgang, der Freigabe 1 schon hinter sich hat.
// Eskaliert einen hängenden Freigabe-2-Vorgang an die Admin-Gruppe (Systemaktion des Personen-Syncs).
export function forceEskalierenFreigabe2AnAdmin(db, jobId) {
  const result = db
    .prepare("UPDATE jobs SET freigabe2_eskaliert_an_admin = 1, freigabe2_umgeleitet_an = NULL WHERE id = ? AND status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 0")
    .run(jobId);
  return result.changes > 0;
}

// Admin-Eingriff (/admin/vorgaenge): übergibt einen laufenden Vorgang an zielId. Pro Phase genau
// die Felder, die die Spec nennt; die WHERE-Klausel auf den Status schützt gegen einen Wechsel
// zwischen Prüfung und Update. Prüfung von Ziel und Stand macht services/vorgangUmhaengen.js.
// Admin-Eingriff: übergibt einen Vorgang in `status` an die Person `zielId` (siehe Kommentar unten).
export function adminUmhaengen(db, jobId, { status, zielId }) {
  const jetzt = new Date().toISOString();
  const statements = {
    unzugewiesen: [
      `UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = ?,
         pool_rueckgesendet_bemerkung = NULL, pool_rueckgesendet_von = NULL, pool_rueckgesendet_am = NULL,
         reminder_gesendet_at = NULL, eskalation_gesendet_at = NULL
       WHERE id = ? AND status = 'unzugewiesen'`,
      [zielId, jobId],
    ],
    zugewiesen: [
      `UPDATE jobs SET zugewiesen_an = ?, freigabe1_eskaliert_an_admin = 0,
         reminder_gesendet_at = NULL, eskalation_gesendet_at = NULL
       WHERE id = ? AND status = 'zugewiesen'`,
      [zielId, jobId],
    ],
    freigabe2: [
      `UPDATE jobs SET freigabe2_umgeleitet_an = ?, freigabe2_eskaliert_an_admin = 0, freigabe2_seit = ?,
         freigabe2_reminder_gesendet_at = NULL, freigabe2_eskalation_gesendet_at = NULL
       WHERE id = ? AND status = 'freigabe2'`,
      [zielId, jetzt, jobId],
    ],
    abgelehnt: [
      `UPDATE jobs SET zugewiesen_an = ?, freigabe1_eskaliert_an_admin = 0
       WHERE id = ? AND status = 'abgelehnt' AND quelle != 'spesen'`,
      [zielId, jobId],
    ],
  };
  const eintrag = statements[status];
  if (!eintrag) return false;
  const [sql, params] = eintrag;
  return db.prepare(sql).run(...params).changes > 0;
}

// Der Elternvorgang bleibt als historischer Verweis in der Tabelle (wird nie gelöscht) — seine eigene Freigabekette wird
// durch seine Teilvorgänge ersetzt, er muss also aus allen aktiven Listen (Pool, Kontierung, Freigabe 1/2) verschwinden,
// ohne so zu tun, als wäre er je selbst freigegeben oder abgelehnt worden.
// Markiert den Elternvorgang als aufgesplittet (siehe Kommentar oben). @returns {boolean} false, wenn er nicht mehr 'zugewiesen' war
export function markJobAufgesplittet(db, jobId) {
  const result = db.prepare("UPDATE jobs SET status = 'aufgesplittet' WHERE id = ? AND status = 'zugewiesen'").run(jobId);
  return result.changes > 0;
}

// Jede Aufteilungszeile wird ein völlig eigenständiger Vorgang — eigene Datei, eigene Freigabekette, eigener Lebenslauf
// (so kann das Löschen/Ablehnen eines Teils nie einen anderen beeinflussen). eingang_am, quelle, absender, dateiname,
// zahlungsziel, rechnungsnummer, lieferant, kreditor_id und die QR-Dekodierergebnisse werden vom Elternvorgang übernommen;
// konto_id, betrag, zugewiesen_an gehören nur zu dieser einen Aufteilungszeile.
// belegSeitenzahl: wie viele Seiten der (optionale) angehängte Beleg zu pdfPfad beigetragen hat, hier beim Aufsplitten
// festgehalten statt später abgeleitet — siehe countBelegSeiten (belegAnhaengen.js) und haengeBelegSeitenAn
// (splitGruppenExport.js), warum eine spätere Seitenzahl-Differenz diese Frage nicht mehr beantworten kann, sobald das
// Kind einzeln gestempelt wurde.
// @returns {number} id des neuen Teilvorgangs ('zugewiesen', wenn ein Konto gewählt wurde, sonst 'unzugewiesen')
export function createSplitJob(db, parentJob, { pdfPfad, thumbnailPfad, kontoId, hinweisKontoId, betrag, zugewiesenAn, position, belegSeitenzahl, typ, beschreibung, kkEigenbelegGrund }) {
  const status = kontoId ? 'zugewiesen' : 'unzugewiesen';
  const result = db
    .prepare(
      `INSERT INTO jobs (
         eingang_am, quelle, absender, dateiname, pdf_pfad, thumbnail_pfad, status,
         konto_id, zugewiesen_an, hinweis_konto_id, betrag, zahlungsziel, rechnungsnummer, lieferant, kreditor_id, aufgesplittet_von,
         qr_iban, qr_referenz, qr_betrag, qr_waehrung, qr_creditor_name, qr_erkannt_am,
         rechnungsposition, beleg_seitenzahl, typ, beschreibung, kk_eigenbeleg_grund, pdf_dateiname
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      parentJob.eingang_am,
      parentJob.quelle,
      parentJob.absender,
      parentJob.dateiname,
      pdfPfad,
      thumbnailPfad ?? null,
      status,
      kontoId ?? null,
      zugewiesenAn ?? null,
      hinweisKontoId ?? null,
      betrag,
      parentJob.zahlungsziel,
      parentJob.rechnungsnummer,
      parentJob.lieferant,
      parentJob.kreditor_id,
      parentJob.id,
      parentJob.qr_iban,
      parentJob.qr_referenz,
      parentJob.qr_betrag,
      parentJob.qr_waehrung,
      parentJob.qr_creditor_name,
      parentJob.qr_erkannt_am,
      position || null,
      belegSeitenzahl ?? null,
      typ ?? null,
      beschreibung ?? null,
      kkEigenbelegGrund ?? null,
      parentJob.pdf_dateiname ?? null
    );
  return Number(result.lastInsertRowid);
}

// Legt eine Spesenposition an (quelle 'spesen', startet bei 'zugewiesen' beim Freigeber 1 des Kontos). @returns {number} id
export function createSpesenPosition(
  db,
  {
    eingangAm,
    eingereichtVon,
    kontoId,
    betrag,
    auslageDatum,
    beschreibung,
    dateiname,
    pdfPfad,
    thumbnailPfad,
    spesenabrechnungId,
    zugewiesenAn,
    freigabe1EskaliertVon,
    freigabe1Eskalationsgrund,
  }
) {
  const result = db
    .prepare(
      `INSERT INTO jobs (
        eingang_am, quelle, dateiname, pdf_pfad, thumbnail_pfad, status, konto_id, betrag,
        eingereicht_von, auslage_datum, beschreibung, spesenabrechnung_id, zugewiesen_an,
        freigabe1_eskaliert_von, freigabe1_eskalationsgrund, rechnungsdatum
      ) VALUES (?, 'spesen', ?, ?, ?, 'zugewiesen', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      eingangAm,
      dateiname,
      pdfPfad,
      thumbnailPfad,
      kontoId,
      betrag,
      eingereichtVon,
      auslageDatum,
      beschreibung,
      spesenabrechnungId,
      zugewiesenAn,
      freigabe1EskaliertVon ?? null,
      freigabe1Eskalationsgrund ?? null,
      // Das Date-Feld von Paperless will bei einer Spesenposition das Einreichedatum — nicht auslage_datum (wann die Auslage
      // anfiel). eingangAm ist ein vollständiger ISO-Zeitstempel (new Date().toISOString(), siehe spesen.js), deshalb wird nur
      // der Datumsteil behalten; Paperless lehnt für ein Date-Feld alles ausser einem reinen YYYY-MM-DD ab. Siehe GET /abholbereit
      // (n8n/jobs.js), das bei einem Nicht-Spesen-Vorgang auf zahlungsziel zurückfällt.
      eingangAm.slice(0, 10)
    );
  return Number(result.lastInsertRowid);
}

// Addiert auf beleg_seitenzahl, statt es zu überschreiben — mergeBelegInPdf HÄNGT die Seiten eines Belegs immer hinter das
// an, was schon im PDF steht (fügt nie ein). Hat ein Vorgang also schon N erfasste Belegseiten (z. B. vom eigenen Upload beim
// Aufsplitten) und bekommt später einen weiteren Beleg zugemergt (Kontierung/Überarbeitung nach Ablehnung), wächst die
// Summe genau um die Seitenzahl des neuen Belegs. Diese Invariante hält nur, weil jeder Aufruf von mergeBelegFuerJob strikt
// vor dem eigenen Freigabe-2-Stempeln des Vorgangs passiert (dem einmaligen, immer letzten Anhängen) — keine Route mergt
// einen Beleg in einen bereits 'abgeschlossenen' Vorgang.
export function addBelegSeiten(db, jobId, zusatzSeitenzahl) {
  if (!zusatzSeitenzahl) return;
  db.prepare('UPDATE jobs SET beleg_seitenzahl = COALESCE(beleg_seitenzahl, 0) + ? WHERE id = ?').run(zusatzSeitenzahl, jobId);
}

// Alle Teilvorgänge eines Elternvorgangs (auch gelöschte und abgelehnte).
export function listSplitKinder(db, parentJobId) {
  return db.prepare('SELECT * FROM jobs WHERE aufgesplittet_von = ? ORDER BY id').all(parentJobId);
}

// Eine per hinweis_konto_id angelegte Zeile (Konto ausserhalb der Freigabe-Befugnis der
// aufsplittenden Person, siehe kontierung.js's istEigenesKonto-Zweig) ist NICHT dauerhaft
// ausgenommen -- sie steht nur vorübergehend 'unzugewiesen', bis die zuständige Person sie über
// die normale Kontierung claimt und sie danach den ganz normalen Weg bis 'abgeschlossen' geht.
// Bis dahin zählt sie ganz normal als "noch offen", genau wie jede andere nicht-abgeschlossene
// Zeile -- nur eine mit status='geloescht' aufgelöste (vormals abgelehnte) Zeile wird ignoriert.
// @returns {{vollstaendig: boolean, blockiert: boolean, kinder: object[]}} vollständig = alle Teile abgeschlossen;
// blockiert = mindestens ein Teil ist abgelehnt (die Gruppe kann dann nicht exportiert werden).
export function pruefeSplitGruppenVollstaendigkeit(db, parentJobId) {
  const kinder = listSplitKinder(db, parentJobId).filter((k) => k.status !== 'geloescht');
  if (kinder.length === 0) return { vollstaendig: false, blockiert: false, kinder: [] };
  const blockiert = kinder.some((k) => k.status === 'abgelehnt');
  const vollstaendig = !blockiert && kinder.every((k) => k.status === 'abgeschlossen');
  return { vollstaendig, blockiert, kinder };
}

// Bedingt darauf, dass gruppe_pdf_pfad noch NULL ist, und meldet (Boolean), ob tatsächlich geschrieben wurde:
// Der frühe Rücksprung "schon exportiert?" in pruefeUndFinalisiereSplitGruppe liegt mehrere awaits vor diesem UPDATE,
// zwei gleichzeitige Auslöser (z. B. der Nachhol-Cron-Job und ein Freigabe-2-Abschluss) können also beide daran vorbeikommen.
// Wer das Rennen verliert, darf das zusammengeführte Dokument des Gewinners nicht überschreiben. Der Aufrufer prüft den
// Ausgangszustand zusätzlich innerhalb seiner Transaktion.
// Hält das zusammengeführte Gruppen-PDF samt Zeitstempel- und Hash-Daten am Elternvorgang fest (siehe Kommentar oben).
export function markGruppeExportiert(db, parentJobId, { pdfPfad, zeitstempelGesetztAm, zeitstempelDateiHash, finalDateiHash = null, gruppeFreigabeSnapshot = null }) {
  const result = db
    .prepare(
      'UPDATE jobs SET gruppe_pdf_pfad = ?, gruppe_zeitstempel_gesetzt_am = ?, gruppe_zeitstempel_datei_hash = ?, gruppe_final_datei_hash = ?, gruppe_freigabe_snapshot = ? WHERE id = ? AND gruppe_pdf_pfad IS NULL'
    )
    .run(pdfPfad, zeitstempelGesetztAm, zeitstempelDateiHash, finalDateiHash, gruppeFreigabeSnapshot, parentJobId);
  return result.changes > 0;
}

// Entspricht der stale/refetch-Semantik von listAbholbereitJobs, begrenzt auf Splitgruppen-Elternjobs
// (status bleibt 'aufgesplittet', nie 'abgeschlossen' -- daher eine eigene Query statt eines
// Filters auf listAbholbereitJobs).
// gruppe_abgeholt_am IS NULL ist die Endzustandssperre dieser Liste und ersetzt den Wechsel status='abgeschlossen' ->
// 'abgeholt', der einen gewöhnlichen Vorgang aus listAbholbereitJobs nimmt: Ein Elternjob behält den Status 'aufgesplittet'
// für immer, ohne diese Bedingung würde allein das stale-Fenster eine bereits abgeholte Gruppe alle 15 Minuten dauerhaft
// erneut an n8n anbieten.
// aufgesplittet_von IS NULL entspricht der identischen Bedingung in listAbholbereitJobs: Ein Splitkind, das selbst weiter
// aufgeteilt wurde, gehört zum Dokument einer äusseren Gruppe und darf nie als eigenständige oberste Gruppe an n8n
// angeboten werden.
export function listAbholbereitGruppen(db, staleAfterMs = 15 * 60 * 1000, nurMitZeitstempel = false, istExportierbar = () => true) {
  const staleThreshold = new Date(Date.now() - staleAfterMs).toISOString();
  const zeitstempelBedingung = nurMitZeitstempel ? ' AND gruppe_zeitstempel_gesetzt_am IS NOT NULL' : ` AND (gruppe_zeitstempel_gesetzt_am IS NOT NULL OR (zeitstempel_erforderlich = 0 AND NOT EXISTS (
    SELECT 1 FROM jobs child WHERE child.aufgesplittet_von = jobs.id AND child.status != 'geloescht' AND child.zeitstempel_erforderlich = 1)))`;
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'aufgesplittet' AND gruppe_pdf_pfad IS NOT NULL
       AND gruppe_abgeholt_am IS NULL AND aufgesplittet_von IS NULL
       AND (fetched_by_n8n_at IS NULL OR fetched_by_n8n_at < ?)${zeitstempelBedingung}`
    )
    .all(staleThreshold)
    .filter((row) => istExportierbar(row));

  const now = new Date().toISOString();
  for (const row of rows) {
    db.prepare('UPDATE jobs SET fetched_by_n8n_at = ? WHERE id = ?').run(now, row.id);
    row.fetched_by_n8n_at = now;
  }
  return rows;
}

// true, wenn für den Vorgang bereits ein zusammengeführtes Gruppen-PDF vorliegt (Elternvorgang einer exportierten Splitgruppe).
export function istGruppenElternjob(db, id) {
  const job = getJobById(db, id);
  return Boolean(job && job.gruppe_pdf_pfad);
}

// Analog zu confirmAbholung, aber für eine ganze Splitgruppe: setzt jedes abgeschlossene Kind auf
// 'abgeholt' und liefert Eltern- und Kind-Datensaetze zurueck. Dies ist nur ein Transport-ACK;
// lokale Dateien bleiben bis zur Archivquittung und dem Ablauf der Aufbewahrungsfrist erhalten.
// Setzt zusätzlich gruppe_abgeholt_am auf dem Elternjob -- der Endzustand der Gruppe, den der
// Elternjob-Status ('aufgesplittet') selbst nie erreicht. Damit ist der Aufruf idempotent wie
// confirmAbholung: ein zweiter Aufruf liefert null (und der n8n-Route damit ihren bestehenden
// 409-Pfad), statt bereits gelöschte Dateien erneut zur Abholung zu bestätigen.
// (Siehe Kommentar) Bestätigt die Abholung einer ganzen Splitgruppe durch n8n.
export function confirmGruppenAbholung(db, parentJobId, nurMitZeitstempel = false) {
  const parent = getJobById(db, parentJobId);
  if (!parent || !parent.gruppe_pdf_pfad || parent.gruppe_abgeholt_am) return null;
  const requiresTimestamp = nurMitZeitstempel || parent.zeitstempel_erforderlich ||
    listSplitKinder(db, parentJobId).some((child) => child.status !== 'geloescht' && child.zeitstempel_erforderlich);
  if (requiresTimestamp && !parent.gruppe_zeitstempel_gesetzt_am) return null;

  const kinder = listSplitKinder(db, parentJobId).filter((k) => k.status === 'abgeschlossen');
  for (const kind of kinder) {
    db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ? AND status = 'abgeschlossen'").run(kind.id);
  }
  db.prepare('UPDATE jobs SET gruppe_abgeholt_am = ? WHERE id = ?').run(new Date().toISOString(), parentJobId);
  return { parent, kinder };
}

// Arbeitsliste für den split-gruppen-nachholen Cron-Job: Elternjobs, deren Splitgruppe noch nicht
// gemergt wurde (unabhängig davon, ob sie schon vollständig ist -- die Vollständigkeitsprüfung
// passiert im Aufrufer, pruefeUndFinalisiereSplitGruppe).
// (Siehe Kommentar) Elternvorgänge, deren Gruppe noch nicht zusammengeführt wurde.
export function listSplitGruppenAusstehend(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'aufgesplittet' AND gruppe_pdf_pfad IS NULL").all();
}

// Spesenpositionen, die der Person direkt zur Freigabe 1 zugewiesen sind (ohne an den Admin eskalierte).
export function listSpesenFreigabe1JobsForPerson(db, personId) {
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'zugewiesen' AND quelle = 'spesen' AND zugewiesen_an = ? AND freigabe1_eskaliert_an_admin = 0 ORDER BY eingang_am"
    )
    .all(personId);
}

// Alle Spesenpositionen, die die Person selbst eingereicht hat ("Meine Spesen").
export function listSpesenForEinreicher(db, personId) {
  return db.prepare("SELECT * FROM jobs WHERE quelle = 'spesen' AND eingereicht_von = ? ORDER BY eingang_am DESC").all(personId);
}

// Spesenpositionen in Freigabe 1, die an die Admin-Gruppe eskaliert wurden.
export function listAdminEskalierteSpesenFreigaben(db) {
  return db
    .prepare("SELECT * FROM jobs WHERE status = 'zugewiesen' AND quelle = 'spesen' AND freigabe1_eskaliert_an_admin = 1 ORDER BY eingang_am")
    .all();
}

// Markiert eine Abrechnung als "Kreditkartenabrechnung dieser Karte" und übergibt sie der
// verantwortlichen Person. ausStatus ist 'unzugewiesen' (aus dem Pool) oder 'zugewiesen' (aus der
// Kontierung) -- die WHERE-Bedingung schützt gegen einen parallelen Vorgang auf demselben Job.
// (Siehe Kommentar) Markiert einen Vorgang als Kreditkartenabrechnung. @returns {boolean} false bei parallelem Statuswechsel
export function markiereJobAlsKkAbrechnung(db, jobId, { kreditkarteId, verantwortlichId, ausStatus }) {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'zugewiesen', zugewiesen_an = ?, kreditkarte_id = ?, kk_markiert_am = ?, kk_erinnert_am = NULL,
           pool_rueckgesendet_bemerkung = NULL, pool_rueckgesendet_von = NULL, pool_rueckgesendet_am = NULL,
           freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL, freigabe1_eskaliert_an_admin = 0
       WHERE id = ? AND status = ? AND kreditkarte_id IS NULL AND quelle != 'spesen' AND aufgesplittet_von IS NULL`
    )
    .run(verantwortlichId, kreditkarteId, new Date().toISOString(), jobId, ausStatus);
  return result.changes > 0;
}

// Macht die Markierung als Kreditkartenabrechnung rückgängig (Karte und Markierungszeiten werden geleert; der Status bleibt 'zugewiesen').
export function hebeKkMarkierungAuf(db, jobId) {
  const result = db
    .prepare("UPDATE jobs SET kreditkarte_id = NULL, kk_markiert_am = NULL, kk_erinnert_am = NULL WHERE id = ? AND status = 'zugewiesen' AND kreditkarte_id IS NOT NULL")
    .run(jobId);
  return result.changes > 0;
}

// Kopfdaten der Abrechnung (Kartenherausgeber, Abrechnungsnummer, Zahlungsziel) -- werden vor dem
// Anlegen der Teil-Jobs auf den Elternjob geschrieben, damit createSplitJob sie wie beim
// Aufsplitten an jedes Kind vererbt.
export function setKkAbrechnungKopfdaten(db, jobId, { kreditorId, lieferant, rechnungsnummer, zahlungsziel }) {
  db.prepare('UPDATE jobs SET kreditor_id = ?, lieferant = ?, rechnungsnummer = ?, zahlungsziel = ? WHERE id = ?').run(
    kreditorId ?? null, lieferant ?? null, rechnungsnummer ?? null, zahlungsziel ?? null, jobId
  );
}

// true, wenn der Person eine zugewiesene (markierte) Abrechnung dieser Karte zum Abgleich vorliegt.
export function hatZugewieseneKkAbrechnungFuer(db, kreditkarteId, personId) {
  return Boolean(
    db.prepare("SELECT 1 FROM jobs WHERE kreditkarte_id = ? AND status = 'zugewiesen' AND zugewiesen_an = ? LIMIT 1").get(kreditkarteId, personId)
  );
}

// Arbeitsliste für den kk-beleg-erinnerungen Cron-Job (cronJobs.js): eine markierte
// Kreditkartenabrechnung, die seit der Markierung (kk_markiert_am) die Schwelle überschritten hat
// und noch nicht abgeglichen wurde (Status bleibt 'zugewiesen', bis der Abgleich sie abschliesst),
// UND seit der letzten Erinnerung (falls je eine verschickt wurde) mindestens ein weiteres
// Intervall vergangen ist -- gleiches Muster wie listKkBelegeFuerErinnerung.
export function listKkAbrechnungenFuerErinnerung(db, schwelleIso) {
  return db
    .prepare(
      `SELECT j.*, k.bezeichnung AS karte_bezeichnung FROM jobs j JOIN kreditkarten k ON k.id = j.kreditkarte_id
       WHERE j.status = 'zugewiesen' AND j.kk_markiert_am <= ? AND (j.kk_erinnert_am IS NULL OR j.kk_erinnert_am <= ?)
       ORDER BY j.kk_markiert_am`
    )
    .all(schwelleIso, schwelleIso);
}

// Merkt den Zeitpunkt der letzten Erinnerung zur Abrechnung.
export function markKkAbrechnungErinnert(db, jobId) {
  db.prepare('UPDATE jobs SET kk_erinnert_am = ? WHERE id = ?').run(new Date().toISOString(), jobId);
}
