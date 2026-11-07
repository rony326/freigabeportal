// Statischer Sweep: die Content-Security-Policy erlaubt Inline-Skripte und <style>-Blöcke nur mit
// der Nonce der Anfrage (res.locals.cspNonce). Jede View muss sie setzen; Ereignis-Attribute
// (onclick=…) und javascript:-Links würde der Browser blockieren.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const wurzel = new URL('../../', import.meta.url).pathname;

function dateien(dir, endung) {
  return readdirSync(dir).flatMap((f) => {
    const pfad = join(dir, f);
    if (statSync(pfad).isDirectory()) return f === 'vendor' ? [] : dateien(pfad, endung);
    return pfad.endsWith(endung) ? [pfad] : [];
  });
}

const NONCE = 'nonce="<%= locals.cspNonce %>"';

test('CSP-Sweep: jedes Inline-<script> und jeder <style>-Block in den Views trägt die Nonce', () => {
  const views = dateien(join(wurzel, 'views'), '.ejs');
  assert.ok(views.length > 50);
  for (const datei of views) {
    const inhalt = readFileSync(datei, 'utf8');
    for (const m of inhalt.matchAll(/<(script|style)\b((?:<%.*?%>|[^>])*)>/g)) {
      if (/\bsrc=/.test(m[2])) continue;
      assert.ok(m[2].includes(NONCE), `${datei}: ${m[0]} ohne ${NONCE}`);
    }
  }
});

test('CSP-Sweep: keine Ereignis-Attribute (onclick=…) und keine javascript:-Links in Views und Portal-Skripten', () => {
  const alle = [...dateien(join(wurzel, 'views'), '.ejs'), ...dateien(join(wurzel, 'public/js'), '.js')];
  for (const datei of alle) {
    const inhalt = readFileSync(datei, 'utf8');
    assert.doesNotMatch(inhalt, /\son(click|change|submit|input|load|error|keydown|keyup|focus|blur|mouse\w+)\s*=\s*["']/i, `${datei}: Ereignis-Attribut`);
    assert.doesNotMatch(inhalt, /href\s*=\s*["']javascript:/i, `${datei}: javascript:-Link`);
  }
});
