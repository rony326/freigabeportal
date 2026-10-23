import { createHash } from 'node:crypto';
import { createTimestampRequest, sendTimestampRequest, parseTimestampResponse } from 'pdf-rfc3161';
import { freshTimestampRequest, validateTimestampBinding, leseTimestampToken } from './tsaResponse.js';
import { loadTsaTrustAnchors, verifyTsaChain, tsaTrustOptions } from './tsaTrust.js';
import { loadTsaCrls } from './tsaRevocation.js';
import { baueTsaNachweis } from './tsaNachweis.js';
import { buildTsaHeaders } from './zeitstempel.js';
import { getConfigValue } from '../db/adminConfigRepo.js';

// RFC3161-Bestaetigung einer Audit-Pruefnummer (audit_export_pakete.paket_sha256).
// MessageImprint = SHA-256 ueber die UTF-8-Bytes der 64 Hex-Zeichen, damit jede Pruefstelle den
// Imprint ohne Kenntnis der Paketinhalte nachrechnen kann.

// Laeuft im Hintergrund-Job, darf daher grosszuegiger warten als der Freigabe-Request.
const TSA_TIMING = { timeout: 15000, retry: 2, retryDelay: 1000 };
const SHA256_OID = '2.16.840.1.101.3.4.2.1';

const imprint = (paketSha256) => createHash('sha256').update(Buffer.from(paketSha256, 'utf8')).digest();

// Gleicher Aufbau wie in tsaCrlUpdate.js; null, solange keine TSA konfiguriert ist.
export function tsaConfigAusDb(db, config) {
  const url = getConfigValue(db, 'zeitstempel_tsa_url');
  if (!url) return null;
  return {
    ...tsaTrustOptions(config),
    url,
    user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
    passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
  };
}

// Wirft bei jedem Fehler (Netz, TSA-Ablehnung, Bindung, Kette) eine deutsche Meldung.
export async function stempleAuditPaket(paketSha256, tsaConfig) {
  try {
    const anchors = tsaConfig.trustAnchorsFile || tsaConfig.requireTrustedChain !== false
      ? loadTsaTrustAnchors(tsaConfig.trustAnchorsFile, tsaConfig.trustAnchorsSha256) : null;
    const crls = anchors ? loadTsaCrls(tsaConfig.crlFile) : [];
    // Eigene Kopie: pdf-rfc3161 hasht data.slice().buffer, bei einem Pool-Buffer also den ganzen Pool.
    const daten = Uint8Array.from(Buffer.from(paketSha256, 'utf8'));
    const request = freshTimestampRequest(await createTimestampRequest(daten, { hashAlgorithm: 'SHA-256' }));
    const response = parseTimestampResponse(await sendTimestampRequest(request, {
      url: tsaConfig.url, headers: buildTsaHeaders(tsaConfig), ...TSA_TIMING,
    }));
    if (![0, 1].includes(response.status) || !response.token) throw new Error('TSA hat keinen erfolgreichen Zeitstempel geliefert.');
    const binding = validateTimestampBinding(request, response.token);
    const kette = anchors ? await verifyTsaChain(binding, anchors, crls) : null;
    const nachweis = baueTsaNachweis({ binding, token: response.token, kette, trustAnchorsSha256: tsaConfig.trustAnchorsSha256 || null });
    return { token: Buffer.from(response.token), genTime: binding.info.genTime, nachweis };
  } catch (err) {
    throw new Error(`Zeitstempel fuer die Pruefnummer konnte nicht gesetzt werden: ${err.message}`);
  }
}

// Wirft nie: prueft Imprint und CMS-Signatur eines gespeicherten Tokens (ohne Vertrauenskette).
export async function pruefeAuditZeitstempelToken(token, paketSha256) {
  let genTime = null;
  try {
    const { signed, info } = leseTimestampToken(token);
    genTime = Number.isFinite(info.genTime?.getTime()) ? info.genTime : null;
    if (info.messageImprint.hashAlgorithm.algorithmId !== SHA256_OID ||
        !Buffer.from(info.messageImprint.hashedMessage.getValue()).equals(imprint(paketSha256))) {
      return { gueltig: false, genTime, fehler: 'Zeitstempel passt nicht zu dieser Pruefnummer.' };
    }
    // pkijs prueft bei TSTInfo den Imprint gegen data, daher die gestempelten Bytes statt eContent.
    const daten = Uint8Array.from(Buffer.from(paketSha256, 'utf8')).buffer;
    const ok = await signed.verify({ signer: 0, checkChain: false, data: daten });
    if (ok !== true) return { gueltig: false, genTime, fehler: 'TSA-Signatur des Zeitstempels ist ungueltig.' };
    return { gueltig: true, genTime, fehler: null };
  } catch (err) {
    return { gueltig: false, genTime, fehler: `Zeitstempel ist ungueltig: ${err?.message || err}` };
  }
}
