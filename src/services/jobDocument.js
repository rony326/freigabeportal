export function jobDocument(job) {
  if (!job) return null;
  return job.status === 'aufgesplittet' || job.gruppe_pdf_pfad
    ? { ...job, pdf_pfad: job.gruppe_pdf_pfad, zeitstempel_datei_hash: job.gruppe_zeitstempel_datei_hash || job.gruppe_final_datei_hash }
    : { ...job, zeitstempel_datei_hash: job.zeitstempel_datei_hash || job.final_datei_hash };
}
