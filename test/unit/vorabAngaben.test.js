import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { createJob, getJobById, setQrDaten, updateKontierungMetadaten } from '../../src/db/jobsRepo.js';
import { vorabAngaben } from '../../src/services/vorabAngaben.js';
import { kreditorMitIban } from '../helpers/kreditor.js';

const QR_IBAN = 'CH4431999123000889012';

function neuerJob(db, extra = {}) {
  return createJob(db, { eingangAm: '2026-11-19T08:00:00.000Z', quelle: 'lieferant', absender: 'x@example.ch', dateiname: 'r.pdf', pdfPfad: '/tmp/r.pdf', ...extra });
}

test('ohne Angaben: alles leer, nichts als ungeprüft markiert', () => {
  const db = openDatabase(':memory:');
  const a = vorabAngaben(db, getJobById(db, neuerJob(db)));
  assert.deepEqual(a, {
    lieferant: { wert: null, ungeprueft: false },
    betrag: { wert: null, ungeprueft: false },
    rechnungsnummer: { wert: null, ungeprueft: false },
  });
  db.close();
});

test('Lieferant aus der Zuweisungsregel (jobs.lieferant) gilt als geprüft', () => {
  const db = openDatabase(':memory:');
  const id = neuerJob(db);
  db.prepare("UPDATE jobs SET lieferant = 'Regel AG' WHERE id = ?").run(id);
  assert.deepEqual(vorabAngaben(db, getJobById(db, id)).lieferant, { wert: 'Regel AG', ungeprueft: false });
  db.close();
});

test('ohne Regel: Lieferant zur QR-IBAN wird als ungeprüft gezeigt', () => {
  const db = openDatabase(':memory:');
  kreditorMitIban(db, { name: 'IBAN Treffer AG', iban: QR_IBAN });
  const id = neuerJob(db);
  setQrDaten(db, id, { qrIban: QR_IBAN, qrBetrag: '120.00' });
  assert.deepEqual(vorabAngaben(db, getJobById(db, id)).lieferant, { wert: 'IBAN Treffer AG', ungeprueft: true });
  db.close();
});

test('Regel-Lieferant hat Vorrang vor dem QR-IBAN-Treffer', () => {
  const db = openDatabase(':memory:');
  kreditorMitIban(db, { name: 'IBAN Treffer AG', iban: QR_IBAN });
  const id = neuerJob(db);
  db.prepare("UPDATE jobs SET lieferant = 'Regel AG' WHERE id = ?").run(id);
  setQrDaten(db, id, { qrIban: QR_IBAN });
  assert.deepEqual(vorabAngaben(db, getJobById(db, id)).lieferant, { wert: 'Regel AG', ungeprueft: false });
  db.close();
});

test('Betrag: QR-Betrag vor Upload-Vorschlag, beide ungeprüft', () => {
  const db = openDatabase(':memory:');
  const id = neuerJob(db, { betragVorschlag: '99.90' });
  assert.deepEqual(vorabAngaben(db, getJobById(db, id)).betrag, { wert: '99.90', ungeprueft: true });
  setQrDaten(db, id, { qrIban: QR_IBAN, qrBetrag: '120.00' });
  assert.deepEqual(vorabAngaben(db, getJobById(db, id)).betrag, { wert: '120.00', ungeprueft: true });
  db.close();
});

test('Rechnungsnummer aus dem Eingang ist vor der Kontierung ungeprüft', () => {
  const db = openDatabase(':memory:');
  const id = neuerJob(db, { rechnungsnummer: 'RE-1' });
  assert.deepEqual(vorabAngaben(db, getJobById(db, id)).rechnungsnummer, { wert: 'RE-1', ungeprueft: true });
  db.close();
});

test('nach der Kontierung gelten die kontierten Werte, nichts ist mehr ungeprüft', () => {
  const db = openDatabase(':memory:');
  kreditorMitIban(db, { name: 'IBAN Treffer AG', iban: QR_IBAN });
  const id = neuerJob(db, { rechnungsnummer: 'RE-1', betragVorschlag: '99.90' });
  setQrDaten(db, id, { qrIban: QR_IBAN, qrBetrag: '120.00' });
  updateKontierungMetadaten(db, id, { absender: null, betrag: '121.00', zahlungsziel: '2026-12-31', rechnungsnummer: 'RE-1b', lieferant: 'Gewählt AG', kreditorId: null });
  assert.deepEqual(vorabAngaben(db, getJobById(db, id)), {
    lieferant: { wert: 'Gewählt AG', ungeprueft: false },
    betrag: { wert: '121.00', ungeprueft: false },
    rechnungsnummer: { wert: 'RE-1b', ungeprueft: false },
  });
  db.close();
});
