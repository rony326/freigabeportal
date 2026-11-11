// RFC3161-Zeitstempel für PDFs (docs/zeitstempel-und-pruefbescheinigung.md): Zeitstempel anfordern und einbetten, Nachweis zusammenstellen und
// einen Zeitstempel samt Dateihash prüfen. Wird bei Abschluss von Freigabe 2 und vom Nachhol-Job genutzt.

import { createHash } from 'node:crypto';
import { TimestampSession, MAX_PDF_SIZE, sendTimestampRequest, parseTimestampResponse, extractTimestamps, verifyTimestamp } from 'pdf-rfc3161';
import { freshTimestampRequest, validateTimestampBinding } from './tsaResponse.js';
import { loadTsaTrustAnchors, verifyTsaChain } from './tsaTrust.js';
import { loadTsaCrls } from './tsaRevocation.js';
import { baueTsaNachweis } from './tsaNachweis.js';

// Deutlich unter den eigenen Standardwerten der Bibliothek begrenzt (timeout 30000 ms, retry 3, retryDelay 1000 ms — im schlechtesten Fall
// über 90 s), weil setZeitstempel synchron innerhalb der POST-Anfrage von Freigabe 2 läuft (siehe freigabe2.js): Eine hängende/unerreichbare
// TSA muss schnell scheitern, damit die Anfrage in ihr nicht blockierendes "Best-Effort, später vom Nachhol-Job wiederholt" ausweichen kann,
// statt den Browser der einreichenden Person anderthalb Minuten hängen zu lassen.
const TSA_TIMING = { timeout: 8000, retry: 1, retryDelay: 300 };

// Das TSAConfig von pdf-rfc3161 hat keine eingebaute `auth`-Option (gegen die echte veröffentlichte API bestätigt), deshalb wird die
// TSA-Basic-Authentifizierung von Hand in einen Header gebaut. Nur für eine produktionstaugliche TSA nötig, die Zugangsdaten verlangt;
// FreeTSA verlangt keine.
export function buildTsaHeaders(tsaConfig) {
  if (!tsaConfig.user) return undefined;
  const credentials = Buffer.from(`${tsaConfig.user}:${tsaConfig.passwort || ''}`).toString('base64');
  return { Authorization: `Basic ${credentials}` };
}

// Bettet einen RFC3161-DocTimeStamp ein, nachdem Anfragebindung und kryptografische Integrität geprüft wurden. Für die Kettenprüfung sind
// lokal konfigurierte Wurzeln nötig. Wirft bei jedem Fehler (Netzwerk, TSA-Ablehnung, kaputtes PDF) einen Error mit deutscher Meldung —
// entspricht stampAndFinalize in src/services/pdfStamp.js, dessen Aufrufer schon eine abfangbare, für Benutzer:innen gedachte deutsche
// Meldung statt des rohen Bibliotheksfehlers erwarten. omitModificationTime ist Pflicht, nicht optional.
// @returns {Promise<Buffer>} das gestempelte PDF
export async function setZeitstempel(pdfBuffer, tsaConfig) {
  return (await setZeitstempelMitNachweis(pdfBuffer, tsaConfig)).stamped;
}

// Wie setZeitstempel, liefert zusaetzlich den Nachweis der verwendeten Zertifikats-/Sperrevidenz
// (services/tsaNachweis.js). Aufrufer, die einen Zeitstempel festschreiben, speichern diesen
// Nachweis in derselben Transaktion wie den Zeitstempel-Hash.
// @returns {Promise<{stamped: Buffer, nachweis: object}>}
export async function setZeitstempelMitNachweis(pdfBuffer, tsaConfig) {
  let session;
  try {
    const anchors = tsaConfig.trustAnchorsFile || tsaConfig.requireTrustedChain !== false
      ? loadTsaTrustAnchors(tsaConfig.trustAnchorsFile, tsaConfig.trustAnchorsSha256) : null;
    const crls = anchors ? loadTsaCrls(tsaConfig.crlFile) : [];
    if (pdfBuffer.length > MAX_PDF_SIZE) throw new Error('PDF ueberschreitet die maximale Zeitstempel-Groesse.');
    // Kein automatisches LTV: Es hängt unsignierte Revisionen an und lädt womöglich von Zertifikaten genannte URLs.
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

// Wirft nie: Ein PDF ohne Zeitstempel, ein kaputtes/unlesbares PDF oder ein kryptografisch ungültiger Zeitstempel sind alle normale,
// anzeigbare Ergebnisse für die Prüf-Oberfläche (Dashboard-Link, Upload-Werkzeug) — keine Fehlerfälle, die der Aufrufer abfangen müsste.
//
// erwarteterHash lässt einen Aufrufer mit einem in der DB gespeicherten Hash (zeitstempel_datei_hash eines Vorgangs) fragen "ist das wirklich
// genau diese Datei?" — unabhängig vom RFC3161-Ergebnis. RFC3161 allein belegt "diese Datei ist seit dem Stempeln unverändert", aber nicht
// "dies ist die Datei, die zu diesem Vorgang gehört": Der pdf_pfad eines Vorgangs könnte gegen ein anderes, separat gültiges, gestempeltes PDF
// ausgetauscht werden, ohne dass RFC3161 allein es bemerkt. dateiHash wird immer berechnet, ob ein Zeitstempel vorhanden ist oder nicht, da
// der Hash-Vergleich eine eigenständige Aussage über die Bytes ist und kein Teilschritt der RFC3161-Prüfung.
// @returns {Promise<{vorhanden: boolean, gueltig: boolean, zeitpunkt: string|null, tsaPolicy: string|null, dateiHash: string, hashUebereinstimmung: boolean|null, ...}>}
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
