import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';
import { Certificate, Extension, Extensions } from 'pkijs';
import { createChainedTsa } from '../helpers/chainedTsa.js';
import { loadTsaCrls, verifyTsaRevocation } from '../../src/services/tsaRevocation.js';
import { setZeitstempel } from '../../src/services/zeitstempel.js';
import { setupMockTsa } from '../helpers/mockTsa.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

function chain(tsa) {
  return ['signer', 'intermediate', 'root'].map((name) => {
    const cert = new X509Certificate(readFileSync(join(tsa.dir, `${name}.pem`)));
    return new Certificate({ schema: asn1js.fromBER(Uint8Array.from(cert.raw).buffer).result });
  });
}

test('CRL loader rejects missing, non-PEM, trailing DER, oversized and symlink files', (t) => {
  const tsa = createChainedTsa(t);
  assert.equal(loadTsaCrls(tsa.crlFile).length, 2);
  assert.throws(() => loadTsaCrls(), /konfiguriert/);
  const file = join(tsa.dir, 'bad-crls.pem');
  for (const bytes of ['', 'no PEM', Buffer.alloc(16 * 1024 * 1024 + 1), readFileSync(tsa.crlFile, 'utf8').repeat(9)]) {
    writeFileSync(file, bytes);
    assert.throws(() => loadTsaCrls(file));
  }
  const der = loadTsaCrls(tsa.crlFile)[0].toSchema().toBER(false);
  writeFileSync(file, `-----BEGIN X509 CRL-----\n${Buffer.concat([Buffer.from(der), Buffer.from([0])]).toString('base64')}\n-----END X509 CRL-----`);
  assert.throws(() => loadTsaCrls(file), /Ungueltige/);
  const link = join(tsa.dir, 'crl-link.pem');
  symlinkSync(tsa.crlFile, link);
  assert.throws(() => loadTsaCrls(link));
});

test('every non-root certificate needs a current issuer-signed CRL', async (t) => {
  const tsa = createChainedTsa(t);
  const certificates = chain(tsa);
  const crls = loadTsaCrls(tsa.crlFile);
  assert.equal((await verifyTsaRevocation(certificates, crls)).sperrstatus, 'crl_geprueft');
  await assert.rejects(() => verifyTsaRevocation(certificates, []), /fehlen/);
  for (const crl of crls) await assert.rejects(() => verifyTsaRevocation(certificates, [crl]), /fehlt/);
  await assert.rejects(() => verifyTsaRevocation(certificates, crls, new Date('2000-01-01')), /nicht aktuell/);
  await assert.rejects(() => verifyTsaRevocation(certificates, crls, new Date('2100-01-01')), /nicht aktuell/);
  await assert.rejects(() => verifyTsaRevocation(certificates, crls, crls[0].nextUpdate.value), /nicht aktuell/);
  delete crls[0].nextUpdate;
  await assert.rejects(() => verifyTsaRevocation(certificates, crls), /nextUpdate/);
});

for (const child of ['signer', 'intermediate']) {
  test(`authenticated revocation of ${child} blocks new timestamps`, async (t) => {
    const tsa = createChainedTsa(t);
    tsa.writeCrlBundle({ revoke: [child] });
    await assert.rejects(() => verifyTsaRevocation(chain(tsa), loadTsaCrls(tsa.crlFile)), /gesperrt/);
    const pool = setupMockTsa('https://tsa.example.org/tsr');
    pool.intercept({ path: '/tsr', method: 'POST' }).reply(200, tsa.reply);
    await assert.rejects(async () => setZeitstempel(await buildPdfFixture(['revoked']), {
      url: 'https://tsa.example.org/tsr', trustAnchorsFile: tsa.rootFile,
      trustAnchorsSha256: tsa.rootSha256, crlFile: tsa.crlFile,
    }), /gesperrt/);
  });
}

test('invalid signatures, wrong same-name issuer keys and weak algorithms are rejected', async (t) => {
  const tsa = createChainedTsa(t);
  const other = createChainedTsa(t);
  await assert.rejects(() => verifyTsaRevocation(chain(tsa), loadTsaCrls(other.crlFile)), /Signatur/);
  const crls = loadTsaCrls(tsa.crlFile);
  crls[0].signatureValue.valueBlock.valueHexView[0] ^= 1;
  await assert.rejects(() => verifyTsaRevocation(chain(tsa), crls), /Signatur/);
  tsa.writeCrlBundle({ digest: 'sha1' });
  await assert.rejects(() => verifyTsaRevocation(chain(tsa), loadTsaCrls(tsa.crlFile)), /Signaturalgorithmus/);
});

