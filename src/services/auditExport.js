import { createHash } from 'node:crypto';
import { kanonischesJson } from './tsaNachweis.js';

// Lokale Grundlage fuer einen spaeteren externen Audit-Nachweis. Ein unveraenderliches externes
// Speicherziel ist noch NICHT festgelegt; dieses Modul transportiert nichts und behauptet keine
// externe Unveraenderlichkeit.
//
// Ein Paket enthaelt die Audit-Ereignisse ab der letzten exportierten ID in kanonischer JSONL-Form
// (inkl. Request-/Laufzuordnung) und ein Manifest mit ID-Bereich, erkannten ID-Luecken,
// Inhalts-Hash und dem Hash des Vorgaengerpakets. Wer die Manifeste ausserhalb des Einflussbereichs
// der Anwendung aufbewahrt, kann spaeter nachweisen, dass exportierte Ereignisse lokal nicht
// veraendert oder entfernt wurden und keine Pakete fehlen. Lokale Hashketten allein beweisen das
// nicht: wer DB und Register kontrolliert, kann beide konsistent neu berechnen.

export const AUDIT_EXPORT_FORMAT = 'freigabeportal-audit-export/1';
export const MAX_EREIGNISSE_PRO_PAKET = 5000;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function ereignisse(db, vonId, bisId, limit) {
  return db.prepare(`SELECT e.id, e.zeitpunkt, e.person_id, e.person_name, e.objekt, e.objekt_id, e.aktion, e.vorher, e.nachher, e.begruendung,
      r.request_id, l.lauf_id, l.lauf_typ
    FROM audit_ereignisse e
    LEFT JOIN audit_request_zuordnung r ON r.ereignis_id = e.id
    LEFT JOIN audit_lauf_zuordnung l ON l.ereignis_id = e.id
    WHERE e.id >= ? AND e.id <= ? ORDER BY e.id LIMIT ?`).all(vonId, bisId, limit).map((row) => ({ ...row }));
}

function inhaltAus(rows) {
  return rows.map((row) => kanonischesJson(row)).join('\n') + '\n';
}

function lueckenIn(vonId, rows) {
  const luecken = [];
  let erwartet = vonId;
  for (const row of rows) {
    if (row.id > erwartet) luecken.push([erwartet, row.id - 1]);
    erwartet = row.id + 1;
  }
  return luecken;
}

function paketHash(manifest) {
  const { paketSha256, ...ohneHash } = manifest;
  return sha256(kanonischesJson(ohneHash));
}

function manifestAusZeile(row, paketNr) {
  const manifest = {
    format: AUDIT_EXPORT_FORMAT, paketNr, vonId: row.von_id, bisId: row.bis_id, anzahl: row.anzahl,
    luecken: JSON.parse(row.luecken), inhaltSha256: row.inhalt_sha256, vorgaengerPaketSha256: row.vorgaenger_sha256, erstelltAm: row.erstellt_am,
  };
  return { ...manifest, paketSha256: row.paket_sha256 };
}

export function ausstehendeAuditEreignisse(db) {
  const letzter = db.prepare('SELECT bis_id FROM audit_export_pakete ORDER BY id DESC LIMIT 1').get();
  return db.prepare('SELECT count(*) AS n FROM audit_ereignisse WHERE id > ?').get(letzter?.bis_id ?? 0).n;
}

