// Admin → Benachrichtigungen im echten Browser (public/js/benachrichtigungen.js): Empfänger-Auswahl
// mit Maus und Tastatur, Variablen-Knöpfe, Live-Vorschau, Hinweis zur Test-Mail, Speichern.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { starteBrowser } from './helfer.js';

let b;
before(async () => { b = await starteBrowser(); });
after(async () => { await b.stop(); });

const kaertchen = (page) => page.locator('[data-empfaenger-kaertchen] .zielwahl-chip-text').allTextContents();
const textfeld = (page) => page.locator('#empfaenger').inputValue();

test('Empfänger-Auswahl: Textfeld versteckt, Gruppe per Klick, Person per Suche, E-Mail, Entfernen', async () => {
  const page = await b.neueSeite('/admin/benachrichtigungen/reminder');
  assert.equal(await page.locator('#empfaenger').isVisible(), false, 'Textfeld ist versteckt');
  assert.deepEqual(await kaertchen(page), ['Gruppe Buchhaltung']);

  const suche = page.locator('#empfaengerSuche');
  await suche.click();
  const liste = page.locator('#empfaengerVorschlaege');
  assert.equal(await suche.getAttribute('aria-expanded'), 'true');
  await liste.getByRole('option', { name: 'Gruppe Admin' }).click();
  assert.deepEqual(await kaertchen(page), ['Gruppe Buchhaltung', 'Gruppe Admin']);
  assert.equal(await textfeld(page), 'gruppe:buchhaltung\ngruppe:admin');

  // Person über die Suche (erste Person der Liste, nach einem Teil des Namens gesucht).
  await suche.click();
  const erste = (await liste.locator('[role=group]:has(#empfaengerAbschnittPersonen) [role=option]').first().textContent()).trim();
  await suche.fill(erste.split(' ').pop().slice(0, 3));
  await liste.getByRole('option', { name: erste }).first().click();
  assert.ok((await kaertchen(page)).includes(erste));
  assert.match(await textfeld(page), /\nperson:[^\n]+$/);

  // Ungültige Adresse: kein Kärtchen; gültige Adresse per Enter.
  await suche.fill('kein-mail');
  await liste.getByRole('option', { name: 'Andere E-Mail-Adresse eingeben …' }).click();
  assert.match(await page.locator('#empfaengerSucheMeldung').textContent(), /keine gültige E-Mail-Adresse/);
  await suche.fill('revision@example.org');
  await suche.press('Enter');
  assert.ok((await kaertchen(page)).includes('revision@example.org'));
  assert.match(await textfeld(page), /\nrevision@example\.org$/);

  // Entfernen per ✕ (Name im aria-label).
  await page.getByRole('button', { name: 'Gruppe Admin entfernen' }).click();
  assert.ok(!(await kaertchen(page)).includes('Gruppe Admin'));
  assert.doesNotMatch(await textfeld(page), /gruppe:admin/);
  await page.close();
});

