import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { holeUrlPerHttp } from '../../src/services/tsaCrlUpdate.js';

// B4: Die 4-MB-Grenze gilt beim Lesen, nicht erst nach dem vollständigen Laden.
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/crl` }));
  });
}

test('Antwort ohne Content-Length: Abbruch beim Überschreiten, der Rest wird nicht mehr geladen', async () => {
  const MB = 1024 * 1024;
  const GESAMT = 128;
  let geschrieben = 0;
  let beendet = false;
  const { server, url } = await startServer((req, res) => {
    // Chunked (keine Content-Length), Server schreibt nur, solange der Client liest.
    const chunk = Buffer.alloc(MB, 1);
    const schreibe = () => {
      while (!beendet && geschrieben < GESAMT) {
        geschrieben += 1;
        if (!res.write(chunk)) { res.once('drain', schreibe); return; }
      }
      if (!beendet) res.end();
    };
    res.on('close', () => { beendet = true; }); // Verbindung geschlossen: Schreiben beenden
    schreibe();
  });
  let gesehen = 0;
  server.on('request', () => {});
  try {
    await assert.rejects(() => holeUrlPerHttp(url), /zu gross/);
    gesehen = geschrieben;
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  assert.ok(gesehen < GESAMT, `Server hat die ganze Antwort geliefert (${gesehen} MB), der Abbruch kam zu spät`);
});

test('Antwort mit grosser Content-Length: sofort abgelehnt', async () => {
  const { server, url } = await startServer((req, res) => {
    res.setHeader('content-length', String(10 * 1024 * 1024));
    res.write(Buffer.alloc(1024));
  });
  try {
    await assert.rejects(() => holeUrlPerHttp(url), /zu gross/);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('Kleine Antwort wird vollständig geliefert', async () => {
  const { server, url } = await startServer((req, res) => res.end(Buffer.from('abc')));
  try {
    assert.equal((await holeUrlPerHttp(url)).toString(), 'abc');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
