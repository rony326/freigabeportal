import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as asn1js from 'asn1js';
import { ContentInfo, SignedData, TSTInfo, ExtKeyUsage, IssuerSerial, GeneralNames, GeneralName, AlgorithmIdentifier } from 'pkijs';
import { createHash } from 'node:crypto';
import { TimestampSession, parseTimestampResponse } from 'pdf-rfc3161';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { signedTsaResponse } from '../helpers/mockTsa.js';
import { freshTimestampRequest, validateTimestampCertificate, validateTimestampBinding } from '../../src/services/tsaResponse.js';

let fixture;
async function validResponse() {
  fixture ??= (async () => {
    const session = new TimestampSession(await buildPdfFixture(['TSA certificate tests']), { enableLTV: false });
    try {
      const request = freshTimestampRequest(await session.createTimestampRequest());
      const response = parseTimestampResponse(Uint8Array.from(signedTsaResponse({ body: request })));
      return { request, token: response.token };
    } finally { session.dispose(); }
  })();
  const { request, token } = await fixture;
  const content = new ContentInfo({ schema: asn1js.fromBER(Uint8Array.from(token).buffer).result });
  const signed = new SignedData({ schema: content.content });
  const info = new TSTInfo({ schema: asn1js.fromBER(signed.encapContentInfo.eContent.getValue()).result });
  return { request, token, signed, info };
}

test('valid test TSA certificate matches ESS and its timestamp-only EKU', async () => {
  const { request, token, signed, info } = await validResponse();
  assert.doesNotThrow(() => validateTimestampBinding(request, token));
  assert.doesNotThrow(() => validateTimestampCertificate(signed, info.genTime));
});

for (const attack of ['weak-signature-digest', 'missing-certificate', 'ambiguous-certificate', 'missing-eku', 'noncritical-eku', 'mixed-eku', 'duplicate-eku', 'expired-now', 'invalid-at-timestamp', 'missing-ess', 'duplicate-ess', 'multiple-ess-values', 'wrong-ess-hash', 'wrong-ess-issuer']) {
  test(`certificate validation rejects ${attack}`, async () => {
    const { signed, info } = await validResponse();
    const cert = signed.certificates[0];
    const eku = cert.extensions.find((entry) => entry.extnID === '2.5.29.37');
    const attrs = signed.signerInfos[0].signedAttrs.attributes;
    const ess = attrs.find((entry) => entry.type === '1.2.840.113549.1.9.16.2.47');
    let time = info.genTime;
    let now = new Date();
    if (attack === 'weak-signature-digest') signed.signerInfos[0].digestAlgorithm.algorithmId = '1.3.14.3.2.26';
    if (attack === 'missing-certificate') signed.certificates = [];
    if (attack === 'ambiguous-certificate') signed.certificates.push(cert);
    if (attack === 'missing-eku') cert.extensions = cert.extensions.filter((entry) => entry !== eku);
    if (attack === 'noncritical-eku') eku.critical = false;
    if (attack === 'duplicate-eku') cert.extensions.push(eku);
    if (attack === 'mixed-eku') eku.extnValue = new asn1js.OctetString({ valueHex: new ExtKeyUsage({ keyPurposes: ['1.3.6.1.5.5.7.3.8', '1.3.6.1.5.5.7.3.2'] }).toSchema().toBER(false) });
    if (attack === 'expired-now') now = new Date(cert.notAfter.value.getTime() + 1000);
    if (attack === 'invalid-at-timestamp') time = new Date(cert.notBefore.value.getTime() - 1000);
    if (attack === 'missing-ess') signed.signerInfos[0].signedAttrs.attributes = attrs.filter((entry) => entry !== ess);
    if (attack === 'duplicate-ess') attrs.push(ess);
    if (attack === 'multiple-ess-values') ess.values.push(ess.values[0]);
    if (attack === 'wrong-ess-hash') {
      const fields = ess.values[0].valueBlock.value[0].valueBlock.value[0].valueBlock.value;
      fields.find((field) => field instanceof asn1js.OctetString).valueBlock.valueHexView[0] ^= 1;
    }
    if (attack === 'wrong-ess-issuer') {
      const fields = ess.values[0].valueBlock.value[0].valueBlock.value[0].valueBlock.value;
      fields.push(new IssuerSerial({
        issuer: new GeneralNames({ names: [new GeneralName({ type: 4, value: cert.issuer })] }),
        serialNumber: new asn1js.Integer({ value: 42 }),
      }).toSchema());
    }
    assert.throws(() => validateTimestampCertificate(signed, time, now), /TSA|Zertifikat|ESS/);
  });
}

for (const hash of ['sha1', 'sha256', 'sha384', 'sha512']) {
  test(`ESS certificate binding accepts ${hash} with the correct issuer and serial`, async () => {
    const { signed, info } = await validResponse();
    const cert = signed.certificates[0];
    const attribute = signed.signerInfos[0].signedAttrs.attributes.find((entry) => entry.type === '1.2.840.113549.1.9.16.2.47');
    const oid = { sha256: '2.16.840.1.101.3.4.2.1', sha384: '2.16.840.1.101.3.4.2.2', sha512: '2.16.840.1.101.3.4.2.3' }[hash];
    if (hash === 'sha1') attribute.type = '1.2.840.113549.1.9.16.2.12';
    const fields = [];
    if (oid) fields.push(new AlgorithmIdentifier({ algorithmId: oid }).toSchema());
    fields.push(new asn1js.OctetString({ valueHex: Uint8Array.from(createHash(hash).update(Buffer.from(cert.toSchema().toBER(false))).digest()).buffer }));
    fields.push(new IssuerSerial({ issuer: new GeneralNames({ names: [new GeneralName({ type: 4, value: cert.issuer })] }), serialNumber: cert.serialNumber }).toSchema());
    attribute.values = [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: fields })] })] })];
    assert.doesNotThrow(() => validateTimestampCertificate(signed, info.genTime));
  });
}
