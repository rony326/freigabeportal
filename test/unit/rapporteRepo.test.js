import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob, getJobById, assignJobToPerson } from '../../src/db/jobsRepo.js';
import {
  markiereAlsRapport, listKenntnisnahmen, listOffeneKenntnisnahmen, bestaetigeKenntnisnahme,
  schliesseRapportAbWennVollstaendig, hebeRapportMarkierungAuf, ersetzeEmpfaenger, entferneEmpfaenger,
  listOffeneRapporteForPerson, listRapporteFuerErinnerung, markErinnert, listRapporteFuerEskalation, markRapportEskaliert,
} from '../../src/db/rapporteRepo.js';

function seed() {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return db;
}
function seedJob(db, { zuweisen = true } = {}) {
  const id = createJob(db, { eingangAm: '2026-01-01T00:00:00.000Z', quelle: 'scanner', absender: 'a@b.ch', dateiname: 'x.pdf', pdfPfad: '/x.pdf' });
  if (zuweisen) db.prepare("UPDATE jobs SET status='zugewiesen', zugewiesen_an='1', betrag=10, zahlungsziel='2026-02-01', rechnungsnummer='R1', freigabe1_eskaliert_von='1', freigabe1_eskalationsgrund='g', freigabe1_eskaliert_an_admin=1 WHERE id=?").run(id);
  return id;
}
const T0 = '2026-11-01T10:00:00.000Z';
function rapport(db, ids = ['2', '3']) {
  const id = seedJob(db);
  assert.equal(markiereAlsRapport(db, id, { markiertVon: '1', empfaengerIds: ids, bemerkung: 'bem', zeitpunkt: T0 }), true);
  return id;
}

test('markiereAlsRapport: nur aus zugewiesen, dedupliziert Empfänger, leert Rechnungsfelder', () => {
  const db = seed();
  const id = seedJob(db);
  assert.equal(markiereAlsRapport(db, id, { markiertVon: '1', empfaengerIds: ['2', '3', '2'], bemerkung: 'bem', zeitpunkt: T0 }), true);
  const job = getJobById(db, id);
  assert.equal(job.typ, 'rapport');
  assert.equal(job.status, 'kenntnisnahme');
  assert.equal(job.rapport_markiert_von, '1');
  assert.equal(job.rapport_markiert_am, T0);
  assert.equal(job.rapport_bemerkung, 'bem');
  assert.equal(job.rapport_eskaliert_am, null);
  assert.equal(job.konto_id, null);
  assert.equal(job.betrag, null);
  assert.equal(job.zahlungsziel, null);
  assert.equal(job.rechnungsnummer, null);
  assert.equal(job.kreditor_id, null);
  assert.equal(job.freigabe1_eskaliert_von, null);
  assert.equal(job.freigabe1_eskaliert_an_admin, 0);
  const rows = listKenntnisnahmen(db, id);
  assert.deepEqual(rows.map((r) => r.person_id), ['2', '3']);
  assert.equal(rows[0].zugeteilt_am, T0);
  // zweiter Aufruf: Status nicht mehr zugewiesen
  assert.equal(markiereAlsRapport(db, id, { markiertVon: '1', empfaengerIds: ['4'], bemerkung: null, zeitpunkt: T0 }), false);
  const pool = seedJob(db, { zuweisen: false });
  assert.equal(markiereAlsRapport(db, pool, { markiertVon: '1', empfaengerIds: ['4'], bemerkung: null, zeitpunkt: T0 }), false);
  assert.equal(listKenntnisnahmen(db, pool).length, 0);
  db.close();
});

test('bestaetigeKenntnisnahme: zweiter Aufruf → "bereits", fremde Person → "nicht_berechtigt"', () => {
  const db = seed();
  const id = rapport(db);
  assert.equal(bestaetigeKenntnisnahme(db, id, '4', T0), 'nicht_berechtigt');
  assert.equal(bestaetigeKenntnisnahme(db, id, '2', '2026-11-02T00:00:00.000Z'), 'bestaetigt');
  assert.equal(bestaetigeKenntnisnahme(db, id, '2', '2026-11-03T00:00:00.000Z'), 'bereits');
  assert.equal(listKenntnisnahmen(db, id).find((r) => r.person_id === '2').bestaetigt_am, '2026-11-02T00:00:00.000Z');
  assert.deepEqual(listOffeneKenntnisnahmen(db, id).map((r) => r.person_id), ['3']);
  db.close();
});

