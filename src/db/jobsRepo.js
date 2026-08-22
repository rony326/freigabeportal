import { getKontoById } from './kontenRepo.js';
import { getPersonById } from './personenRepo.js';
import { listZuweisungsregeln } from './zuweisungsregelnRepo.js';
import { getDebitorById } from './debitorenRepo.js';

function extractDomain(email) {
  const at = email.lastIndexOf('@');
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

// n8n forwards absender as-is from the invoice mail's From: header, which may be a bare
// address ("rechnung@lieferant.ch") or a display-name form ("Lieferant AG"
// <rechnung@lieferant.ch>"). Naively taking the last "@" over the raw header lets a crafted
// multi-address value (e.g. "billing@attacker.example, buchhaltung@lieferant.ch") match a
// legitimate rule via whichever address happens to contain the last "@" — steering an
// externally-supplied invoice to a chosen Konto/approver. Extract exactly one clean address
// (preferring the last "<...>" if present) and refuse to guess when the result is still
// ambiguous, falling through to no match (the job lands in the pool) rather than matching
// the wrong thing.
const EMAIL_PATTERN = /^[^\s@,<>"]+@[^\s@,<>"]+$/;

function normalizeAbsender(absender) {
  if (!absender) return null;
  const trimmed = absender.trim();
  const angleMatch = trimmed.match(/<([^<>]+)>\s*$/);
  if (!angleMatch) {
    return EMAIL_PATTERN.test(trimmed) ? trimmed : null;
  }
  // Reject if anything before the final "<...>" still looks like it could hide another
  // address — a bare "@" or a "," separating multiple addresses — once quoted display names
  // are stripped out. Without this, "billing@attacker.example <buchhaltung@lieferant.ch>"
  // would extract only the trailing bracketed address and silently ignore the leading one,
  // exactly the ambiguity this function exists to refuse rather than guess at.
  const prefix = trimmed.slice(0, angleMatch.index).replace(/"[^"]*"/g, '');
  if (/[@,]/.test(prefix)) return null;
  const candidate = angleMatch[1].trim();
  return EMAIL_PATTERN.test(candidate) ? candidate : null;
}

export function findMatchingZuweisungsregel(db, absender) {
  const normalized = normalizeAbsender(absender);
  if (!normalized) return null;
  const absenderLower = normalized.toLowerCase();
  const domain = extractDomain(absenderLower);
  const regeln = listZuweisungsregeln(db);

  const exactMatch = regeln.find((r) => r.absender_muster.toLowerCase() === absenderLower);
  if (exactMatch) return exactMatch;

  if (domain) {
    const domainMatch = regeln.find((r) => {
      const muster = r.absender_muster.toLowerCase();
      if (muster.includes('@')) return false;
      return domain === muster || domain.endsWith(`.${muster}`);
    });
    if (domainMatch) return domainMatch;
  }

  return null;
}

export function findJobByDateiHash(db, dateiHash) {
  return db.prepare('SELECT * FROM jobs WHERE datei_hash = ? ORDER BY id LIMIT 1').get(dateiHash) ?? null;
}

export function createJob(db, { eingangAm, quelle, absender, dateiname, pdfPfad, dateiHash }) {
  const regel = findMatchingZuweisungsregel(db, absender);
  let kontoId = null;
  let zugewiesenAn = null;
  let status = 'unzugewiesen';
  let debitorId = null;
  let lieferant = null;

  if (regel) {
    const debitor = getDebitorById(db, regel.debitor_id);
    if (debitor && debitor.aktiv) {
      debitorId = debitor.id;
      lieferant = debitor.name;
      // A Debitor without its own default Konto still auto-fills Lieferant, but there's no
      // Konto to resolve a Freigeber1 from — the job stays unzugewiesen, same as no match at all.
      if (debitor.konto_id) {
        const konto = getKontoById(db, debitor.konto_id);
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
      `INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad, status, konto_id, zugewiesen_an, debitor_id, lieferant, datei_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(eingangAm, quelle, absender ?? null, dateiname, pdfPfad, status, kontoId, zugewiesenAn, debitorId, lieferant, dateiHash ?? null);

  return Number(result.lastInsertRowid);
}

export function getJobById(db, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
}

export function listPoolJobs(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'unzugewiesen' ORDER BY eingang_am").all();
}

export function claimJob(db, id, personId) {
  const result = db
    .prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = ? WHERE id = ? AND status = 'unzugewiesen'")
    .run(personId, id);
  return result.changes > 0;
}

// listAbholbereitJobs runs entirely synchronously (node:sqlite has no async I/O), so the
// SELECT and the per-row claim UPDATE below cannot interleave with any other request in this
// single Node process — safe without an explicit transaction. This would need one under a
// multi-process deployment.
export function listAbholbereitJobs(db, staleAfterMs = 15 * 60 * 1000) {
  const staleThreshold = new Date(Date.now() - staleAfterMs).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'abgeschlossen'
       AND (fetched_by_n8n_at IS NULL OR fetched_by_n8n_at < ?)`
    )
    .all(staleThreshold);

  const now = new Date().toISOString();
  for (const row of rows) {
    db.prepare('UPDATE jobs SET fetched_by_n8n_at = ? WHERE id = ?').run(now, row.id);
    row.fetched_by_n8n_at = now;
  }
  return rows;
}

export function confirmAbholung(db, id) {
  const result = db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ? AND status = 'abgeschlossen'").run(id);
  if (result.changes === 0) return null;
  return getJobById(db, id);
}

export function setThumbnailPfad(db, id, thumbnailPfad) {
  db.prepare('UPDATE jobs SET thumbnail_pfad = ? WHERE id = ?').run(thumbnailPfad, id);
}

// setKontierung, eskalierenFreigabe1, abschliessenFreigabe1, and eskalierenFreigabe2 need no
// WHERE-status guard: every route that calls them is a fully synchronous handler with no
// `await` between its authorization/status check and COMMIT, so node:sqlite's synchronous
// execution rules out interleaving with another request. abschliessenFreigabe2 is guarded
// because its route awaits stampAndFinalize before completing. ablehnenJob is guarded too,
// even though its own route path has no such await — it mirrors abschliessenFreigabe2's
// "terminal transition with an honest boolean result" semantics rather than assuming success,
// and costs nothing to keep consistent.
export function setKontierung(db, jobId, kontoId) {
  db.prepare('UPDATE jobs SET konto_id = ? WHERE id = ?').run(kontoId, jobId);
}

// Narrow, single-field update — deliberately separate from updateKontierungMetadaten, which
// requires every field and would null out absender/zahlungsziel/etc. if called with only a
// betrag. Used by the Aufsplitten flow to capture a Betrag that was never saved on the main
// Kontierung form (Kontieren there completes Freigabe 1 immediately, moving the job out of
// 'zugewiesen' — so it can no longer serve as a "just save the Betrag first" step for splitting).
export function setJobBetrag(db, jobId, betrag) {
  db.prepare('UPDATE jobs SET betrag = ? WHERE id = ?').run(betrag || null, jobId);
}

export function updateKontierungMetadaten(db, jobId, { absender, betrag, zahlungsziel, rechnungsnummer, lieferant, debitorId }) {
  db.prepare('UPDATE jobs SET absender = ?, betrag = ?, zahlungsziel = ?, rechnungsnummer = ?, lieferant = ?, debitor_id = ? WHERE id = ?').run(
    absender || null,
    betrag || null,
    zahlungsziel || null,
    rechnungsnummer || null,
    lieferant || null,
    debitorId || null,
    jobId
  );
}

export function eskalierenFreigabe1(db, jobId, { eskaliertVon, grund, stellvertreterId }) {
  db.prepare(
    'UPDATE jobs SET zugewiesen_an = ?, freigabe1_eskaliert_von = ?, freigabe1_eskalationsgrund = ? WHERE id = ?'
  ).run(stellvertreterId, eskaliertVon, grund, jobId);
}

export function abschliessenFreigabe1(db, jobId) {
  // freigabe1_eskaliert_an_admin is deliberately NOT reset here (Batch 4 correction — an
  // earlier version of this function did clear it). A declared conflict of interest belongs to
  // the invoice, not to one Kontierung attempt: if Freigabe 2 later rejects this job for an
  // unrelated reason and it's reopened via wiederOeffnenJob, the excluded Stellvertreter1 must
  // still be excluded — same principle already applied to freigabe2_eskaliert_von (see
  // wiederOeffnenJob's own comment). The flag is only ever cleared by a genuine full reset to
  // the pool (releaseJob, forceReleaseJob), where the job effectively starts over, possibly even
  // under a different Konto.
  db.prepare(
    "UPDATE jobs SET status = 'freigabe2', freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL WHERE id = ?"
  ).run(jobId);
}

export function eskalierenFreigabe2(db, jobId, { eskaliertVon, grund }) {
  db.prepare('UPDATE jobs SET freigabe2_eskaliert_von = ?, freigabe2_eskalationsgrund = ? WHERE id = ?').run(eskaliertVon, grund, jobId);
}

export function abschliessenFreigabe2(db, jobId) {
  // Also clears freigabe2_eskaliert_an_admin: this is the one place Freigabe 2 legitimately
  // completes (regardless of whether an admin or a regular person did it), so it's the correct
  // single source to reset the admin-only authorization gate (see loadAuthorized in
  // freigabe2.js). Without this, a job that was ever escalated to admin would stay locked to
  // Portal-Admin-only access permanently, even across later, unrelated rework cycles. (Freigabe
  // 1's equivalent flag, freigabe1_eskaliert_an_admin, deliberately does NOT get the same
  // treatment as of this batch — see abschliessenFreigabe1's own comment for why the two flags
  // now behave differently.)
  const result = db
    .prepare(
      "UPDATE jobs SET status = 'abgeschlossen', freigabe2_eskaliert_von = NULL, freigabe2_eskalationsgrund = NULL, freigabe2_eskaliert_an_admin = 0 WHERE id = ? AND status = 'freigabe2'"
    )
    .run(jobId);
  return result.changes > 0;
}

// SYNC-8: a second-tier escalation, triggered when the person already escalated to (Tier 1)
// also has their own conflict of interest — routes the job to any active Portal-Admin instead
// of blocking. zugewiesen_an is deliberately left untouched: once this flag is set, job
// authorization stops checking zugewiesen_an for this stage entirely (see kontierung.js/
// freigabe2.js), so the field just stays as a historical record of the last named person in
// the chain rather than needing a sentinel value.
export function eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon, grund }) {
  db.prepare(
    'UPDATE jobs SET freigabe1_eskaliert_an_admin = 1, freigabe1_eskaliert_von = ?, freigabe1_eskalationsgrund = ? WHERE id = ?'
  ).run(eskaliertVon, grund, jobId);
}

export function eskalierenFreigabe2AnAdmin(db, jobId, { eskaliertVon, grund }) {
  db.prepare(
    'UPDATE jobs SET freigabe2_eskaliert_an_admin = 1, freigabe2_eskaliert_von = ?, freigabe2_eskalationsgrund = ? WHERE id = ?'
  ).run(eskaliertVon, grund, jobId);
}

export function releaseJob(db, jobId, personId, { hinweisKontoId } = {}) {
  // Also clears freigabe1_eskaliert_von/-grund: a stellvertreter1 who was escalated to can
  // release the job too (loadAuthorizedJob only checks current zugewiesen_an), and a fresh
  // claimer must not inherit a stale escalation record from a previous claim cycle. Also
  // clears reminder_gesendet_at/eskalation_gesendet_at so a fresh pool cycle after release
  // is eligible for its own reminder/escalation mail rather than being silently skipped
  // because the *previous* cycle already sent one. Also clears freigabe1_eskaliert_an_admin:
  // unlike wiederOeffnenJob (which deliberately preserves the flag, since a rework cycle on the
  // same job/Konto means the conflict is still real), releaseJob is a genuine fresh start — the
  // job may be reassigned to an entirely different Konto, for which the old exclusion no longer
  // applies. hinweis_konto_id is always written (to the given value or NULL), not left untouched,
  // for the same "fresh start" reason — a hint from a prior, possibly-wrong release must not
  // silently survive into the next pool cycle just because this one didn't set a new one.
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'unzugewiesen', zugewiesen_an = NULL, konto_id = NULL,
           freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL,
           freigabe1_eskaliert_an_admin = 0,
           freigabe2_eskaliert_von = NULL, freigabe2_eskalationsgrund = NULL,
           freigabe2_eskaliert_an_admin = 0,
           reminder_gesendet_at = NULL, eskalation_gesendet_at = NULL,
           hinweis_konto_id = ?
       WHERE id = ? AND zugewiesen_an = ? AND status = 'zugewiesen'`
    )
    .run(hinweisKontoId || null, jobId, personId);
  return result.changes > 0;
}

// Accepts both 'freigabe2' (the original Freigabe-2 rejection) and 'zugewiesen' (rejection
// directly at the Kontierung/Freigabe-1 stage, added later — an invoice can be invalid or a
// duplicate before anyone has even chosen a Konto for it, so waiting until Freigabe 2 to allow
// rejecting it would be a dead end for the person doing the Kontierung).
export function ablehnenJob(db, jobId, { abgelehntVon, grund }) {
  const result = db
    .prepare(
      "UPDATE jobs SET status = 'abgelehnt', abgelehnt_von = ?, ablehnungsgrund = ? WHERE id = ? AND status IN ('freigabe2', 'zugewiesen')"
    )
    .run(abgelehntVon, grund, jobId);
  return result.changes > 0;
}

// wiederOeffnenJob deliberately does NOT clear freigabe2_eskaliert_von/-grund: if the job was
// rejected by a stellvertreter2 who took over after a Freigabe-2 conflict escalation, that
// conflict is still real after rework — the reopened job's next Freigabe-2 round should route
// back to the same stellvertreter2, not silently reassign to the original (conflicted)
// freigeber2_id. (freigabe1_eskaliert_von/-grund need no such note here: abschliessenFreigabe1
// already clears them before a job can ever reach freigabe2/abgelehnt in the first place.)
export function wiederOeffnenJob(db, jobId, personId) {
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'zugewiesen', abgelehnt_von = NULL, ablehnungsgrund = NULL
       WHERE id = ? AND zugewiesen_an = ? AND status = 'abgelehnt'`
    )
    .run(jobId, personId);
  return result.changes > 0;
}

