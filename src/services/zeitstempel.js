import { createHash } from 'node:crypto';
import { TimestampSession, MAX_PDF_SIZE, sendTimestampRequest, parseTimestampResponse, extractTimestamps, verifyTimestamp } from 'pdf-rfc3161';
import { freshTimestampRequest, validateTimestampBinding } from './tsaResponse.js';
import { loadTsaTrustAnchors, verifyTsaChain } from './tsaTrust.js';
import { loadTsaCrls } from './tsaRevocation.js';
import { baueTsaNachweis } from './tsaNachweis.js';

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

// Embeds an RFC3161 DocTimeStamp after checking request binding and cryptographic integrity.
// Configured local roots are required for chain validation. Revocation remains unchecked.
// Throws a German-message Error on any failure (network, TSA
// rejection, malformed PDF) — mirrors src/services/pdfStamp.js's stampAndFinalize, whose callers
// already expect a catchable, user-facing German message rather than the library's raw error.
// omitModificationTime is required, not optional — see this task's notes above.
export async function setZeitstempel(pdfBuffer, tsaConfig) {
  return (await setZeitstempelMitNachweis(pdfBuffer, tsaConfig)).stamped;
}

// Wie setZeitstempel, liefert zusaetzlich den Nachweis der verwendeten Zertifikats-/Sperrevidenz
// (services/tsaNachweis.js). Aufrufer, die einen Zeitstempel festschreiben, speichern diesen
// Nachweis in derselben Transaktion wie den Zeitstempel-Hash.
export async function setZeitstempelMitNachweis(pdfBuffer, tsaConfig) {
  let session;
  try {
    const anchors = tsaConfig.trustAnchorsFile || tsaConfig.requireTrustedChain !== false
      ? loadTsaTrustAnchors(tsaConfig.trustAnchorsFile, tsaConfig.trustAnchorsSha256) : null;
    const crls = anchors ? loadTsaCrls(tsaConfig.crlFile) : [];
    if (pdfBuffer.length > MAX_PDF_SIZE) throw new Error('PDF ueberschreitet die maximale Zeitstempel-Groesse.');
    // No automatic LTV: it appends unsigned revisions and may fetch certificate-supplied URLs.
    session = new TimestampSession(pdfBuffer, { enableLTV: false, hashAlgorithm: 'SHA-256', prepareOptions: { omitModificationTime: true, signatureSize: 32768 } });
    const request = freshTimestampRequest(await session.createTimestampRequest());
    const response = parseTimestampResponse(await sendTimestampRequest(request, {
      url: tsaConfig.url, headers: buildTsaHeaders(tsaConfig), ...TSA_TIMING,
    }));
    if (![0, 1].includes(response.status) || !response.token) throw new Error('TSA hat keinen erfolgreichen Zeitstempel geliefert.');
    const binding = validateTimestampBinding(request, response.token);
    const stamped = Buffer.from(await session.embedTimestampToken(response.token));
    const verification = await verifyZeitstempel(stamped);
    if (!verification.gueltig) throw new Error('TSA-Signatur oder Dokumentbindung ist ungueltig.');
    const kette = anchors ? await verifyTsaChain(binding, anchors, crls) : null;
    const nachweis = baueTsaNachweis({ binding, token: response.token, kette, trustAnchorsSha256: tsaConfig.trustAnchorsSha256 || null });
    return { stamped, nachweis };
  } catch (err) {
    throw new Error(`Zeitstempel konnte nicht gesetzt werden: ${err.message}`);
  } finally {
    session?.dispose();
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
  const timestamp = extrahiert.find((entry) => {
    const [start, length, secondStart, secondLength] = entry.byteRange;
    return start === 0 && length >= 0 && secondStart > length && secondLength >= 0 && secondStart + secondLength === pdfBuffer.length;
  }) || extrahiert[0];
  const verifiziert = await verifyTimestamp(timestamp, { pdf: pdfBuffer, strictESSValidation: true });
  const [start, length, secondStart, secondLength] = timestamp.byteRange;
  const vollstaendig = start === 0 && length >= 0 && secondStart > length && secondLength >= 0 && secondStart + secondLength === pdfBuffer.length;
  return {
    vorhanden: true,
    gueltig: verifiziert.verified && vollstaendig,
    signaturGueltig: verifiziert.verified,
    vollstaendig,
    vertrauen: 'nicht_geprueft',
    zeitpunkt: verifiziert.info.genTime.toISOString(),
    tsaPolicy: verifiziert.info.policy,
    ...basis,
  };
}
