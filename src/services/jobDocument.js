// Das für Export und Zeitstempel massgebliche Dokument eines Vorgangs: bei einer Splitgruppe das zusammengeführte Gruppen-PDF
// des Elternvorgangs, sonst das PDF des Vorgangs selbst (jeweils mit dem Zeitstempel-/Endhash).

// @returns {object|null} Kopie des Vorgangs, bei der `pdf_pfad` und `zeitstempel_datei_hash` auf das massgebliche Dokument zeigen
export function jobDocument(job) {
  if (!job) return null;
  return job.status === 'aufgesplittet' || job.gruppe_pdf_pfad
    ? { ...job, pdf_pfad: job.gruppe_pdf_pfad, zeitstempel_datei_hash: job.gruppe_zeitstempel_datei_hash || job.gruppe_final_datei_hash }
    : { ...job, zeitstempel_datei_hash: job.zeitstempel_datei_hash || job.final_datei_hash };
}
