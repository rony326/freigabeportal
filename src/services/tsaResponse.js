import * as asn1js from 'asn1js';
import { ContentInfo, SignedData, TSTInfo, TimeStampReq, Certificate, IssuerAndSerialNumber, IssuerSerial, AlgorithmIdentifier, ExtKeyUsage } from 'pkijs';
import { randomBytes, createHash } from 'node:crypto';

const ESS_V1 = '1.2.840.113549.1.9.16.2.12';
const ESS_V2 = '1.2.840.113549.1.9.16.2.47';
const HASHES = { '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512' };

function schema(bytes) {
  const parsed = asn1js.fromBER(Uint8Array.from(bytes).buffer);
  if (parsed.offset !== bytes.length) throw new Error('Ungueltige ASN.1-Daten der TSA.');
  return parsed.result;
}

function sequence(value) {
  if (!(value instanceof asn1js.Sequence)) throw new Error('Ungueltige ESS-Zertifikatsbindung.');
  return value.valueBlock.value;
}

export function validateTimestampCertificate(signed, genTime, now = new Date()) {
  const signer = signed.signerInfos[0];
  if (!HASHES[signer?.digestAlgorithm.algorithmId]) throw new Error('Nicht unterstuetzter TSA-Signatur-Hashalgorithmus.');
  // Restrict to the issuer/serial identifier used by our supported TSA profile.
  if (!(signer?.sid instanceof IssuerAndSerialNumber)) throw new Error('Nicht unterstuetzte TSA-Unterzeichnerkennung.');
  const candidates = (signed.certificates || []).filter((cert) => cert instanceof Certificate &&
    cert.issuer.isEqual(signer.sid.issuer) && cert.serialNumber.isEqual(signer.sid.serialNumber));
  if (candidates.length !== 1) throw new Error('TSA-Signierzertifikat fehlt oder ist nicht eindeutig.');
  const cert = candidates[0];
  const from = cert.notBefore.value.getTime();
  const until = cert.notAfter.value.getTime();
  if (![from, until, genTime.getTime(), now.getTime()].every(Number.isFinite) ||
      from > genTime.getTime() || until < genTime.getTime() || from > now.getTime() || until < now.getTime()) {
    throw new Error('TSA-Signierzertifikat ist zum Zeitstempel- oder Empfangszeitpunkt nicht gueltig.');
  }
  const eku = (cert.extensions || []).filter((extension) => extension.extnID === '2.5.29.37');
  if (eku.length !== 1 || !eku[0].critical) throw new Error('Kritischer TSA-Zertifikatszweck fehlt.');
  const purposes = new ExtKeyUsage({ schema: schema(new Uint8Array(eku[0].extnValue.getValue())) }).keyPurposes;
  if (purposes.length !== 1 || purposes[0] !== '1.3.6.1.5.5.7.3.8') throw new Error('Zertifikat ist nicht ausschliesslich fuer Zeitstempel bestimmt.');

  const attributes = signer.signedAttrs?.attributes || [];
  if (!attributes.some((attribute) => [ESS_V1, ESS_V2].includes(attribute.type))) throw new Error('ESS-Zertifikatsbindung fehlt.');
  for (const oid of [ESS_V1, ESS_V2]) {
    const matches = attributes.filter((attribute) => attribute.type === oid);
    if (!matches.length) continue;
    if (matches.length !== 1 || matches[0].values.length !== 1) throw new Error('Mehrdeutige ESS-Zertifikatsbindung.');
    const outer = sequence(matches[0].values[0]);
    if (outer.length < 1 || outer.length > 2 || (outer[1] && !(outer[1] instanceof asn1js.Sequence))) throw new Error('Ungueltige ESS-Zertifikatsbindung.');
    const ids = sequence(outer[0]);
    if (!ids.length) throw new Error('Leere ESS-Zertifikatsbindung.');
    const fields = [...sequence(ids[0])];
    let hash = oid === ESS_V1 ? 'sha1' : 'sha256';
    if (oid === ESS_V2 && fields[0] instanceof asn1js.Sequence) {
      hash = HASHES[new AlgorithmIdentifier({ schema: fields.shift() }).algorithmId];
    }
    if (!hash || fields.length < 1 || fields.length > 2 || !(fields[0] instanceof asn1js.OctetString)) throw new Error('Nicht unterstuetzte ESS-Zertifikatsbindung.');
    const expected = createHash(hash).update(Buffer.from(cert.toSchema().toBER(false))).digest();
    if (!expected.equals(Buffer.from(fields[0].getValue()))) throw new Error('ESS-Hash passt nicht zum TSA-Signierzertifikat.');
    if (fields[1]) {
      const issuer = new IssuerSerial({ schema: fields[1] });
      if (!issuer.serialNumber.isEqual(cert.serialNumber) ||
          !issuer.issuer.names.some((name) => name.type === 4 && cert.issuer.isEqual(name.value))) {
        throw new Error('ESS-Aussteller oder Seriennummer passt nicht zum TSA-Signierzertifikat.');
      }
    }
  }
  return cert;
}

export function freshTimestampRequest(bytes) {
  const request = new TimeStampReq({ schema: schema(bytes) });
  const nonce = Uint8Array.from(randomBytes(16));
  nonce[0] = (nonce[0] & 0x3f) | 0x40;
  request.nonce = new asn1js.Integer({ valueHex: nonce.buffer });
  return new Uint8Array(request.toSchema().toBER(false));
}

export function validateTimestampBinding(requestBytes, token) {
  const request = new TimeStampReq({ schema: schema(requestBytes) });
  const content = new ContentInfo({ schema: schema(token) });
  if (content.contentType !== '1.2.840.113549.1.7.2') throw new Error('TSA-Antwort ist kein SignedData-Token.');
  const signed = new SignedData({ schema: content.content });
  if (signed.encapContentInfo.eContentType !== '1.2.840.113549.1.9.16.1.4' || !signed.encapContentInfo.eContent) {
    throw new Error('TSA-Antwort enthaelt keine TSTInfo.');
  }
  const info = new TSTInfo({ schema: schema(new Uint8Array(signed.encapContentInfo.eContent.getValue())) });
  if (info.version !== 1 || signed.signerInfos.length !== 1 ||
      info.messageImprint.hashAlgorithm.algorithmId !== request.messageImprint.hashAlgorithm.algorithmId ||
      !Buffer.from(info.messageImprint.hashedMessage.getValue()).equals(Buffer.from(request.messageImprint.hashedMessage.getValue()))) {
    throw new Error('TSA-Antwort passt nicht zum angefragten Dokumenthash.');
  }
  if (!info.nonce || !info.nonce.isEqual(request.nonce)) throw new Error('TSA-Antwort passt nicht zur Nonce der Anfrage.');
  if (request.reqPolicy && request.reqPolicy !== info.policy) throw new Error('TSA-Policy stimmt nicht mit der Anfrage ueberein.');
  if (!Number.isFinite(info.genTime.getTime())) throw new Error('Ungueltiger TSA-Zeitpunkt.');
  const signer = validateTimestampCertificate(signed, info.genTime);
  return { signed, info, signer };
}
