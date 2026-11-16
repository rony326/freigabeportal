import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruefeTsaUrl, istOeffentlicheIp, pruefeGespeicherteTsaUrl } from '../../src/services/tsaUrlPruefung.js';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';

// S6: TSA-Adresse nur https, keine privaten/Loopback-/Link-Local-Ziele. DNS wird injiziert (kein Netz).
const OEFFENTLICH = '93.184.216.34';
const dns = (...adressen) => async () => adressen;

test('istOeffentlicheIp: private, Loopback, Link-Local und Verwandte IPv4-Bereiche sind nicht öffentlich', () => {
  for (const ip of ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '255.255.255.255']) {
    assert.equal(istOeffentlicheIp(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '169.253.0.1', '192.167.1.1', '11.0.0.1']) {
    assert.equal(istOeffentlicheIp(ip), true, ip);
  }
});

test('istOeffentlicheIp: IPv6 – Loopback, unspecified, ULA, Link-Local, gemappte und eingebettete IPv4', () => {
  for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3',
    '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::1', '::127.0.0.1', 'fe80::1%eth0', '0:0:0:0:0:0:0:1']) {
    assert.equal(istOeffentlicheIp(ip), false, ip);
  }
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
    assert.equal(istOeffentlicheIp(ip), true, ip);
  }
});

test('pruefeTsaUrl: nur https', async () => {
  for (const url of ['http://tsa.example.org/tsr', 'ftp://tsa.example.org', 'tsa.example.org/tsr', 'file:///etc/passwd', 'javascript:alert(1)']) {
    const r = await pruefeTsaUrl(url, { aufloesen: dns(OEFFENTLICH) });
    assert.equal(r.ok, false, url);
  }
  assert.deepEqual(await pruefeTsaUrl('https://tsa.example.org/tsr', { aufloesen: dns(OEFFENTLICH) }), { ok: true });
});

test('pruefeTsaUrl: IP-Literale (auch dezimal/hex/oktal/IPv6/gemappt) auf private Ziele werden abgelehnt, ohne DNS', async () => {
  const aufloesen = async () => { throw new Error('DNS darf für IP-Literale nicht gefragt werden'); };
  for (const url of ['https://127.0.0.1/tsr', 'https://2130706433/tsr', 'https://0x7f000001/tsr', 'https://0177.0.0.1/tsr', 'https://127.1/tsr',
    'https://[::1]/tsr', 'https://[::ffff:127.0.0.1]/tsr', 'https://[fe80::1]/tsr', 'https://[fd00::1]/tsr', 'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5:8443/tsr', 'https://192.168.1.1/', 'https://100.64.1.1/', 'https://0.0.0.0/']) {
    const r = await pruefeTsaUrl(url, { aufloesen });
    assert.equal(r.ok, false, url);
  }
  assert.equal((await pruefeTsaUrl('https://8.8.8.8/tsr', { aufloesen })).ok, true);
  assert.equal((await pruefeTsaUrl('https://[2606:4700:4700::1111]/tsr', { aufloesen })).ok, true);
});

test('pruefeTsaUrl: Hostname wird aufgelöst, jede aufgelöste Adresse zählt', async () => {
  assert.equal((await pruefeTsaUrl('https://intern.example.org/tsr', { aufloesen: dns('10.1.1.1') })).ok, false);
  assert.equal((await pruefeTsaUrl('https://mix.example.org/tsr', { aufloesen: dns(OEFFENTLICH, '127.0.0.1') })).ok, false, 'zweite Adresse privat');
  assert.equal((await pruefeTsaUrl('https://mix.example.org/tsr', { aufloesen: dns('127.0.0.1', OEFFENTLICH) })).ok, false, 'erste Adresse privat');
  assert.equal((await pruefeTsaUrl('https://v6.example.org/tsr', { aufloesen: dns('2606:4700:4700::1111', '::1') })).ok, false);
  assert.equal((await pruefeTsaUrl('https://ok.example.org/tsr', { aufloesen: dns(OEFFENTLICH, '2606:4700:4700::1111') })).ok, true);
});

test('pruefeTsaUrl: localhost, nicht auflösbar oder leere Antwort werden abgelehnt', async () => {
  assert.equal((await pruefeTsaUrl('https://localhost/tsr', { aufloesen: dns('127.0.0.1') })).ok, false);
  const fehler = await pruefeTsaUrl('https://gibtesnicht.example.org/tsr', { aufloesen: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(fehler.ok, false);
  assert.match(fehler.grund, /aufgelöst/);
  assert.equal((await pruefeTsaUrl('https://leer.example.org/tsr', { aufloesen: dns() })).ok, false);
});

test('pruefeGespeicherteTsaUrl: leer = nichts zu prüfen, sonst Ergebnis mit URL', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(await pruefeGespeicherteTsaUrl(db, { aufloesen: dns(OEFFENTLICH) }), null);
  setConfigValue(db, 'zeitstempel_tsa_url', 'http://tsa.example.org/tsr');
  const r = await pruefeGespeicherteTsaUrl(db, { aufloesen: dns(OEFFENTLICH) });
  assert.equal(r.ok, false);
  assert.equal(r.url, 'http://tsa.example.org/tsr');
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  assert.equal((await pruefeGespeicherteTsaUrl(db, { aufloesen: dns(OEFFENTLICH) })).ok, true);
  db.close();
});