test('schliesseRapportAbWennVollstaendig: erst nach letzter Bestätigung true, danach status abgeschlossen', () => {
  const db = seed();
  const id = rapport(db);
  assert.equal(schliesseRapportAbWennVollstaendig(db, id, T0), false);
  bestaetigeKenntnisnahme(db, id, '2', T0);
  assert.equal(schliesseRapportAbWennVollstaendig(db, id, T0), false);
  bestaetigeKenntnisnahme(db, id, '3', T0);
  assert.equal(schliesseRapportAbWennVollstaendig(db, id, '2026-11-05T00:00:00.000Z'), true);
  const job = getJobById(db, id);
  assert.equal(job.status, 'abgeschlossen');
  assert.equal(job.abgeschlossen_am, '2026-11-05T00:00:00.000Z');
  assert.equal(schliesseRapportAbWennVollstaendig(db, id, T0), false);
  db.close();
});

test('hebeRapportMarkierungAuf: false sobald eine Bestätigung existiert', () => {
  const db = seed();
  const id = rapport(db);
  bestaetigeKenntnisnahme(db, id, '2', T0);
  assert.equal(hebeRapportMarkierungAuf(db, id), false);
  assert.equal(getJobById(db, id).status, 'kenntnisnahme');

  const id2 = rapport(db);
  assert.equal(hebeRapportMarkierungAuf(db, id2), true);
  const job = getJobById(db, id2);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '1');
  assert.equal(job.typ, null);
  assert.equal(job.rapport_markiert_von, null);
  assert.equal(job.rapport_markiert_am, null);
  assert.equal(job.rapport_bemerkung, null);
  assert.equal(listOffeneKenntnisnahmen(db, id2).length, 0);
  const rows = listKenntnisnahmen(db, id2);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.entfernt_am && r.begruendung === 'Markierung aufgehoben'));
  db.close();
});

test('entferneEmpfaenger: letzter Offener ohne jede Bestätigung → "letzter_offen_ohne_bestaetigung"', () => {
  const db = seed();
  const id = rapport(db);
  const [a, b] = listKenntnisnahmen(db, id);
  assert.equal(entferneEmpfaenger(db, a.id, { von: '1', begruendung: 'x', zeitpunkt: T0 }), 'entfernt');
  assert.equal(entferneEmpfaenger(db, a.id, { von: '1', begruendung: 'x', zeitpunkt: T0 }), 'nicht_offen');
  assert.equal(entferneEmpfaenger(db, b.id, { von: '1', begruendung: 'x', zeitpunkt: T0 }), 'letzter_offen_ohne_bestaetigung');
  assert.equal(listOffeneKenntnisnahmen(db, id).length, 1);

  // mit vorhandener Bestätigung darf der letzte Offene entfernt werden
  const id2 = rapport(db);
  const [c, d] = listKenntnisnahmen(db, id2);
  bestaetigeKenntnisnahme(db, id2, c.person_id, T0);
  assert.equal(entferneEmpfaenger(db, d.id, { von: '1', begruendung: 'x', zeitpunkt: T0 }), 'entfernt');
  const e = listKenntnisnahmen(db, id2).find((r) => r.id === d.id);
  assert.equal(e.entfernt_von, '1');
  assert.equal(e.begruendung, 'x');
  db.close();
});

test('ersetzeEmpfaenger: setzt rapport_eskaliert_am zurück, neue Zeile zugeteilt_am = zeitpunkt', () => {
  const db = seed();
  const id = rapport(db);
  markRapportEskaliert(db, id, T0);
  const [a] = listKenntnisnahmen(db, id);
  const Z = '2026-11-04T08:00:00.000Z';
  const neu = ersetzeEmpfaenger(db, a.id, { neuePersonId: '4', von: '1', begruendung: 'Ferien', zeitpunkt: Z });
  assert.equal(typeof neu, 'number');
  const rows = listKenntnisnahmen(db, id);
  const alt = rows.find((r) => r.id === a.id);
  assert.equal(alt.entfernt_am, Z);
  assert.equal(alt.entfernt_von, '1');
  assert.equal(alt.begruendung, 'Ferien');
  assert.equal(alt.ersetzt_durch_id, neu);
  const n = rows.find((r) => r.id === neu);
  assert.equal(n.person_id, '4');
  assert.equal(n.zugeteilt_am, Z);
  assert.equal(getJobById(db, id).rapport_eskaliert_am, null);
  // nicht mehr offen -> null
  assert.equal(ersetzeEmpfaenger(db, a.id, { neuePersonId: '4', von: '1', begruendung: 'x', zeitpunkt: Z }), null);
  db.close();
});