// Erzeugt das naechste Paket und registriert es. Unter BEGIN IMMEDIATE, damit parallele Exporte
// keine verzweigte Kette bilden und kein gleichzeitig geschriebenes Ereignis uebersprungen wird.
export function erstelleAuditExportPaket(db, { maxEreignisse = MAX_EREIGNISSE_PRO_PAKET, jetzt = new Date() } = {}) {
  if (!Number.isSafeInteger(maxEreignisse) || maxEreignisse < 1 || maxEreignisse > MAX_EREIGNISSE_PRO_PAKET) throw new Error('Ungueltige Paketgroesse.');
  if (db.isTransaction) throw new Error('Audit-Export braucht eine eigene Transaktion.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const letzter = db.prepare('SELECT * FROM audit_export_pakete ORDER BY id DESC LIMIT 1').get();
    const vonId = (letzter?.bis_id ?? 0) + 1;
    const rows = ereignisse(db, vonId, Number.MAX_SAFE_INTEGER, maxEreignisse);
    if (!rows.length) { db.exec('COMMIT'); return null; }
    const inhalt = inhaltAus(rows);
    const manifest = {
      format: AUDIT_EXPORT_FORMAT,
      paketNr: (letzter?.id ?? 0) + 1,
      vonId,
      bisId: rows.at(-1).id,
      anzahl: rows.length,
      luecken: lueckenIn(vonId, rows),
      inhaltSha256: sha256(inhalt),
      vorgaengerPaketSha256: letzter?.paket_sha256 ?? null,
      erstelltAm: jetzt.toISOString(),
    };
    manifest.paketSha256 = paketHash(manifest);
    const id = Number(db.prepare(`INSERT INTO audit_export_pakete (von_id, bis_id, anzahl, luecken, inhalt_sha256, vorgaenger_sha256, paket_sha256, erstellt_am)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(manifest.vonId, manifest.bisId, manifest.anzahl, JSON.stringify(manifest.luecken),
      manifest.inhaltSha256, manifest.vorgaengerPaketSha256, manifest.paketSha256, manifest.erstelltAm).lastInsertRowid);
    if (id !== manifest.paketNr) throw new Error('Paketnummer ist nicht fortlaufend.');
    db.exec('COMMIT');
    return { manifest, inhalt };
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

// Gibt ein bereits registriertes Paket erneut aus (z.B. wenn das Schreiben der Dateien nach der
// Registrierung scheiterte). Weicht der neu berechnete Inhalt ab, wird nichts ausgegeben.
export function ladeAuditExportPaket(db, paketNr) {
  const row = db.prepare('SELECT * FROM audit_export_pakete WHERE id = ?').get(paketNr);
  if (!row) return null;
  const inhalt = inhaltAus(ereignisse(db, row.von_id, row.bis_id, Number.MAX_SAFE_INTEGER));
  if (sha256(inhalt) !== row.inhalt_sha256) throw new Error('Audit-Ereignisse weichen vom registrierten Paket ab.');
  return { manifest: manifestAusZeile(row, row.id), inhalt };
}

// Gleicht das lokale Register mit dem aktuellen Auditprotokoll ab: Kettenverweise, Paket-Hashes
// und neu berechnete Inhalts-Hashes. Befunde zeigen lokale Abweichungen; ein leeres Ergebnis ist
// nur so vertrauenswuerdig wie das Register selbst (siehe oben).
export function pruefeAuditExportRegister(db) {
  const befunde = [];
  let vorgaenger = null;
  let erwarteteVonId = 1;
  for (const row of db.prepare('SELECT * FROM audit_export_pakete ORDER BY id').all()) {
    const manifest = manifestAusZeile(row, row.id);
    if (paketHash(manifest) !== row.paket_sha256) befunde.push({ paketNr: row.id, befund: 'paket_hash_abweichend' });
    if (manifest.vorgaengerPaketSha256 !== (vorgaenger?.paket_sha256 ?? null)) befunde.push({ paketNr: row.id, befund: 'kette_unterbrochen' });
    if (row.von_id !== erwarteteVonId) befunde.push({ paketNr: row.id, befund: 'bereich_nicht_anschliessend' });
    const rows = ereignisse(db, row.von_id, row.bis_id, Number.MAX_SAFE_INTEGER);
    if (rows.length !== row.anzahl || sha256(inhaltAus(rows)) !== row.inhalt_sha256) befunde.push({ paketNr: row.id, befund: 'inhalt_abweichend' });
    vorgaenger = row;
    erwarteteVonId = row.bis_id + 1;
  }
  return { pakete: vorgaenger?.id ?? 0, ausstehend: ausstehendeAuditEreignisse(db), befunde };
}

// Pruefung eines ausgelieferten Pakets ohne Datenbank (fuer den spaeteren Empfaenger oder eine
// Abnahme): Inhalt passt zum Manifest, IDs aufsteigend im Bereich, Kette zum Vorgaenger.
export function pruefeAuditExportPaket(manifest, inhalt, vorgaengerManifest = null) {
  const befunde = [];
  if (manifest?.format !== AUDIT_EXPORT_FORMAT) return ['format_unbekannt'];
  if (paketHash(manifest) !== manifest.paketSha256) befunde.push('paket_hash_abweichend');
  if (sha256(inhalt) !== manifest.inhaltSha256) befunde.push('inhalt_hash_abweichend');
  const zeilen = inhalt.endsWith('\n') ? inhalt.slice(0, -1).split('\n') : ['ungueltig'];
  let ids = [];
  try { ids = zeilen.map((zeile) => JSON.parse(zeile).id); } catch { befunde.push('zeile_ungueltig'); }
  if (ids.length !== manifest.anzahl) befunde.push('anzahl_abweichend');
  if (ids.some((id, i) => !Number.isSafeInteger(id) || id < manifest.vonId || id > manifest.bisId || (i > 0 && id <= ids[i - 1]))) befunde.push('ids_ungueltig');
  if (kanonischesJson(lueckenIn(manifest.vonId, ids.map((id) => ({ id })))) !== kanonischesJson(manifest.luecken)) befunde.push('luecken_abweichend');
  if (vorgaengerManifest) {
    if (manifest.vorgaengerPaketSha256 !== vorgaengerManifest.paketSha256) befunde.push('kette_unterbrochen');
    if (manifest.vonId !== vorgaengerManifest.bisId + 1 || manifest.paketNr !== vorgaengerManifest.paketNr + 1) befunde.push('nicht_anschliessend');
  } else if (manifest.paketNr === 1 && (manifest.vorgaengerPaketSha256 !== null || manifest.vonId !== 1)) {
    befunde.push('kettenanfang_ungueltig');
  }
  return befunde;
}
