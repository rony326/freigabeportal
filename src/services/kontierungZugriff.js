// Zugriffsprüfung der Kontierungsseite: wer darf einen Vorgang in Freigabe 1 bearbeiten, und wohin geht die strikte Weiterleitung.

import { personHasRole } from '../middleware/roles.js';
import { getJobById } from '../db/jobsRepo.js';
import { listKontenForPerson, getKontoById } from '../db/kontenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { listKonfliktmelder } from '../db/freigabenRepo.js';
import { istAktiveVertretungFuer } from './vertretung.js';

// Superadmin = Mitglied der ChurchTools-Admin-Gruppe.
function isSuperadmin(config, person) {
  return personHasRole(person, config, 'superadmin');
}

// zurueckgeben: nur für "zurück in den Pool"/"an die Gruppe zurück". Ein Konfliktmelder kann
// einen Vorgang nach einem Pool-Zyklus wieder halten (releaseJob setzt freigabe1_eskaliert_von
// zurück, der Verlauf bleibt); ihn abzugeben muss möglich bleiben, sonst hängt der Vorgang.
// Lädt den Vorgang aus `req.params.id` und prüft die Berechtigung; bei Mangel wird die 403-Seite gerendert und null geliefert.
// Spesen sind ausgeschlossen (sie laufen über /spesen-freigabe1), Konfliktmelder dürfen nicht kontieren (nur zurückgeben).
export function ladeKontierbarenJob(db, config, req, res, { zurueckgeben = false } = {}) {
  const job = getJobById(db, Number(req.params.id));
  if (!job || job.status !== 'zugewiesen') {
    res.status(403).render('error', { message: 'Dieser Job ist dir aktuell nicht zur Kontierung zugewiesen.' });
    return null;
  }
  // Eine Spesenposition erfüllt die Prüfungen auf Status/zugewiesen_an unten genau wie eine gewöhnliche Rechnung — sie läuft aber
  // über /spesen-freigabe1, eine reine Prüfseite, die weder ihr Konto ändern noch sie durch das Aufsplitten schicken kann. Ohne
  // diese Sperre liesse sich jene Seite ganz umgehen.
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
  // Ein erklärter Interessenskonflikt gehört zur Rechnung: wer ihn bei Freigabe 1 erklärt hat,
  // darf sie nie mehr kontieren -- weder als Ferienvertretung der zuständigen Person noch nach
  // einem Admin-Umhängen noch als Superadmin bei einer an die Admin-Gruppe eskalierten Rechnung.
  if (!zurueckgeben && listKonfliktmelder(db, job.id, 1).has(req.currentPerson.churchtools_person_id)) {
    res.status(403).render('error', { message: 'Du hast für diese Rechnung einen Interessenskonflikt erklärt und kannst sie nicht kontieren.' });
    return null;
  }
  return job;
}

// Die bestehende Vorbelegung des Formulars (values.kontoId ist standardmässig job.konto_id) geht davon aus, dass das aktuell
// zugewiesene Konto des Vorgangs das erwartete Ziel einer erneuten Einreichung ist. listKontenForPerson ist aber nach Rolle
// gefiltert, und ein Portal-Admin, der einen selbst-eskalierten Vorgang bearbeitet (Fall B im Kontierungs-POST-Handler in
// routes/kontierung.js), hat auf diesem Konto PER DEFINITION keine Rolle Freigeber 1/Stellvertreter 1 — genau das machte es zur
// Selbst-Eskalation. Ohne diese Funktion könnte so ein Admin das Formular zwar sehen (200), aber nie absenden: das Dropdown hat
// nichts Auswählbares, und konten.find(...) im POST-Handler scheitert immer. Bedingungslos, nicht an freigabe1_eskaliert_an_admin
// gebunden, da sie im Normalfall wirkungslos ist: das Konto des Vorgangs steckt dort ohnehin im eigenen listKontenForPerson-Ergebnis.
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
// @returns {{personId: string}|{anAdmin: true}} Ziel der strikten Freigeber-1-Weiterleitung (siehe Regeln oben)
export function ermittleStriktesWeiterleitungsZiel(db, job, konto, aktuellePersonId) {
  const konfliktmelder = listKonfliktmelder(db, job.id, 1);
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
