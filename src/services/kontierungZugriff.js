import { getJobById } from '../db/jobsRepo.js';
import { listKontenForPerson, getKontoById } from '../db/kontenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { listFreigabenByJob } from '../db/freigabenRepo.js';
import { istAktiveVertretungFuer } from './vertretung.js';

function isSuperadmin(config, person) {
  return Boolean(person && person.gruppen.includes(String(config.churchtools.groupIdAdmin)));
}

export function ladeKontierbarenJob(db, config, req, res) {
  const job = getJobById(db, Number(req.params.id));
  if (!job || job.status !== 'zugewiesen') {
    res.status(403).render('error', { message: 'Dieser Job ist dir aktuell nicht zur Kontierung zugewiesen.' });
    return null;
  }
  // A Spesen position satisfies the status/zugewiesen_an checks below exactly like an ordinary
  // invoice — it goes through /spesen-freigabe1 instead, a review-only page that can't reassign
  // its Konto or run it through Aufsplitten. Without this, that page could be bypassed entirely.
  if (job.quelle === 'spesen') {
    res.status(403).render('error', { message: 'Diese Spesen-Position kann nicht über die Kontierung bearbeitet werden.' });
    return null;
  }
  const authorized = job.freigabe1_eskaliert_an_admin
    ? isSuperadmin(config, req.currentPerson)
    : job.zugewiesen_an === req.currentPerson.churchtools_person_id ||
      istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, job.zugewiesen_an);
  if (!authorized) {
    res.status(403).render('error', { message: 'Dieser Job ist dir aktuell nicht zur Kontierung zugewiesen.' });
    return null;
  }
  return job;
}

// The form's existing pre-fill (values.kontoId defaults to job.konto_id) already assumes the
// job's currently-assigned Konto is the expected resubmission target. listKontenForPerson
// alone is role-filtered, though, and a Portal-Admin resolving a self-escalated job (case B in
// the Kontierung POST handler in routes/kontierung.js) holds no freigeber1/stellvertreter1 role on that Konto BY
// DEFINITION — that's exactly what made it a self-escalation. Without this, such an admin
// could view the form (200) but never submit it: the dropdown has nothing selectable and
// konten.find(...) in the POST handler always fails. Unconditional, not gated on
// freigabe1_eskaliert_an_admin, since it's a no-op for the normal case: the job's Konto is
// already in a legitimately-role-holding person's own listKontenForPerson result.
export function ladeKontenFuerJob(db, req, job) {
  const konten = listKontenForPerson(db, req.currentPerson.churchtools_person_id);
  if (job.konto_id && !konten.some((k) => k.id === job.konto_id)) {
    const bestehendes = getKontoById(db, job.konto_id);
    if (bestehendes) konten.push(bestehendes);
  }
  return konten;
}

// Ziel der strikten Freigeber-1-Weiterleitung. Wer für diesen Vorgang einen Freigabe-1-Konflikt
// erklärt hat, darf die Freigabe nie (zurück)bekommen -- auch nicht, wenn ein Admin den Vorgang
// inzwischen umgehängt hat. Läuft eine Konflikt-Eskalation, ist Stellvertreter 1 der legitime
// Freigeber und kommt zuerst. Ohne zulässigen Kandidaten geht der Vorgang an die Admin-Gruppe.
export function ermittleStriktesWeiterleitungsZiel(db, job, konto, aktuellePersonId) {
  const konfliktmelder = new Set(
    listFreigabenByJob(db, job.id).filter((f) => f.rolle === 'freigabe1_eskalation').map((f) => f.person_id)
  );
  if (job.freigabe1_eskaliert_von) konfliktmelder.add(job.freigabe1_eskaliert_von);
  const kandidaten = job.freigabe1_eskaliert_von
    ? [konto.stellvertreter1_id, konto.freigeber1_id]
    : [konto.freigeber1_id, konto.stellvertreter1_id];
  for (const id of kandidaten) {
    if (!id || konfliktmelder.has(id) || id === aktuellePersonId) continue;
    const person = getPersonById(db, id);
    if (person && person.aktiv) return { personId: id };
  }
  return { anAdmin: true };
}
