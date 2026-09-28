import { listSplitKinder } from '../db/jobsRepo.js';
import { bestimmeZahlungsart, validateQrPayment, zahlungBestaetigungspflichtig } from './paymentApproval.js';

// Einzige Quelle fuer exportierte Beleg- und Zahlungsmetadaten. Werte stammen ausschliesslich aus
// dem bei Freigabe 2 eingefrorenen Snapshot, dem Gruppen-Snapshot oder einer protokollierten
// Altfall-Entscheidung -- nie aus der aktuellen jobs-/konten-Zeile oder aus ChurchTools.

function parse(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

export function getAltfallEntscheidung(db, jobId) {
  const row = db.prepare('SELECT * FROM altfall_entscheidungen WHERE job_id = ?').get(jobId);
  return row ? { ...row, angezeigte_daten: JSON.parse(row.angezeigte_daten) } : null;
}

function betragSigniert(betrag, typ) {
  const wert = Number(betrag);
  if (betrag == null || betrag === '' || Number.isNaN(wert)) return null;
  return (typ === 'gutschrift' ? -wert : wert).toFixed(2);
}

// Belegfelder eines eingefrorenen Job-Datensatzes (Snapshot oder Altfall-Anzeige).
export function belegMetadaten(job, konto) {
  const typ = job.typ || 'rechnung';
  return {
    quelle: job.quelle ?? null, eingang_am: job.eingang_am ?? null, absender: job.absender ?? null,
    dateiname: job.dateiname ?? null, lieferant: job.lieferant ?? null, rechnungsnummer: job.rechnungsnummer ?? null,
    betrag: job.betrag ?? null, typ, betrag_signiert: betragSigniert(job.betrag, typ),
    zahlungsziel: job.zahlungsziel ?? null,
    // An unknown invoice date must not be substituted with the payment deadline.
    rechnungsdatum: job.rechnungsdatum || null,
    konto_id: konto?.id ?? job.konto_id ?? null,
    konto_kontonummer: konto?.kontonummer ?? null, konto_bezeichnung: konto?.bezeichnung ?? null,
    position: job.rechnungsposition ?? null,
    eingereicht_von: job.eingereicht_von ?? null, auslage_datum: job.auslage_datum ?? null, beschreibung: job.beschreibung ?? null,
    qr_iban: job.qr_iban ?? null, qr_referenz: job.qr_referenz ?? null, qr_betrag: job.qr_betrag ?? null,
    qr_waehrung: job.qr_waehrung ?? null, qr_creditor_name: job.qr_creditor_name ?? null, qr_erkannt_am: job.qr_erkannt_am ?? null,
  };
}

// Zahlungsstand eines Einzel-Snapshots. Version 1 (vor diesem Paket) kannte nur die
// Spesen-Bestaetigung; eine QR-Rechnung aus Version 1 gilt deshalb als unbestaetigt.
export function zahlungAusSnapshot(snapshot) {
  if (snapshot.zahlung) return snapshot.zahlung;
  const job = snapshot.job || {};
  if (job.quelle === 'spesen') {
    const b = snapshot.zahlungsdaten_bestaetigung;
    return {
      art: 'spesen', daten: snapshot.zahlungsdaten || null, abgleich: null, hinweise: [],
      bestaetigung: snapshot.zahlungsdaten && b ? { person_id: b.personId, zeitpunkt: b.zeitpunkt, stand: b.stand } : null,
    };
  }
  const art = bestimmeZahlungsart(job);
  if (art !== 'qr_rechnung') return { art, daten: null, abgleich: null, hinweise: [], bestaetigung: null };
  const daten = validateQrPayment(job);
  return daten
    ? { art, daten, abgleich: null, hinweise: [], bestaetigung: null }
    : { art: 'ohne_zahlungsdaten', daten: null, abgleich: null, hinweise: ['qr_ungueltig'], bestaetigung: null };
}

export function zahlungVollstaendig(zahlung) {
  if (!zahlung) return false;
  if ((zahlung.art === 'spesen' || zahlung.art === 'qr_rechnung') && !zahlung.daten) return false;
  return !zahlungBestaetigungspflichtig(zahlung) || Boolean(zahlung.bestaetigung);
}

// Exportform. `freigegeben` ist die einzige Aussage, auf die hin n8n eine Zahlung ausloesen darf.
export function zahlungExport(zahlung, herkunft) {
  if (!zahlung) {
    return { art: null, freigegeben: false, herkunft, iban: null, kontoinhaber: null, referenz: null, betrag: null, waehrung: null, iban_abgleich: null, hinweise: [], bestaetigt_von: null, bestaetigt_am: null };
  }
  const daten = zahlung.daten || {};
  const bestaetigt = zahlungVollstaendig(zahlung);
  return {
    art: zahlung.art,
    freigegeben: bestaetigt && herkunft !== 'altfall_nur_archiv' && Boolean(zahlung.daten) && (zahlung.art === 'spesen' || zahlung.art === 'qr_rechnung'),
    herkunft,
    iban: daten.iban ?? null,
    kontoinhaber: daten.kontoinhaber ?? daten.empfaenger ?? null,
    referenz: daten.referenz ?? null,
    betrag: daten.betrag ?? null,
    waehrung: daten.waehrung ?? null,
    iban_abgleich: zahlung.abgleich ?? null,
    hinweise: zahlung.hinweise || [],
    bestaetigt_von: zahlung.bestaetigung?.person_id ?? null,
    bestaetigt_am: zahlung.bestaetigung?.zeitpunkt ?? null,
  };
}

function bereitsUebergeben(job) {
  return job.status === 'abgeholt' || job.status === 'archiviert' || Boolean(job.gruppe_abgeholt_am);
}

function unbelegt(job) {
  // Nur fuer bereits uebergebene Altfaelle: aktueller Datensatz, ausdruecklich nicht freigabegebunden.
  return { hinweis: 'Aktueller Datensatz zum Exportzeitpunkt, nicht durch eine Freigabe belegt.', ...belegMetadaten(job, null), konto_kontonummer: undefined, konto_bezeichnung: undefined };
}

function ausEntscheidung(entscheidung, extra = {}) {
  const herkunft = entscheidung.entscheidung === 'nachbestaetigt' ? 'altfall_nachbestaetigt' : 'altfall_nur_archiv';
  const daten = entscheidung.angezeigte_daten;
  const zahlung = entscheidung.entscheidung === 'nachbestaetigt' && daten.zahlung
    ? { ...daten.zahlung, bestaetigung: { person_id: entscheidung.person_id, zeitpunkt: entscheidung.zeitpunkt, stand: entscheidung.stand } }
    : daten.zahlung ? { ...daten.zahlung, bestaetigung: null } : null;
  return {
    status: herkunft, exportierbar: true, grund: null, metadaten: daten.metadaten,
    zahlung: zahlungExport(zahlung, herkunft),
    altfall: { id: entscheidung.id, entscheidung: entscheidung.entscheidung, person_id: entscheidung.person_id, person_name: entscheidung.person_name, begruendung: entscheidung.begruendung, zeitpunkt: entscheidung.zeitpunkt, herkunft: daten.herkunft },
    ...extra,
  };
}

export function einzelNachweis(db, job) {
  const snapshot = parse(job.freigabe_snapshot);
  if (snapshot?.job) {
    const zahlung = zahlungAusSnapshot(snapshot);
    if (zahlungVollstaendig(zahlung)) {
      return { status: 'snapshot', exportierbar: true, grund: null, metadaten: belegMetadaten(snapshot.job, snapshot.konto), zahlung: zahlungExport(zahlung, 'freigabe2') };
    }
  }
  const entscheidung = getAltfallEntscheidung(db, job.id);
  if (entscheidung) return ausEntscheidung(entscheidung);
  if (snapshot?.job) {
    return {
      status: 'snapshot_zahlung_unbestaetigt', exportierbar: false,
      grund: 'Die Zahlungsdaten wurden bei Freigabe 2 nicht ausdruecklich bestaetigt.',
      metadaten: belegMetadaten(snapshot.job, snapshot.konto), zahlung: zahlungExport({ ...zahlungAusSnapshot(snapshot) }, 'freigabe2_unbestaetigt'),
    };
  }
  return {
    status: 'historisch_unvollstaendig', exportierbar: false,
    grund: 'Kein Freigabe-Snapshot vorhanden.', metadaten: null, zahlung: zahlungExport(null, null), unbelegte_jobdaten: unbelegt(job),
  };
}

export function gruppenNachweis(db, parent) {
  const snapshot = parse(parent.gruppe_freigabe_snapshot);
  if (snapshot) {
    // Eine per Altfall-Entscheidung finalisierte Gruppe traegt deren Status und Kennzeichnung weiter.
    const status = snapshot.nachweis_status || 'snapshot';
    return {
      status, exportierbar: true, grund: null, metadaten: snapshot.metadaten, positionen: snapshot.positionen,
      zahlung: zahlungExport(snapshot.zahlung, status === 'snapshot' ? 'freigabe2' : status),
      ...(snapshot.altfall ? { altfall: snapshot.altfall } : {}),
    };
  }
  const entscheidung = getAltfallEntscheidung(db, parent.id);
  if (entscheidung) return ausEntscheidung(entscheidung, { positionen: entscheidung.angezeigte_daten.positionen || [] });
  const kinder = listSplitKinder(db, parent.id).filter((kind) => kind.status !== 'geloescht');
  return {
    status: 'historisch_unvollstaendig', exportierbar: false,
    grund: 'Kein Gruppen-Freigabe-Snapshot vorhanden.', metadaten: null, zahlung: zahlungExport(null, null),
    unbelegte_jobdaten: unbelegt(parent),
    positionen: kinder.map((kind) => {
      const nachweis = einzelNachweis(db, kind);
      return { job_id: kind.id, nachweis_status: nachweis.status, ...(nachweis.metadaten || { unbelegte_jobdaten: unbelegt(kind) }) };
    }),
  };
}

// Nachweis fuer die n8n-Uebergabe bzw. das Archiv. Ein bereits uebergebener Altfall bleibt
// archivierbar (mit gekennzeichnetem Nachweisumfang und ohne Zahlungsfreigabe); ein noch nicht
// uebergebener Altfall ist gesperrt, bis eine Altfall-Entscheidung vorliegt.
export function exportNachweis(db, job) {
  const nachweis = job.status === 'aufgesplittet' || job.gruppe_pdf_pfad ? gruppenNachweis(db, job) : einzelNachweis(db, job);
  if (!nachweis.exportierbar && bereitsUebergeben(job)) return { ...nachweis, exportierbar: true, archiv_ohne_zahlung: true };
  return nachweis;
}

export function kindPosition(kind, snapshot) {
  return {
    job_id: kind.id,
    nachweis_status: 'snapshot',
    ...belegMetadaten(snapshot.job, snapshot.konto),
    datei_sha256: kind.zeitstempel_datei_hash || kind.final_datei_hash || null,
    freigeber1: snapshot.stampData?.freigeber1 ?? null,
    freigeber2: snapshot.stampData?.freigeber2 ?? null,
    kkHinweis: snapshot.stampData?.kkHinweis ?? null,
    verlauf: snapshot.stampData?.verlauf ?? [],
  };
}

// Erwartete Gruppenzahlung aus den eingefrorenen Eingangsdaten des Elternjobs (QR-Scan).
function erwarteteGruppenZahlung(parent) {
  const art = bestimmeZahlungsart(parent);
  if (art !== 'qr_rechnung') return { art, daten: null, hinweise: [] };
  const daten = validateQrPayment(parent);
  return daten ? { art, daten, hinweise: [] } : { art: 'ohne_zahlungsdaten', daten: null, hinweise: ['qr_ungueltig'] };
}

// Stellt den Gruppen-Snapshot vor der Finalisierung zusammen. Jede Position muss einen
// Freigabe-Snapshot tragen; alle Teilbelege muessen dieselbe Gesamtzahlung ausdruecklich
// bestaetigt haben. Sonst entscheidet nur eine protokollierte Altfall-Entscheidung.
export function bereiteGruppenSnapshotVor(db, parent, kinder, erstelltAm = new Date().toISOString()) {
  const metadaten = { ...belegMetadaten(parent, null), konto_id: null, position: null, anzahl_positionen: kinder.length };
  const erwartet = erwarteteGruppenZahlung(parent);
  let grund = null;
  const positionen = [];
  const bestaetigungen = [];
  let abgleich = null;
  const hinweise = new Set(erwartet.hinweise);
  for (const kind of kinder) {
    const snapshot = parse(kind.freigabe_snapshot);
    if (!snapshot?.job) { grund = `Teilbeleg ${kind.id} hat keinen Freigabe-Snapshot.`; break; }
    const zahlung = zahlungAusSnapshot(snapshot);
    if (zahlung.art !== erwartet.art || JSON.stringify(zahlung.daten) !== JSON.stringify(erwartet.daten)) {
      grund = `Teilbeleg ${kind.id} hat andere Zahlungsdaten bestaetigt als die Gesamtrechnung.`; break;
    }
    if (!zahlungVollstaendig({ ...zahlung, hinweise: [...new Set([...zahlung.hinweise, ...erwartet.hinweise])] })) {
      grund = `Die Zahlungsdaten von Teilbeleg ${kind.id} wurden nicht ausdruecklich bestaetigt.`; break;
    }
    zahlung.hinweise.forEach((h) => hinweise.add(h));
    abgleich = abgleich ?? zahlung.abgleich;
    if (zahlung.bestaetigung) bestaetigungen.push({ job_id: kind.id, ...zahlung.bestaetigung });
    positionen.push(kindPosition(kind, snapshot));
  }
  if (!grund) {
    const letzte = bestaetigungen.reduce((a, b) => (!a || b.zeitpunkt > a.zeitpunkt ? b : a), null);
    return {
      snapshot: {
        version: 1, erstellt_am: erstelltAm, nachweis_status: 'snapshot', metadaten, positionen,
        zahlung: { art: erwartet.art, daten: erwartet.daten, abgleich, hinweise: [...hinweise], bestaetigung: letzte, bestaetigungen },
      },
    };
  }
  const entscheidung = getAltfallEntscheidung(db, parent.id);
  if (!entscheidung) return { nachpruefung: grund };
  const daten = entscheidung.angezeigte_daten;
  const status = entscheidung.entscheidung === 'nachbestaetigt' ? 'altfall_nachbestaetigt' : 'altfall_nur_archiv';
  return {
    snapshot: {
      version: 1, erstellt_am: erstelltAm, nachweis_status: status, metadaten: daten.metadaten, positionen: daten.positionen,
      zahlung: daten.zahlung && entscheidung.entscheidung === 'nachbestaetigt'
        ? { ...daten.zahlung, bestaetigung: { person_id: entscheidung.person_id, zeitpunkt: entscheidung.zeitpunkt, stand: entscheidung.stand } }
        : daten.zahlung ? { ...daten.zahlung, bestaetigung: null } : null,
      altfall: { id: entscheidung.id, entscheidung: entscheidung.entscheidung, person_id: entscheidung.person_id, person_name: entscheidung.person_name, begruendung: entscheidung.begruendung, zeitpunkt: entscheidung.zeitpunkt, herkunft: daten.herkunft },
    },
  };
}
