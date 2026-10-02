import { openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import * as asn1js from 'asn1js';
import { CertificateRevocationList } from 'pkijs';

// Original-DER jeder geladenen Sperrliste, damit die tatsaechlich verwendete Evidenz byte-genau
// aufbewahrt werden kann (services/tsaNachweis.js), ohne die Rueckgabeform von loadTsaCrls zu aendern.
const CRL_DER = new WeakMap();
export function crlDer(crl) {
  return CRL_DER.get(crl) || Buffer.from(crl.toSchema().toBER(false));
}

const signatureAlgorithms = new Set([
  '1.2.840.113549.1.1.11', '1.2.840.113549.1.1.12', '1.2.840.113549.1.1.13',
  '1.2.840.10045.4.3.2', '1.2.840.10045.4.3.3', '1.2.840.10045.4.3.4',
]);

export function loadTsaCrls(path) {
  if (!path) throw new Error('TSA-Sperrlisten muessen konfiguriert sein.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Ungueltige TSA-Sperrlistendatei.');
    bytes = readFileSync(fd);
  } finally { closeSync(fd); }
  const pem = bytes.toString('ascii');
  const pattern = /-----BEGIN X509 CRL-----([A-Za-z0-9+/=\r\n]+)-----END X509 CRL-----/g;
  const blocks = [...pem.matchAll(pattern)];
  if (!blocks.length || blocks.length > 16 || pem.replace(pattern, '').trim()) {
    throw new Error('TSA-Sperrlistendatei muss ausschliesslich PEM-Sperrlisten enthalten.');
  }
  return blocks.map((block) => parseTsaCrl(Buffer.from(block[1], 'base64')));
}

export function parseTsaCrl(der) {
  const parsed = asn1js.fromBER(Uint8Array.from(der).buffer);
  if (parsed.offset === -1 || parsed.offset !== der.length) throw new Error('Ungueltige TSA-Sperrliste.');
  const crl = new CertificateRevocationList({ schema: parsed.result });
  CRL_DER.set(crl, Buffer.from(der));
  return crl;
}

export function crlZuPem(crl) {
  const zeilen = crlDer(crl).toString('base64').match(/.{1,64}/g);
  return `-----BEGIN X509 CRL-----\n${zeilen.join('\n')}\n-----END X509 CRL-----\n`;
}

const ISSUING_DISTRIBUTION_POINT = '2.5.29.28';
const uris = (names) => (Array.isArray(names) ? names : []).filter((name) => name.type === 6).map((name) => name.value);

// Einzig unterstuetzte IDP-Form (z.B. DigiCert): nur fullName-URIs, ohne Einschraenkung auf Zertifikatsarten,
// Gruende oder indirekte Eintraege. Nach RFC 5280 6.3.3 (b)(2)(i) muss eine URI zu einem
// uneingeschraenkten CRL-Verteilpunkt des geprueften Zertifikats passen; sonst deckt die Liste es nicht ab.
function checkIssuingDistributionPoint(idp, certificate) {
  if (!idp || idp.onlyContainsUserCerts || idp.onlyContainsCACerts || idp.onlyContainsAttributeCerts ||
      idp.indirectCRL || idp.onlySomeReasons !== undefined || !uris(idp.distributionPoint).length) {
    throw new Error('Nicht unterstuetzte TSA-Sperrlisten-Erweiterung.');
  }
  const cdp = certificate.extensions?.find((extension) => extension.extnID === '2.5.29.31')?.parsedValue;
  const certUris = (cdp?.distributionPoints || [])
    .filter((point) => point.reasons === undefined && point.cRLIssuer === undefined)
    .flatMap((point) => uris(point.distributionPoint));
  if (!uris(idp.distributionPoint).some((uri) => certUris.includes(uri))) {
    throw new Error('TSA-Sperrliste passt nicht zum Verteilpunkt des Zertifikats.');
  }
}

function checkExtensions(extensions = [], entry = false, certificate = null) {
  const seen = new Set();
  for (const extension of extensions) {
    if (!entry && extension.extnID === ISSUING_DISTRIBUTION_POINT && !seen.has(extension.extnID)) {
      checkIssuingDistributionPoint(extension.parsedValue, certificate);
      seen.add(extension.extnID);
      continue;
    }
    // Delta, scoped and indirect CRLs need different processing and cannot prove full coverage here.
    if (seen.has(extension.extnID) || extension.critical ||
        (entry ? extension.extnID === '2.5.29.29' : ['2.5.29.27', '2.5.29.46'].includes(extension.extnID))) {
      throw new Error('Nicht unterstuetzte TSA-Sperrlisten-Erweiterung.');
    }
    seen.add(extension.extnID);
  }
}

// The caller supplies a validated leaf-first chain, including the locally trusted root.
export async function verifyTsaRevocation(chain, crls, now = new Date()) {
  if (chain.length < 2 || !crls.length || crls.length > 16 || !Number.isFinite(now.getTime())) {
    throw new Error('TSA-Sperrlisten fuer die Zertifikatskette fehlen.');
  }
  const verwendet = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const certificate = chain[i];
    const issuer = chain[i + 1];
    const keyUsage = issuer.extensions?.filter((extension) => extension.extnID === '2.5.29.15') || [];
    if (keyUsage.length !== 1 || !(keyUsage[0].parsedValue?.valueBlock.valueHexView[0] & 0x02)) {
      throw new Error('TSA-Sperrlisten-Aussteller hat keine cRLSign-Berechtigung.');
    }
    const matching = crls.filter((crl) => crl.issuer.isEqual(issuer.subject));
    if (!matching.length) throw new Error('TSA-Sperrliste fuer einen Zertifikatsaussteller fehlt.');
    for (const crl of matching) {
      const start = crl.thisUpdate.value.getTime();
      const end = crl.nextUpdate?.value.getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > now.getTime() || end <= now.getTime() || end <= start) {
        throw new Error('TSA-Sperrliste ist nicht aktuell oder hat kein gueltiges nextUpdate.');
      }
      checkExtensions(crl.crlExtensions?.extensions, false, certificate);
      for (const entry of crl.revokedCertificates || []) checkExtensions(entry.crlEntryExtensions?.extensions, true);
      if (!signatureAlgorithms.has(crl.signatureAlgorithm.algorithmId) ||
          !Buffer.from(crl.signature.toSchema().toBER(false)).equals(Buffer.from(crl.signatureAlgorithm.toSchema().toBER(false)))) {
        throw new Error('Nicht unterstuetzter TSA-Sperrlisten-Signaturalgorithmus.');
      }
      if (!await crl.verify({ issuerCertificate: issuer })) throw new Error('TSA-Sperrlisten-Signatur ist ungueltig.');
      if (crl.isCertificateRevoked(certificate)) throw Object.assign(new Error('TSA-Zertifikat ist gesperrt.'), { code: 'TSA_GESPERRT' });
      if (!verwendet.includes(crl)) verwendet.push(crl);
    }
  }
  return { sperrstatus: 'crl_geprueft', sperrlisten: verwendet };
}
