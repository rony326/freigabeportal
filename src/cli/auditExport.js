import { parseArgs } from 'node:util';
import { openSync, writeFileSync, fsyncSync, closeSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { loadStorageConfig } from '../config/env.js';
import { resolveStorageConfig } from '../services/storageState.js';
import { openDatabase } from '../db/index.js';
import { erstelleAuditExportPaket, ladeAuditExportPaket, pruefeAuditExportRegister, ausstehendeAuditEreignisse } from '../services/auditExport.js';

// Betreiberwerkzeug: erzeugt das naechste Audit-Exportpaket als Dateipaar im angegebenen
// Verzeichnis (Modus 0600, nie ueberschreibend) bzw. prueft das lokale Register. Die Dateien
// enthalten personenbezogene Audit-Daten und muessen entsprechend geschuetzt uebergeben werden.
// Der Transport zu einem externen, unveraenderlichen Ziel ist bewusst nicht Teil dieses Werkzeugs.
function schreibeExklusiv(pfad, inhalt) {
  const fd = openSync(pfad, 'wx', 0o600);
  try { writeFileSync(fd, inhalt); fsyncSync(fd); } finally { closeSync(fd); }
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, max: { type: 'string' }, paket: { type: 'string' } } });
  const command = positionals[0];
  const db = openDatabase(resolveStorageConfig(loadStorageConfig()).dbPath);
  let result;
  try {
    if (command === 'status') result = { ausstehend: ausstehendeAuditEreignisse(db) };
    else if (command === 'verify') result = pruefeAuditExportRegister(db);
    else if (command === 'export') {
      if (!values.out || !lstatSync(values.out).isDirectory()) throw new Error('Ein vorhandenes Zielverzeichnis ist erforderlich (--out).');
      // --paket N gibt ein bereits registriertes Paket erneut aus, statt ein neues zu erzeugen.
      const paket = values.paket
        ? ladeAuditExportPaket(db, Number(values.paket))
        : erstelleAuditExportPaket(db, values.max ? { maxEreignisse: Number(values.max) } : {});
      if (!paket) result = { exportiert: 0 };
      else {
        const basis = join(values.out, `audit-export-${String(paket.manifest.paketNr).padStart(8, '0')}`);
        schreibeExklusiv(`${basis}.jsonl`, paket.inhalt);
        schreibeExklusiv(`${basis}.manifest.json`, `${JSON.stringify(paket.manifest, null, 2)}\n`);
        result = { exportiert: paket.manifest.anzahl, manifest: paket.manifest };
      }
    } else throw new Error('Befehl erwartet: export, verify oder status.');
  } finally { db.close(); }
  console.log(JSON.stringify(result, null, 2));
  if (command === 'verify' && result.befunde.length) process.exitCode = 2;
} catch (err) {
  console.error(`Audit-Export fehlgeschlagen: ${err.message}`);
  process.exitCode = 1;
}