export function listAbgelehntJobsForPerson(db, personId) {
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'abgelehnt' AND zugewiesen_an = ? AND freigabe1_eskaliert_an_admin = 0 ORDER BY eingang_am"
    )
    .all(personId);
}

// Admin-wide, unlike listAbgelehntJobsForPerson: a Portal-Admin cleaning up rejected invoices
// needs to see all of them, not just ones assigned to (or escalated to) them personally.
export function listAlleAbgelehntenJobs(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'abgelehnt' ORDER BY eingang_am").all();
}

// Returns the job row as it was immediately before deletion (its pdf_pfad/thumbnail_pfad/
// dateiname are needed by the caller for file cleanup and the job_loeschungen log entry, which
// can no longer be looked up afterwards), or null if it wasn't in status 'abgelehnt' — deletion
// is deliberately restricted to already-rejected invoices, never an open/active one. Also
// deletes the job's freigaben rows: they reference job_id without an enforced foreign key, but
// leaving them behind as orphans once the job is gone serves no purpose.
// Soft-delete: the row and its PDF/Thumbnail survive with status 'geloescht' for
// compliance/audit purposes (see job_loeschungen) instead of being hard-deleted.
export function loeschenJob(db, jobId) {
  const job = getJobById(db, jobId);
  if (!job || job.status !== 'abgelehnt') return null;
  db.prepare("UPDATE jobs SET status = 'geloescht' WHERE id = ?").run(jobId);
  return job;
}

