// Ferienmodus is purely additive (see docs/superpowers/specs/2026-09-07-ferienmodus-design.md):
// nothing in jobs/konten is ever reassigned. "Active" is always computed against today's date,
// never stored as a separate flag — no cron job needed to flip it off again.
// Joined against personen a second time (aliased "stellvertreter") to require the chosen
// substitute to still be aktiv = 1 -- every other role-holder path in this codebase (e.g.
// listActivePersons, listVertretungsKandidaten) applies the same filter. Without it, a
// substitute who leaves the organization and gets deactivated by the nightly sync would keep
// receiving notification mails and keep being able to act as substitute for as long as the
// vacationer's date window runs. This deliberately does NOT check the absent person's (personId)
// own aktiv flag -- that's an orthogonal question this helper has never answered either way.
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

export function istAktiveVertretungFuer(db, kandidatId, urspruenglichePersonId) {
  if (!kandidatId || !urspruenglichePersonId) return false;
  return getAktivenVertreter(db, urspruenglichePersonId) === kandidatId;
}
