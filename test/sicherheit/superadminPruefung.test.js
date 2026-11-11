import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Die Superadmin-Gruppe wird nur über personHasRole geprüft (eine Stelle für die Gruppenlogik).
test('keine handgebaute Superadmin-Prüfung über gruppen.includes(groupIdAdmin) in Routen und Zugriffsdiensten', () => {
  for (const datei of ['src/routes/freigabe2.js', 'src/routes/spesenFreigabe1.js', 'src/routes/ablehnung.js', 'src/services/kontierungZugriff.js']) {
    const quelle = readFileSync(new URL(`../../${datei}`, import.meta.url), 'utf8');
    assert.doesNotMatch(quelle, /gruppen\.includes\(String\(config\.churchtools\.groupIdAdmin\)\)/, datei);
    assert.match(quelle, /personHasRole\(person, config, 'superadmin'\)/, datei);
  }
});

test('n8n-Eingang loggt den Dateinamen als JSON-String (keine Log-Injection)', () => {
  const quelle = readFileSync(new URL('../../src/routes/n8n/jobs.js', import.meta.url), 'utf8');
  assert.match(quelle, /JSON\.stringify\(String\(req\.body\?\.dateiname/);
});