export function listPoolJobsForReminder(db, stunden) {
  const schwelle = new Date(Date.now() - stunden * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'unzugewiesen' AND reminder_gesendet_at IS NULL AND eingang_am < ? ORDER BY eingang_am"
    )
    .all(schwelle);
}

export function markReminderGesendet(db, jobId) {
  db.prepare('UPDATE jobs SET reminder_gesendet_at = ? WHERE id = ?').run(new Date().toISOString(), jobId);
}

export function listPoolJobsForEskalation(db, stunden) {
  const schwelle = new Date(Date.now() - stunden * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'unzugewiesen' AND eskalation_gesendet_at IS NULL AND eingang_am < ? ORDER BY eingang_am"
    )
    .all(schwelle);
}

export function markEskalationGesendet(db, jobId) {
  db.prepare('UPDATE jobs SET eskalation_gesendet_at = ? WHERE id = ?').run(new Date().toISOString(), jobId);
}

export function listAbgeholtJobs(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'abgeholt' ORDER BY id").all();
}

export function archivierenJob(db, id) {
  const result = db
    .prepare("UPDATE jobs SET status = 'archiviert', archiviert_am = ? WHERE id = ? AND status = 'abgeholt'")
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function listZugewiesenJobsForPerson(db, personId) {
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'zugewiesen' AND zugewiesen_an = ? AND freigabe1_eskaliert_an_admin = 0 ORDER BY eingang_am"
    )
    .all(personId);
}