test('listRapporteFuerEskalation: inaktiver Empfänger eskaliert sofort, ohne Frist', () => {
  const db = seed();
  const jetzt = new Date().toISOString();
  const id = seedJob(db);
  markiereAlsRapport(db, id, { markiertVon: '1', empfaengerIds: ['2'], bemerkung: null, zeitpunkt: jetzt });
  const id2 = seedJob(db);
  markiereAlsRapport(db, id2, { markiertVon: '1', empfaengerIds: ['3'], bemerkung: null, zeitpunkt: jetzt });
  const id3 = seedJob(db);
  markiereAlsRapport(db, id3, { markiertVon: '1', empfaengerIds: ['4'], bemerkung: null, zeitpunkt: jetzt });
  assert.deepEqual(listRapporteFuerEskalation(db, 72), []);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '2'").run();
  db.prepare("UPDATE personen SET ct_person_unresolved = 1 WHERE churchtools_person_id = '3'").run();
  assert.deepEqual(listRapporteFuerEskalation(db, 72).map((j) => j.id).sort(), [id, id2].sort());
  assert.equal(markRapportEskaliert(db, id, jetzt), true);
  assert.equal(markRapportEskaliert(db, id, jetzt), false);
  assert.deepEqual(listRapporteFuerEskalation(db, 72).map((j) => j.id), [id2]);
  // Frist: alte offene Zeile von Person 4
  db.prepare("UPDATE kenntnisnahmen SET zugeteilt_am = '2020-01-01T00:00:00.000Z' WHERE job_id = ?").run(id3);
  assert.deepEqual(listRapporteFuerEskalation(db, 72).map((j) => j.id).sort(), [id2, id3].sort());
  // bestätigte Zeile zählt nicht als offen
  db.prepare("UPDATE kenntnisnahmen SET bestaetigt_am = ? WHERE job_id = ?").run(jetzt, id2);
  assert.deepEqual(listRapporteFuerEskalation(db, 72).map((j) => j.id), [id3]);
  db.close();
});

test('listOffeneRapporteForPerson: nur offene Rapporte der Person', () => {
  const db = seed();
  const id = rapport(db, ['2', '3']);
  assert.deepEqual(listOffeneRapporteForPerson(db, '2').map((j) => j.id), [id]);
  assert.deepEqual(listOffeneRapporteForPerson(db, '4'), []);
  bestaetigeKenntnisnahme(db, id, '2', T0);
  assert.deepEqual(listOffeneRapporteForPerson(db, '2'), []);
  db.close();
});

test('listRapporteFuerErinnerung / markErinnert: nur ältere, offene, noch nicht erinnerte', () => {
  const db = seed();
  const jetzt = new Date().toISOString();
  const alt = seedJob(db);
  markiereAlsRapport(db, alt, { markiertVon: '1', empfaengerIds: ['2'], bemerkung: null, zeitpunkt: '2020-01-01T00:00:00.000Z' });
  const neu = seedJob(db);
  markiereAlsRapport(db, neu, { markiertVon: '1', empfaengerIds: ['2'], bemerkung: null, zeitpunkt: jetzt });
  const liste = listRapporteFuerErinnerung(db, 48);
  assert.equal(liste.length, 1);
  assert.equal(liste[0].job.id, alt);
  assert.equal(liste[0].kenntnisnahme.person_id, '2');
  assert.equal(markErinnert(db, liste[0].kenntnisnahme.id), true);
  assert.equal(markErinnert(db, liste[0].kenntnisnahme.id), false);
  assert.deepEqual(listRapporteFuerErinnerung(db, 48), []);
  db.close();
});
