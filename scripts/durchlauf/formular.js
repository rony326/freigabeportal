// Durchlauf-Test (docs/durchlauf-test.md): Werte für das Kontierungsformular bestimmen.
// Reine Logik: bekommt den vom Browser gelesenen Formularstand (views/kontierung.ejs) und die Konfiguration,
// liefert die einzutragenden Werte oder verständliche Fehler. Vorbelegte Werte (QR-Erkennung, Eingang) gehen vor.

import { testRechnungsnummer, zahlungszielAb } from './konfiguration.js';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// Kontonummer aus dem Optionstext «9999 — Bezeichnung».
export function kontonummerAusOption(text) {
  return String(text ?? '').split('—')[0].trim();
}

// @param {object} formular vom Browser gelesen:
//   { kontoOptionen:[{value,text}], kreditorOptionen:[{value,text,ibanPflicht}], kreditorId, absender, betrag,
//     zahlungsziel, rechnungsnummer, qrIban }
// @param {object} konfig aus leseKonfiguration
// @returns {{ werte: object|null, fehler: string[], herkunft: Record<string,string> }}
export function kontierungsWerte(formular, konfig, { jobId, jetzt = new Date() } = {}) {
  const fehler = [];
  const herkunft = {};

  const konto = (formular.kontoOptionen || []).find((o) => o.value && kontonummerAusOption(o.text) === konfig.konto);
  if (!konto) {
    fehler.push(`Konto ${konfig.konto} steht bei Person A nicht zur Auswahl. Ist A auf diesem Konto Freigeber 1 (oder Stellvertretung 1)?`);
  }

  let kreditor = null;
  if (formular.kreditorId) {
    kreditor = (formular.kreditorOptionen || []).find((o) => o.value === formular.kreditorId) ?? null;
    if (kreditor) herkunft.lieferant = 'vorbelegt (QR/IBAN)';
  }
  if (!kreditor && konfig.lieferant) {
    kreditor = (formular.kreditorOptionen || []).find((o) => o.value && norm(o.text) === norm(konfig.lieferant)) ?? null;
    if (kreditor) herkunft.lieferant = 'Konfiguration';
    else fehler.push(`Lieferant «${konfig.lieferant}» (DURCHLAUF_LIEFERANT) steht nicht zur Auswahl.`);
  }
  if (!kreditor && !konfig.lieferant) {
    fehler.push('Der Lieferant ist nicht vorbelegt (keine QR-IBAN eines bekannten Lieferanten). DURCHLAUF_LIEFERANT setzen oder einen QR-Beleg mit hinterlegter IBAN schicken.');
  }

  let betrag = String(formular.betrag ?? '').trim();
  if (betrag) herkunft.betrag = 'vorbelegt (QR)';
  else if (konfig.betrag) { betrag = konfig.betrag; herkunft.betrag = 'Konfiguration'; }
  else fehler.push('Der Betrag ist nicht vorbelegt (kein QR-Code). DURCHLAUF_BETRAG setzen.');

  let ibanEndung = null;
  const ibanPflicht = Boolean(kreditor?.ibanPflicht) && !formular.qrIban;
  if (ibanPflicht) {
    if (konfig.ibanEndung) { ibanEndung = konfig.ibanEndung; herkunft.ibanEndung = 'Konfiguration'; }
    else fehler.push('Beleg ohne QR-Code: die letzten 4 Zeichen der IBAN sind Pflicht. DURCHLAUF_IBAN_ENDUNG setzen.');
  }

  const rechnungsnummer = String(formular.rechnungsnummer ?? '').trim()
    || testRechnungsnummer(konfig.rechnungsnummerPraefix, jetzt, jobId);
  herkunft.rechnungsnummer = String(formular.rechnungsnummer ?? '').trim() ? 'vorbelegt' : 'erzeugt';
  const zahlungsziel = String(formular.zahlungsziel ?? '').trim() || zahlungszielAb(jetzt, konfig.zahlungszielTage);
  const absender = String(formular.absender ?? '').trim() || konfig.absender;

  if (fehler.length > 0) return { werte: null, fehler, herkunft };
  return {
    werte: {
      kontoId: konto.value,
      kreditorId: kreditor.value,
      lieferant: kreditor.text.trim(),
      betrag,
      ibanEndung,
      rechnungsnummer,
      zahlungsziel,
      absender,
    },
    fehler,
    herkunft,
  };
}