export function listFreigabe2JobsForPerson(db, personId) {
  return db
    .prepare(
      `SELECT jobs.* FROM jobs
       JOIN konten ON konten.id = jobs.konto_id
       WHERE jobs.status = 'freigabe2'
         AND jobs.freigabe2_eskaliert_an_admin = 0
         AND (
           (jobs.freigabe2_eskaliert_von IS NULL AND konten.freigeber2_id = ?)
           OR (jobs.freigabe2_eskaliert_von IS NOT NULL AND konten.stellvertreter2_id = ?)
         )
       ORDER BY jobs.eingang_am`
    )
    .all(personId, personId);
}

// Both listZugewiesenJobsForPerson and listFreigabe2JobsForPerson deliberately exclude
// admin-escalated jobs (freigabeN_eskaliert_an_admin = 1) — they're "my jobs" lists for the
// person who was escalated away FROM, not for the admin group escalated TO. Without these two,
// nothing in the dashboard ever lists such a job for the Portal-Admin group that a
// SYNC-8-style second-tier escalation (see kontierung.js/freigabe2.js) is actually routed to —
// it exists in the database and its notification email links straight to it, but there is no
// list a Portal-Admin can browse to find it without already knowing its ID.
export function listAdminEskalierteKontierungen(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'zugewiesen' AND freigabe1_eskaliert_an_admin = 1 ORDER BY eingang_am").all();
}

