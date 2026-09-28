import { MockAgent, setGlobalDispatcher } from 'undici';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let signerDir;

// Ephemeral test-only key material; the production app never trusts this certificate.
export function signedTsaResponse({ body }) {
  if (!signerDir) {
    signerDir = mkdtempSync(join(tmpdir(), 'portal-test-tsa-'));
    process.once('exit', () => rmSync(signerDir, { recursive: true, force: true }));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', '/CN=Portal Test TSA', '-addext', 'extendedKeyUsage=critical,timeStamping',
      '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'basicConstraints=critical,CA:false',
      '-keyout', join(signerDir, 'key.pem'), '-out', join(signerDir, 'cert.pem')], { stdio: 'pipe', timeout: 10000 });
    writeFileSync(join(signerDir, 'serial'), '01');
    writeFileSync(join(signerDir, 'tsa.cnf'), `[tsa]\ndefault_tsa=signer\n[signer]\nserial=${join(signerDir, 'serial')}\nsigner_cert=${join(signerDir, 'cert.pem')}\nsigner_key=${join(signerDir, 'key.pem')}\nsigner_digest=sha256\ndefault_policy=1.2.3.4.1\ndigests=sha256,sha384,sha512\naccuracy=secs:1\nordering=yes\ntsa_name=yes\ness_cert_id_chain=no\ness_cert_id_alg=sha256\n`);
  }
  const requestPath = join(signerDir, 'request.der');
  const responsePath = join(signerDir, 'response.der');
  writeFileSync(requestPath, Buffer.from(body));
  execFileSync('openssl', ['ts', '-reply', '-config', join(signerDir, 'tsa.cnf'), '-queryfile', requestPath, '-out', responsePath], { stdio: 'pipe', timeout: 10000 });
  return readFileSync(responsePath);
}

// Mirrors mockChurchTools.js's mechanism: undici's MockAgent intercepts Node's global fetch
// (which pdf-rfc3161's sendTimestampRequest uses directly, exactly like churchtools.js does for
// ChurchTools), so tests never make a real network call to a TSA. Returns the MockPool for url's
// origin so callers chain their own `.intercept({ path, method }).reply(...)` per expected
// request, exactly like setupMockChurchTools.
export function setupMockTsa(url) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  return mockAgent.get(new URL(url).origin);
}
