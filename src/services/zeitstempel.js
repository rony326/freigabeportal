import { createHash } from 'node:crypto';
import { timestampPdf, extractTimestamps, verifyTimestamp } from 'pdf-rfc3161';

// Bounded well below the library's own defaults (timeout 30000ms, retry 3, retryDelay 1000ms —
// worst case over 90s) because setZeitstempel runs synchronously inside the Freigabe-2 POST
// request (see freigabe2.js): a hung/unreachable TSA must fail fast so the request can fall
// through to its non-blocking "best-effort, retried later by the nachhol-job" behavior instead of
// leaving the submitting person's browser hanging for a minute and a half.
const TSA_TIMING = { timeout: 8000, retry: 1, retryDelay: 300 };

// pdf-rfc3161's TSAConfig has no built-in `auth` option (confirmed against the real published
// API — see this task's notes above), so TSA Basic-Auth has to be built by hand into a header.
// Only needed for a production-grade TSA that requires credentials; FreeTSA does not.
function buildTsaHeaders(tsaConfig) {
  if (!tsaConfig.user) return undefined;
  const credentials = Buffer.from(`${tsaConfig.user}:${tsaConfig.passwort || ''}`).toString('base64');
  return { Authorization: `Basic ${credentials}` };
}

// Embeds a PAdES-style RFC3161 DocTimeStamp into the PDF, proving the document existed unchanged
// since the TSA's timestamp. Throws a German-message Error on any failure (network, TSA
// rejection, malformed PDF) — mirrors src/services/pdfStamp.js's stampAndFinalize, whose callers
// already expect a catchable, user-facing German message rather than the library's raw error.
// omitModificationTime is required, not optional — see this task's notes above.
export async function setZeitstempel(pdfBuffer, tsaConfig) {
  try {
    const result = await timestampPdf({
      pdf: pdfBuffer,
      tsa: { url: tsaConfig.url, headers: buildTsaHeaders(tsaConfig), ...TSA_TIMING },
      omitModificationTime: true,
    });
    return Buffer.from(result.pdf);
  } catch (err) {
    throw new Error(`Zeitstempel konnte nicht gesetzt werden: ${err.message}`);
  }
}

// Never throws: a PDF with no timestamp, a corrupt/unreadable PDF, or a cryptographically invalid
// timestamp are all normal, displayable outcomes for the verification UI (dashboard link, upload
// tool) — not error conditions the caller needs to catch.
//
// erwarteterHash lets a caller with a DB-stored hash (a job's zeitstempel_datei_hash) ask "is this
// really that exact file?" — independent of the RFC3161 result. RFC3161 alone proves "this file is
// unchanged since it was stamped", but not "this is the file that belongs to this job": a job's
// pdf_pfad could be swapped for a different, separately valid, stamped PDF without RFC3161 alone
// noticing. dateiHash is always computed, whether or not a timestamp is present, since the hash
// comparison is an independent fact about the bytes, not a sub-step of the RFC3161 check.
export async function verifyZeitstempel(pdfBuffer, erwarteterHash = null) {
  const dateiHash = createHash('sha256').update(pdfBuffer).digest('hex');
  const hashUebereinstimmung = erwarteterHash != null ? dateiHash === erwarteterHash : null;
  const basis = { dateiHash, hashUebereinstimmung };

  let extrahiert;
  try {
    extrahiert = await extractTimestamps(pdfBuffer);
  } catch {
    return { vorhanden: false, gueltig: false, zeitpunkt: null, tsaPolicy: null, ...basis };
  }
  if (extrahiert.length === 0) {
    return { vorhanden: false, gueltig: false, zeitpunkt: null, tsaPolicy: null, ...basis };
  }
  const verifiziert = await verifyTimestamp(extrahiert[0], { pdf: pdfBuffer });
  return {
    vorhanden: true,
    gueltig: verifiziert.verified,
    zeitpunkt: verifiziert.info.genTime.toISOString(),
    tsaPolicy: verifiziert.info.policy,
    ...basis,
  };
}