test('Empfänger-Auswahl per Tastatur: ↓/↑ setzt aria-activedescendant, Enter wählt, Escape schliesst', async () => {
  const page = await b.neueSeite('/admin/benachrichtigungen/reminder');
  const suche = page.locator('#empfaengerSuche');
  await suche.focus();
  await suche.press('ArrowDown');
  assert.equal(await suche.getAttribute('aria-expanded'), 'true');
  await suche.press('ArrowDown');
  const id = await suche.getAttribute('aria-activedescendant');
  assert.ok(id, 'aktive Option gesetzt');
  const aktiv = page.locator(`#${id}`);
  assert.equal(await aktiv.getAttribute('aria-selected'), 'true');
  assert.equal(await aktiv.textContent(), 'Gruppe Admin');
  await suche.press('ArrowUp');
  await suche.press('ArrowDown');
  await suche.press('Enter');
  assert.deepEqual(await kaertchen(page), ['Gruppe Buchhaltung', 'Gruppe Admin']);
  assert.equal(page.url().includes('gespeichert'), false, 'Enter sendet das Formular nicht ab');
  await suche.press('ArrowDown');
  assert.equal(await suche.getAttribute('aria-expanded'), 'true');
  await suche.press('Escape');
  assert.equal(await suche.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#empfaengerVorschlaege').isVisible(), false);
  await page.close();
});

test('Audit-Prüfnummer: Vorschläge nur E-Mail, keine Gruppen und Personen', async () => {
  const page = await b.neueSeite('/admin/benachrichtigungen/audit-pruefnummer');
  const suche = page.locator('#empfaengerSuche');
  await suche.click();
  await suche.fill('a');
  const optionen = await page.locator('#empfaengerVorschlaege [role=option]').allTextContents();
  assert.deepEqual(optionen, ['Andere E-Mail-Adresse eingeben …']);
  await page.close();
});

test('Variablen-Knopf fügt an der Cursorposition ein, Vorschau und Warnung folgen live, Test-Mail-Hinweis', async () => {
  const page = await b.neueSeite('/admin/benachrichtigungen/reminder');
  const hinweis = page.locator('#testmailHinweis');
  assert.match(await hinweis.textContent(), /verwendet den gespeicherten Text/);
  const betreff = page.locator('#betreff');
  await betreff.fill('Hallo  Ende');
  await betreff.evaluate((f) => f.setSelectionRange(6, 6));
  await page.locator('button.var[data-var="jobDateiname"]').click();
  assert.equal(await betreff.inputValue(), 'Hallo %jobDateiname% Ende');
  assert.equal(await page.locator('#vorschauBetreff').textContent(), 'Hallo Rechnung-4711.pdf Ende');
  await betreff.press('End');
  await betreff.type(' %xy%');
  assert.equal(await page.locator('#vorschauBetreff').textContent(), 'Hallo Rechnung-4711.pdf Ende %xy%');
  assert.equal(await page.locator('#vorschauWarnungen').textContent(), 'Unbekannter Platzhalter: %xy%');
  assert.match(await hinweis.textContent(), /speichere zuerst/);
  await page.close();
});

test('Speichern mit der Auswahl: gespeicherte Empfänger erscheinen wieder als Kärtchen', async () => {
  const page = await b.neueSeite('/admin/benachrichtigungen/eskalation');
  const suche = page.locator('#empfaengerSuche');
  await suche.fill('neu@example.org');
  await suche.press('Enter');
  const vorher = await kaertchen(page);
  await Promise.all([page.waitForURL(/gespeichert=1/), page.getByRole('button', { name: 'Speichern' }).click()]);
  assert.deepEqual(await kaertchen(page), vorher);
  assert.ok(vorher.includes('neu@example.org'));
  await page.close();
});

test('Leere Kärtchenliste ist wirklich unsichtbar (hidden gegen d-flex), Hinweis erscheint; Zeilenenden zählen nicht als Änderung', async () => {
  const page = await b.neueSeite('/admin/benachrichtigungen/reminder');
  const liste = page.locator('[data-empfaenger-kaertchen]');
  assert.notEqual(await liste.evaluate((el) => getComputedStyle(el).display), 'none', 'mit Kärtchen sichtbar');
  await page.getByRole('button', { name: 'Gruppe Buchhaltung entfernen' }).click();
  assert.deepEqual(await kaertchen(page), []);
  assert.equal(await liste.evaluate((el) => getComputedStyle(el).display), 'none', 'leere Liste ist wirklich ausgeblendet, nicht nur leer');
  assert.equal(await page.locator('[data-empfaenger-leer]').isVisible(), true);
  await page.close();
});

test('Test-Mail-Hinweis: gleiche Empfängerliste mit anderem Zeilenende oder Leerzeilen gilt nicht als ungespeichert', async () => {
  const page = await b.neueSeite('/admin/benachrichtigungen/reminder');
  const hinweis = page.locator('#testmailHinweis');
  const feld = page.locator('#empfaenger');
  const wert = await feld.inputValue();
  await feld.evaluate((f, v) => { f.value = `\r\n ${v.replace(/\n/g, '\r\n')} \r\n\r\n`; f.dispatchEvent(new Event('input', { bubbles: true })); }, wert);
  assert.doesNotMatch(await hinweis.textContent(), /speichere zuerst/);
  await feld.evaluate((f) => { f.value += '\nrev@example.org'; f.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await hinweis.textContent(), /speichere zuerst/);
  await page.close();
});
