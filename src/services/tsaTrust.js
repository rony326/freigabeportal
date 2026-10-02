import { openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';
import { Certificate, CertificateChainValidationEngine } from 'pkijs';
import { verifyTsaRevocation } from './tsaRevocation.js';

const fingerprint = (cert) => createHash('sha256').update(Buffer.from(cert.toSchema().toBER(false))).digest('hex');

export function tsaTrustOptions(config = {}) {
  return {
    trustAnchorsFile: config.tsaTrustAnchorsFile,
    trustAnchorsSha256: config.tsaTrustAnchorsSha256,
    crlFile: config.tsaCrlFile,
    requireTrustedChain: config.tsaTrustRequired !== false,
  };
}

export function loadTsaTrustAnchors(path, expectedHash) {
  if (!path || !/^[a-f0-9]{64}$/.test(expectedHash || '')) throw new Error('TSA-Vertrauensanker und deren SHA-256 muessen konfiguriert sein.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Ungueltige TSA-Vertrauensankerdatei.');
    bytes = readFileSync(fd);
  } finally { closeSync(fd); }
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('SHA-256 der TSA-Vertrauensankerdatei stimmt nicht.');
  const pem = bytes.toString('utf8');
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  if (!blocks.length || blocks.length > 16 || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) {
    throw new Error('TSA-Vertrauensankerdatei muss ausschliesslich PEM-Zertifikate enthalten.');
  }
  const seen = new Set();
  return blocks.map((block) => {
    const cert = new X509Certificate(block);
    if (!cert.ca || !cert.checkIssued(cert) || !cert.verify(cert.publicKey) || seen.has(cert.fingerprint256)) {
      throw new Error('TSA-Vertrauensanker muss ein eindeutiges selbstsigniertes CA-Zertifikat sein.');
    }
    seen.add(cert.fingerprint256);
    return new Certificate({ schema: asn1js.fromBER(Uint8Array.from(cert.raw).buffer).result });
  });
}

// Validiert den Pfad vom tatsaechlichen Unterzeichner zu einem lokalen Anker zum Zeitstempel- und
// zum Empfangszeitpunkt, ohne Sperrpruefung. Liefert die Kette (Signer zuerst, Anker zuletzt).
export async function validateTsaPath({ signed, info, signer }, anchors) {
  const certificates = (signed.certificates || []).filter((cert) => cert instanceof Certificate);
  if (!anchors.length || certificates.length > 12) throw new Error('TSA-Zertifikatskette fehlt oder ist zu gross.');
  const signerHash = fingerprint(signer);
  // Antwortzertifikate mit Name und Schluessel eines lokalen Ankers (z.B. DigiCerts quersignierte
  // "Trusted Root G4") ersetzt der Anker selbst; PKI.js wuerde sonst ihnen statt dem Anker folgen.
  const spki = (cert) => Buffer.from(cert.subjectPublicKeyInfo.toSchema().toBER(false));
  const isAnchorCopy = (cert) => anchors.some((anchor) => anchor.subject.isEqual(cert.subject) && spki(anchor).equals(spki(cert)));
  // PKI.js takes the last untrusted certificate as the leaf. Bind the result to the actual signer.
  const ordered = [...certificates.filter((cert) => fingerprint(cert) !== signerHash && !isAnchorCopy(cert)), signer];
  const roots = new Set(anchors.map(fingerprint));
  let chain;
  for (const checkDate of [info.genTime, new Date()]) {
    const engine = new CertificateChainValidationEngine({ trustedCerts: anchors, certs: ordered, checkDate });
    const result = await engine.verify({ passedWhenNotRevValues: true });
    chain = result.certificatePath || [];
    if (!result.result || !chain.length || fingerprint(chain[0]) !== signerHash || !roots.has(fingerprint(chain.at(-1)))) {
      throw new Error('TSA-Signierzertifikat hat keine gueltige Kette zu den konfigurierten Vertrauensankern.');
    }
  }
  return { chain, signerHash };
}

export async function verifyTsaChain(binding, anchors, crls = []) {
  const { chain, signerHash } = await validateTsaPath(binding, anchors);
  const now = new Date();
  const sperre = await verifyTsaRevocation(chain, crls, now);
  // Die Evidenz belegt den Sperrstatus zum lokalen Pruefzeitpunkt, keine historische Validierung.
  return {
    kette: 'geprueft', sperrstatus: 'crl_geprueft', signerSha256: signerHash, pruefzeitpunkt: now,
    kettenzertifikate: chain, sperrlisten: sperre.sperrlisten,
  };
}
