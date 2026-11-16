import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// U3: Heikle Formulare (Löschen, Verwerfen, Deaktivieren, Markierung aufheben) fragen vorher nach
// (data-bestaetigen, ausgewertet in public/js/portal.js). Quelltextprüfung der Formular-Anfangstags.
const STELLEN = [
  { datei: 'views/admin/kreditoren-form.ejs', action: '/admin/kreditoren/ibans/', gefahr: true },
  { datei: 'views/admin/kreditoren-form.ejs', action: '/admin/kreditoren/regeln/<%= regel.id %>/loeschen', gefahr: true },
  { datei: 'views/admin/datei-quarantaene.ejs', action: '/loeschen', gefahr: true },
  { datei: 'views/admin/konten-liste.ejs', action: '/deaktivieren', gefahr: false },
  { datei: 'views/kreditkarte-beleg-bearbeiten.ejs', action: '/verwerfen', gefahr: true },
  { datei: 'views/rapport.ejs', action: '/rapport-aufheben', gefahr: false },
  { datei: 'views/admin/vorgang-detail.ejs', action: '/rapport/aufheben', gefahr: false },
];

for (const { datei, action, gefahr } of STELLEN) {
  test(`Rückfrage vorhanden: ${datei} (${action})`, () => {
    const quelle = readFileSync(new URL(`../../${datei}`, import.meta.url), 'utf8');
    const tags = [...quelle.matchAll(/<form\b(?:<%.*?%>|[^>])*>/g)].map((m) => m[0]).filter((tag) => tag.includes(action));
    assert.ok(tags.length > 0, `Formular mit ${action} nicht gefunden`);
    for (const tag of tags) {
      assert.match(tag, /data-bestaetigen="[^"]{15,}"/, `Fragetext fehlt: ${tag}`);
      assert.match(tag, /data-bestaetigen-knopf="[^"]+"/, `Beschriftung des Bestätigungsknopfs fehlt: ${tag}`);
      if (gefahr) assert.match(tag, /data-bestaetigen-gefahr/, `Gefahr-Markierung fehlt: ${tag}`);
    }
  });
}
