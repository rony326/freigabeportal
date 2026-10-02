import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// crossSigned: die Antwort enthaelt (wie bei DigiCert) statt der selbstsignierten Root eine von einer
// aelteren Root quersignierte Kopie mit identischem Namen und Schluessel.
export function createChainedTsa(t, { crossSigned = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'portal-chain-tsa-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = (name) => join(dir, name);
  const openssl = (...args) => execFileSync('openssl', args, { stdio: 'pipe', timeout: 10000 });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Portal Test Root',
    '-addext', 'basicConstraints=critical,CA:true,pathlen:1', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', path('root.key'), '-out', path('root.pem'));
  for (const [name, parent, extensions] of [
    ['intermediate', 'root', 'basicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\ncrlDistributionPoints=URI:http://crl.example.org/root.crl'],
    ['signer', 'intermediate', 'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\ncrlDistributionPoints=URI:http://crl.example.org/intermediate.crl'],
  ]) {
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=Portal Test ${name}`, '-keyout', path(`${name}.key`), '-out', path(`${name}.csr`));
    writeFileSync(path(`${name}.ext`), extensions);
    openssl('x509', '-req', '-in', path(`${name}.csr`), '-CA', path(`${parent}.pem`), '-CAkey', path(`${parent}.key`), '-CAcreateserial',
      '-days', '2', '-sha256', '-extfile', path(`${name}.ext`), '-out', path(`${name}.pem`));
  }
  let rootInResponse = path('root.pem');
  if (crossSigned) {
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Portal Test Old Root',
      '-addext', 'basicConstraints=critical,CA:true', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout', path('oldroot.key'), '-out', path('oldroot.pem'));
    openssl('x509', '-x509toreq', '-in', path('root.pem'), '-signkey', path('root.key'), '-out', path('root.cross.csr'));
    writeFileSync(path('root.cross.ext'), 'basicConstraints=critical,CA:true,pathlen:1\nkeyUsage=critical,keyCertSign,cRLSign\ncrlDistributionPoints=URI:http://crl.example.org/oldroot.crl');
    openssl('x509', '-req', '-in', path('root.cross.csr'), '-CA', path('oldroot.pem'), '-CAkey', path('oldroot.key'), '-CAcreateserial',
      '-days', '2', '-sha256', '-extfile', path('root.cross.ext'), '-out', path('root.cross.pem'));
    rootInResponse = path('root.cross.pem');
  }
  writeFileSync(path('chain.pem'), Buffer.concat([readFileSync(path('intermediate.pem')), readFileSync(rootInResponse)]));
  writeFileSync(path('serial'), '01');
  writeFileSync(path('tsa.cnf'), `[tsa]\ndefault_tsa=signer\n[signer]\nserial=${path('serial')}\nsigner_cert=${path('signer.pem')}\nsigner_key=${path('signer.key')}\ncerts=${path('chain.pem')}\nsigner_digest=sha256\ndefault_policy=1.2.3.4.1\ndigests=sha256\naccuracy=secs:1\nordering=yes\ntsa_name=yes\ness_cert_id_chain=no\ness_cert_id_alg=sha256\n`);
  // idp(issuer) liefert optional den Inhalt einer kritischen IssuingDistributionPoint-Sektion (OpenSSL-Syntax).
  function writeCrlBundle({ revoke = [], digest = 'sha256', dates = [], idp = null } = {}) {
    for (const [issuer, child] of [['root', 'intermediate'], ['intermediate', 'signer']]) {
      writeFileSync(path(`${issuer}.index`), '');
      writeFileSync(path(`${issuer}.crlnumber`), '01');
      const idpConfig = idp ? `crl_extensions=crl_ext\n[crl_ext]\nissuingDistributionPoint=critical,@idp\n[idp]\n${idp(issuer)}\n` : '';
      writeFileSync(path(`${issuer}.ca.cnf`), `[ca]\ndefault_ca=issuer\n[issuer]\ndatabase=${path(`${issuer}.index`)}\nprivate_key=${path(`${issuer}.key`)}\ncertificate=${path(`${issuer}.pem`)}\ncrlnumber=${path(`${issuer}.crlnumber`)}\ndefault_md=${digest}\ndefault_crl_days=1\n${idpConfig}`);
      if (revoke.includes(child)) openssl('ca', '-config', path(`${issuer}.ca.cnf`), '-revoke', path(`${child}.pem`));
      openssl('ca', '-gencrl', '-config', path(`${issuer}.ca.cnf`), ...dates, '-out', path(`${issuer}.crl.pem`));
    }
    writeFileSync(path('crls.pem'), Buffer.concat([readFileSync(path('root.crl.pem')), readFileSync(path('intermediate.crl.pem'))]));
    return path('crls.pem');
  }
  const crlFile = writeCrlBundle();
  return {
    dir, crlFile, writeCrlBundle, rootFile: path('root.pem'), leafFile: path('signer.pem'),
    rootSha256: createHash('sha256').update(readFileSync(path('root.pem'))).digest('hex'),
    reply({ body }) {
      writeFileSync(path('request.der'), Buffer.from(body));
      openssl('ts', '-reply', '-config', path('tsa.cnf'), '-queryfile', path('request.der'), '-out', path('response.der'));
      return readFileSync(path('response.der'));
    },
  };
}