export function listAdminEskalierteFreigaben(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 1 ORDER BY eingang_am").all();
}

export function getEffectiveFreigeber2Id(job, konto) {
  return job.freigabe2_eskaliert_von ? konto.stellvertreter2_id : konto.freigeber2_id;
}

// SYNC-3: a job "stalls" when its current required actor can no longer act — deactivated or
// no longer resolvable in ChurchTools, both set by the person sync. Checked per status: for
// 'zugewiesen'/'abgelehnt', the actor is zugewiesen_an directly; for 'freigabe2', it's the
// effective freigeber2, unless the job already carries SYNC-8's admin-escalation flag — an
// admin-routed job is never "stalled" by this definition (a simultaneous outage of the entire
// Portal-Admin group is out of scope).
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

// Resets a stalled 'zugewiesen'/'abgelehnt' job to 'unzugewiesen' so anyone can reclaim it —
// nothing irreversible has happened yet at these stages (no Freigabe-1/2 approval recorded),
// so a full reset is safe. Clears the same fields releaseJob/wiederOeffnenJob already clear.
export function forceReleaseJob(db, jobId) {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'unzugewiesen', zugewiesen_an = NULL, konto_id = NULL,
           freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL, freigabe1_eskaliert_an_admin = 0,
           freigabe2_eskaliert_von = NULL, freigabe2_eskalationsgrund = NULL, freigabe2_eskaliert_an_admin = 0,
           abgelehnt_von = NULL, ablehnungsgrund = NULL,
           reminder_gesendet_at = NULL, eskalation_gesendet_at = NULL
       WHERE id = ? AND status IN ('zugewiesen', 'abgelehnt')`
    )
    .run(jobId);
  return result.changes > 0;
}

// A stalled 'freigabe2' job does NOT get released to the pool — that would discard the
// already-completed, already-recorded Freigabe-1 approval and force kontierung + Freigabe 1 to
// be redone for no reason. Instead it gets the same admin-escalation flag SYNC-8 introduces,
// which is the correct next legitimate actor for a job already past Freigabe 1.
export function forceEskalierenFreigabe2AnAdmin(db, jobId) {
  const result = db
    .prepare("UPDATE jobs SET freigabe2_eskaliert_an_admin = 1 WHERE id = ? AND status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 0")
    .run(jobId);
  return result.changes > 0;
}

// The parent stays in the table (never deleted) as a historical reference — its own approval
// chain is superseded by its split children, so it must leave every active list (Pool,
// Kontierung, Freigabe 1/2) without pretending it was ever itself approved or rejected.
export function markJobAufgesplittet(db, jobId) {
  const result = db.prepare("UPDATE jobs SET status = 'aufgesplittet' WHERE id = ? AND status = 'zugewiesen'").run(jobId);
  return result.changes > 0;
}

// Each split line becomes its own fully independent job — own file, own approval chain, own
// lifecycle (so deleting/rejecting one split part can never affect another). eingang_am, quelle,
// absender, dateiname, zahlungsziel, rechnungsnummer, lieferant and debitor_id are carried over
// from the parent; konto_id, betrag, zugewiesen_an are specific to this one split line.
export function createSplitJob(db, parentJob, { pdfPfad, thumbnailPfad, kontoId, betrag, zugewiesenAn }) {
  const result = db
    .prepare(
      `INSERT INTO jobs (
         eingang_am, quelle, absender, dateiname, pdf_pfad, thumbnail_pfad, status,
         konto_id, zugewiesen_an, betrag, zahlungsziel, rechnungsnummer, lieferant, debitor_id, aufgesplittet_von
       ) VALUES (?, ?, ?, ?, ?, ?, 'zugewiesen', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      parentJob.eingang_am,
      parentJob.quelle,
      parentJob.absender,
      parentJob.dateiname,
      pdfPfad,
      thumbnailPfad ?? null,
      kontoId,
      zugewiesenAn,
      betrag,
      parentJob.zahlungsziel,
      parentJob.rechnungsnummer,
      parentJob.lieferant,
      parentJob.debitor_id,
      parentJob.id
    );
  return Number(result.lastInsertRowid);
}

export function listSplitKinder(db, parentJobId) {
  return db.prepare('SELECT * FROM jobs WHERE aufgesplittet_von = ? ORDER BY id').all(parentJobId);
}