test('correctly signed but expired or future CRLs are not accepted as current evidence', async (t) => {
  const tsa = createChainedTsa(t);
  for (const [start, end] of [['20000101000000Z', '20000102000000Z'], ['20990101000000Z', '20990102000000Z']]) {
    tsa.writeCrlBundle({ dates: ['-crl_lastupdate', start, '-crl_nextupdate', end] });
    await assert.rejects(() => verifyTsaRevocation(chain(tsa), loadTsaCrls(tsa.crlFile)), /nicht aktuell/);
  }
});

test('unsupported scopes, deltas, critical extensions and duplicate extensions fail closed', async (t) => {
  const tsa = createChainedTsa(t);
  for (const [oid, critical] of [['2.5.29.27', false], ['2.5.29.28', false], ['2.5.29.46', false], ['1.2.3.4', true]]) {
    const crls = loadTsaCrls(tsa.crlFile);
    crls[0].crlExtensions.extensions.push(new Extension({ extnID: oid, critical }));
    await assert.rejects(() => verifyTsaRevocation(chain(tsa), crls), /Erweiterung/);
  }
  const crls = loadTsaCrls(tsa.crlFile);
  crls[0].crlExtensions.extensions.push(crls[0].crlExtensions.extensions[0]);
  await assert.rejects(() => verifyTsaRevocation(chain(tsa), crls), /Erweiterung/);
  tsa.writeCrlBundle({ revoke: ['intermediate'] });
  const indirect = loadTsaCrls(tsa.crlFile);
  indirect[0].revokedCertificates[0].crlEntryExtensions = new Extensions({ extensions: [new Extension({ extnID: '2.5.29.29' })] });
  await assert.rejects(() => verifyTsaRevocation(chain(tsa), indirect), /Erweiterung/);
});

test('issuer without cRLSign is rejected and missing CRL configuration blocks before sending', async (t) => {
  const tsa = createChainedTsa(t);
  const certificates = chain(tsa);
  certificates[1].extensions.find((extension) => extension.extnID === '2.5.29.15').parsedValue.valueBlock.valueHexView[0] &= ~0x02;
  await assert.rejects(() => verifyTsaRevocation(certificates, loadTsaCrls(tsa.crlFile)), /cRLSign/);
  await assert.rejects(() => setZeitstempel(Buffer.from('not a PDF'), {
    url: 'https://tsa.example.org/tsr', trustAnchorsFile: tsa.rootFile, trustAnchorsSha256: tsa.rootSha256,
  }), /Sperrlisten muessen konfiguriert/);
});

test('CRLs with a critical IssuingDistributionPoint naming the certificate distribution point are accepted', async (t) => {
  // Profil wie bei DigiCert: IDP nur mit fullName-URI, die zum CRL-Verteilpunkt des Zertifikats passt.
  const tsa = createChainedTsa(t);
  tsa.writeCrlBundle({ idp: (issuer) => `fullname=URI:http://crl.example.org/${issuer}.crl` });
  assert.equal((await verifyTsaRevocation(chain(tsa), loadTsaCrls(tsa.crlFile))).sperrstatus, 'crl_geprueft');
  tsa.writeCrlBundle({ revoke: ['signer'], idp: (issuer) => `fullname=URI:http://crl.example.org/${issuer}.crl` });
  await assert.rejects(() => verifyTsaRevocation(chain(tsa), loadTsaCrls(tsa.crlFile)), /gesperrt/);
});

for (const [label, idp] of [
  ['a foreign distribution point', () => 'fullname=URI:http://crl.example.org/other.crl'],
  ['onlyContainsUserCerts', (issuer) => `fullname=URI:http://crl.example.org/${issuer}.crl\nonlyuser=TRUE`],
  ['onlyContainsCACerts', (issuer) => `fullname=URI:http://crl.example.org/${issuer}.crl\nonlyCA=TRUE`],
  ['onlySomeReasons', (issuer) => `fullname=URI:http://crl.example.org/${issuer}.crl\nonlysomereasons=keyCompromise`],
  ['indirectCRL', (issuer) => `fullname=URI:http://crl.example.org/${issuer}.crl\nindirectCRL=TRUE`],
  ['no distribution point name', () => 'onlyAA=FALSE'],
]) {
  test(`IssuingDistributionPoint with ${label} is rejected`, async (t) => {
    const tsa = createChainedTsa(t);
    tsa.writeCrlBundle({ idp });
    await assert.rejects(() => verifyTsaRevocation(chain(tsa), loadTsaCrls(tsa.crlFile)), /Erweiterung|Verteilpunkt/);
  });
}
