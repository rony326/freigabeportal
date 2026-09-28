import { openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import * as asn1js from 'asn1js';
import { CertificateRevocationList } from 'pkijs';

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
  return blocks.map((block) => {
    const der = Buffer.from(block[1], 'base64');
    const parsed = asn1js.fromBER(Uint8Array.from(der).buffer);
    if (parsed.offset !== der.length) throw new Error('Ungueltige TSA-Sperrliste.');
    return new CertificateRevocationList({ schema: parsed.result });
  });
}

function checkExtensions(extensions = [], entry = false) {
  const seen = new Set();
  for (const extension of extensions) {
    // Delta, scoped and indirect CRLs need different processing and cannot prove full coverage here.
    if (seen.has(extension.extnID) || extension.critical ||
        (entry ? extension.extnID === '2.5.29.29' : ['2.5.29.27', '2.5.29.28', '2.5.29.46'].includes(extension.extnID))) {
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
      checkExtensions(crl.crlExtensions?.extensions);
      for (const entry of crl.revokedCertificates || []) checkExtensions(entry.crlEntryExtensions?.extensions, true);
      if (!signatureAlgorithms.has(crl.signatureAlgorithm.algorithmId) ||
          !Buffer.from(crl.signature.toSchema().toBER(false)).equals(Buffer.from(crl.signatureAlgorithm.toSchema().toBER(false)))) {
        throw new Error('Nicht unterstuetzter TSA-Sperrlisten-Signaturalgorithmus.');
      }
      if (!await crl.verify({ issuerCertificate: issuer })) throw new Error('TSA-Sperrlisten-Signatur ist ungueltig.');
      if (crl.isCertificateRevoked(certificate)) throw new Error('TSA-Zertifikat ist gesperrt.');
    }
  }
  return { sperrstatus: 'crl_geprueft' };
}
