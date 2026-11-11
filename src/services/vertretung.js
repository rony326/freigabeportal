// Der Ferienmodus ist rein additiv (siehe docs/superpowers/specs/2026-09-07-ferienmodus-design.md): an jobs/konten wird nie etwas
// umgehängt. "Aktiv" wird immer gegen das heutige Datum berechnet und nie als eigenes Flag gespeichert — es braucht keinen Cron-Job, der
// es wieder ausschaltet. Eine Person trägt Zeitraum (von/bis) und Stellvertreter:in ein (Seite /ferienmodus); Mails und Berechtigungen
// der vertretenen Person gelten dann zusätzlich für die Stellvertretung.
//
// Mit einem zweiten Join auf personen (Alias "stellvertreter") wird verlangt, dass die gewählte Stellvertretung noch aktiv = 1 ist —
// jeder andere Rollenträger-Pfad in diesem Code (z. B. listActivePersons, listVertretungsKandidaten) wendet denselben Filter an. Ohne
// ihn bekäme eine Stellvertretung, die die Organisation verlässt und vom nächtlichen Sync deaktiviert wird, weiter Benachrichtigungsmails
// und könnte weiter als Vertretung handeln, solange das Datumsfenster der abwesenden Person läuft. Das aktiv-Flag der abwesenden Person
// (personId) wird bewusst NICHT geprüft — das ist eine davon unabhängige Frage, die dieser Helfer auch nie beantwortet hat.
// @returns {string|null} id der aktiven Stellvertretung oder null
export function getAktivenVertreter(db, personId) {
  const row = db
    .prepare(
      `SELECT p.ferienmodus_von, p.ferienmodus_bis, p.ferienmodus_stellvertreter_id
       FROM personen p
       JOIN personen stellvertreter ON stellvertreter.churchtools_person_id = p.ferienmodus_stellvertreter_id
       WHERE p.churchtools_person_id = ? AND stellvertreter.aktiv = 1`
    )
    .get(personId);
  if (!row || !row.ferienmodus_stellvertreter_id || !row.ferienmodus_von || !row.ferienmodus_bis) return null;
  const heute = new Date().toISOString().slice(0, 10);
  if (heute < row.ferienmodus_von || heute > row.ferienmodus_bis) return null;
  return row.ferienmodus_stellvertreter_id;
}

// true, wenn `kandidatId` heute die aktive Stellvertretung der Person ist.
export function istAktiveVertretungFuer(db, kandidatId, urspruenglichePersonId) {
  if (!kandidatId || !urspruenglichePersonId) return false;
  return getAktivenVertreter(db, urspruenglichePersonId) === kandidatId;
}
