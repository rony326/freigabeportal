// Schreibt das endgültige (gestempelte) PDF eines Vorgangs dauerhaft und crash-sicher in die Ablage.

import { openSync, writeFileSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Legt das fertige Dokument unter einem neuen Namen (`final-<uuid>.pdf`, Modus 0600) neben der Quelldatei an, mit fsync auf Datei und
// Verzeichnis. @returns {string} Pfad der neuen Datei
export function writeFinalDocument(sourcePath, bytes) {
  const path = join(dirname(sourcePath), `final-${randomUUID()}.pdf`);
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return path;
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(path); } catch { /* Die Datei wurde evtl. nie angelegt. */ }
    throw err;
  }
}
