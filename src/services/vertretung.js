// Ferienmodus is purely additive (see docs/superpowers/specs/2026-09-07-ferienmodus-design.md):
// nothing in jobs/konten is ever reassigned. "Active" is always computed against today's date,
// never stored as a separate flag — no cron job needed to flip it off again.
export function getAktivenVertreter(db, personId) {
  const row = db
    .prepare('SELECT ferienmodus_von, ferienmodus_bis, ferienmodus_stellvertreter_id FROM personen WHERE churchtools_person_id = ?')
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
