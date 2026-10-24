import { auditedJob } from './auditOperation.js';

const TAG_MS = 24 * 3600 * 1000;
// Aufbewahrungsfristen in Tagen (siehe docs/betrieb-und-nutzung.md).
const FRIST_SEITENAUFRUFE = 90;
const FRIST_UEBRIGE = 365;

function laeuft(db, sql, grenze) {
  return Number(db.prepare(sql).run(grenze).changes);
}

function bereinige(db, config, mailer, { jetzt = new Date() } = {}) {
  const grenze = (tage) => new Date(jetzt.getTime() - tage * TAG_MS).toISOString();
  const alt = grenze(FRIST_UEBRIGE);
  const geloescht = {
    seitenaufrufe: laeuft(db, 'DELETE FROM nutzung_seitenaufrufe WHERE zeitpunkt < ?', grenze(FRIST_SEITENAUFRUFE)),
    anmeldungen: laeuft(db, 'DELETE FROM nutzung_anmeldungen WHERE zeitpunkt < ?', alt),
    fehler: laeuft(db, 'DELETE FROM betrieb_fehler WHERE zeitpunkt < ?', alt),
    meldungen: laeuft(db, 'DELETE FROM betrieb_fehlermeldungen WHERE zeitpunkt < ?', alt),
    geraete: laeuft(db, 'DELETE FROM nutzung_geraete WHERE zuletzt_am < ?', alt),
    // Ausblend-Merker nur für Banner, die seit über einem Jahr abgelaufen sind (oder nicht mehr existieren).
    bannerAusgeblendet: laeuft(db, `DELETE FROM banner_ausgeblendet WHERE banner_id NOT IN
      (SELECT id FROM banner WHERE bis >= ?)`, alt),
  };
  return { status: 'erfolg', geloescht };
}

export const runNutzungsdatenBereinigungJob = auditedJob('nutzungsdaten-bereinigung', bereinige);
