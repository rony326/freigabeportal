import { getKkBelegByJobId } from '../db/kkBelegeRepo.js';
import { personName } from './auditLog.js';

// Eine Zeile für Stempelseite und Freigabe-Ansicht, die bei Kreditkarten-Teiljobs sichtbar macht,
// ob ein Beleg vorliegt -- das ist die Information, auf die Freigeber hier achten müssen.
export function kkHinweisFuerJob(db, job) {
  if (job.kk_eigenbeleg_grund === 'Gebühr/Zins') return 'Gebühr/Zins (ohne Beleg)';
  if (job.kk_eigenbeleg_grund) return `Ohne Beleg: ${job.kk_eigenbeleg_grund}`;
  const beleg = getKkBelegByJobId(db, job.id);
  if (!beleg) return null;
  return `Kreditkartenbeleg: gekauft von ${personName(db, beleg.gekauft_von)}, erfasst von ${personName(db, beleg.hochgeladen_von)}`;
}
