# Einheitliches Layout und Kachelansicht Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alle Seiten des Portals bekommen ein gemeinsames Grundgerüst (obere Leiste mit Bereichsreitern, gruppierte Seitenleiste, eine Breite) und sieben Beleg-/Vorgangslisten einen Tabelle/Kacheln-Umschalter.

**Architecture:** Navigation wird als reine Daten in `src/services/navigation.js` gebaut und von `src/middleware/nav.js` als `res.locals.navigation` bereitgestellt. Zwei Layout-Partials (`_seite_anfang.ejs` / `_seite_ende.ejs`) ersetzen in jeder View das duplizierte `<head>`, `_header.ejs`, `admin/_nav.ejs` und die `<main>`-Container. Die Kachelwahl liest eine Middleware aus einem Cookie pro Liste. Ohne Cookie rendert die Seite beide Ansichten und lässt CSS je nach Bildschirmbreite wählen.

**Tech Stack:** Node ≥ 22.13, Express 4, EJS 3, Bootstrap 5.3 (vendored unter `public/vendor/bootstrap`), `node:test` + supertest.

**Spec:** `docs/superpowers/specs/2026-10-23-einheitliches-layout-und-kachelansicht-design.md`
Visueller Entwurf: https://claude.ai/artifact/ToeuNW2xAnq6C54sXhFaes

## Global Constraints

- Äussere Breite überall: Bootstrap `container-xxl` (max. 1320 px). Kein `container-fluid`, kein `navContainerClass` mehr.
- Seitenleiste 200–220 px, auf PDF-Seiten eingeklappt auf ca. 44 px. Unter `lg` (< 992 px) liegt sie hinter einem „☰“-Knopf als Bootstrap-Offcanvas.
- Keine neuen Routen-Funktionen, Rechte oder Workflow-Änderungen. Jeder Menüpunkt erscheint genau unter den heutigen Bedingungen (`adminNav`, `spesenModulAktiv`, `zeigeKreditkarteNav`, `navHatAdminZugang`).
- Bootstrap-CSS und -JS werden pro Seite genau einmal geladen.
- Neue CSS/JS als Dateien unter `public/css/` bzw. `public/js/`, nicht inline.
- Alle Formulare behalten `_csrf`; `test/integration/csrfSweep.test.js` bleibt grün.
- Hell/Dunkel/System und die Branding-Farben (`--brand-primary`) gelten für alle neuen Elemente. Aktiv-Markierungen und Primärknöpfe nutzen `--brand-primary`.
- `<title>`-Format unverändert: `<Titel> — <seitenTitel>`, im Admin-Bereich `<Titel> — <seitenTitel> Admin`.
- Kachel-Umschalter nur auf: `/pool`, `/meine-spesen`, `/meine-abgeschlossenen`, `/kreditkarte`, `/admin/vorgaenge`, `/admin/abgelehnt`, `/admin/altfaelle`.
- Cookie `ansicht_<schluessel>` mit Wert `tabelle` oder `kacheln`, `path=/`, 1 Jahr, `samesite=lax`.
- Jede Kachel enthält alle Angaben und alle Aktionen ihrer Tabellenzeile.
- UI-Texte auf Deutsch (Schweizer Schreibweise ohne ß in neuen Texten, bestehende Texte nicht umschreiben).

## Review Focus

1. **Person mit genau einem Admin-Recht** (z. B. nur `mails_einsehen`): sieht den Reiter „Admin“, in der Seitenleiste nur die Gruppe „Betrieb“ mit „Mail-Protokoll“. Andere Gruppen fehlen ganz. → Test in Task 1.
2. **Aktiv-Markierung über Pfadgrenzen:** `/admin/konten/neu` markiert „Konten“, aber `/kreditkarten…` markiert nie `/kreditkarte`, und `/admin` markiert keinen Seitenleisten-Punkt. → Test in Task 1.
3. **Fehlerseite und Abmeldeseite ohne Session bzw. ohne Nav-Middleware:** Sie rendern ohne Absturz, ohne Seitenleiste und ohne Reiter, aber mit `container-xxl`. → Test in Task 3.
4. **Auto-Modus (kein Cookie) rendert beide Ansichten:** Keine doppelten `id`-Attribute auf `/pool`. „Beanspruchen“ funktioniert aus Tabelle und Kachel. → Tests in Task 6 und 7.
5. **`?ansicht=` mit ungültigem Wert, auf fremder Seite oder zusammen mit Filtern:** Ungültig bzw. fremd wird ignoriert (kein Cookie, kein Redirect). Gültig führt zum Redirect auf denselben Pfad, die übrigen Query-Parameter (z. B. `status=…&probleme=1`) bleiben erhalten. → Test in Task 6.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `src/services/navigation.js` (neu) | Reine Funktionen: Bereich bestimmen, Gruppen bauen, Aktiv-Markierung |
| `src/services/aufgabenZaehler.js` (neu) | Zahl der persönlich offenen Aufgaben |
| `src/middleware/nav.js` (ändern) | stellt `res.locals.navigation` bereit |
| `src/middleware/ansicht.js` (neu) | `?ansicht=` → Cookie + Redirect; `res.locals.ansicht` |
| `views/_seite_anfang.ejs` / `views/_seite_ende.ejs` (neu) | Grundgerüst: head, obere Leiste, Seitenleiste, main, Footer |
| `views/_seitenleiste.ejs` (neu) | Gruppen-Markup, voll und als Symbolleiste |
| `views/_ansicht_umschalter.ejs` (neu) | Knopfgruppe „☰ Tabelle \| ▦ Kacheln“ |
| `views/_job_aktionen.ejs`, `views/_job_kacheln.ejs` (neu) | Aktionen bzw. Kacheln für Pool-Abschnitte |
| je Liste ein `_…_kacheln.ejs` (neu) | Kacheln der übrigen sechs Listen |
| `public/css/portal.css`, `public/js/portal.js` (neu) | Layout-, Kachel- und Druck-CSS; Theme-Toggle, Tooltips |
| `views/_header.ejs`, `views/admin/_nav.ejs` (löschen) | ersetzt durch Layout-Partials |
| `test/unit/navigation.test.js`, `test/unit/aufgabenZaehler.test.js`, `test/unit/ansicht.test.js`, `test/integration/layoutSweep.test.js`, `test/integration/kachelansicht.test.js` (neu) | Tests |

---

### Task 1: Navigationsdaten als reine Funktionen

**Files:**
- Create: `src/services/navigation.js`
- Test: `test/unit/navigation.test.js`

**Interfaces:**
- Produces:
  - `bereichFuerPfad(pfad: string) -> 'portal' | 'admin'`. Liefert `'admin'` genau dann, wenn `pfad === '/admin'` oder `pfad.startsWith('/admin/')`.
  - `istAktiv(pfad: string, href: string) -> boolean`. Liefert `pfad === href || pfad.startsWith(href + '/')`.
  - `bauePortalGruppen({ pfad, spesenModulAktiv, zeigeKreditkarteNav, offeneAufgaben }) -> Gruppe[]`
  - `baueAdminGruppen({ pfad, adminNav }) -> Gruppe[]`
  - Typ `Gruppe = { titel: string, punkte: Array<{ label, href, aktiv: boolean, symbol: string, zaehler?: number }> }`. Gruppen ohne Punkte werden weggelassen.

Gruppen, Labels, Hrefs und Bedingungen exakt nach der Spec-Tabelle „Seitenleiste links“:

- **Portal:** Arbeit: Aufgaben `/pool`. Spesen: Spesen einreichen `/spesen/neu` (nur bei aktivem Spesenmodul), Meine Spesen `/meine-spesen`. Belege: Abgeschlossene Rechnungen `/meine-abgeschlossenen`, Kreditkartenbelege `/kreditkarte` (nur bei `zeigeKreditkarteNav`). Persönlich: Ferienmodus `/ferienmodus`, Zeitstempel prüfen `/zeitstempel-pruefen`.
- **Admin:** Hrefs wie in `views/admin/_nav.ejs`; Datei-Quarantäne hängt am Flag `backup`.
- `zaehler` nur bei „Aufgaben“ und nur, wenn `offeneAufgaben > 0`.
- Der Zähler bei „Kreditkartenbelege“ entfällt (Spec erlaubt das; YAGNI).

- [ ] **Step 1: Write the failing tests**

```js
test('nur mails_einsehen → nur Gruppe Betrieb mit Mail-Protokoll', () => {
  const adminNav = Object.fromEntries(['vorgaenge','konten','kreditoren','eskalation','mailEinstellungen','erscheinungsbild','zeitstempel','personen','mails','sync','geplanteJobs','abgelehnt','auditLog','backup','module','kreditkarten','altfaelle'].map((k) => [k, k === 'mails']));
  const gruppen = baueAdminGruppen({ pfad: '/admin/mails', adminNav });
  assert.deepEqual(gruppen.map((g) => g.titel), ['Betrieb']);
  assert.deepEqual(gruppen[0].punkte.map((p) => [p.label, p.aktiv]), [['Mail-Protokoll', true]]);
});
test('Admin-Gruppen in Reihenfolge Vorgänge, Stammdaten, Einstellungen, Betrieb bei allen Rechten', ...);
test('istAktiv: Unterseite markiert, Präfix ohne Pfadgrenze nicht', () => {
  assert.equal(istAktiv('/admin/konten/neu', '/admin/konten'), true);
  assert.equal(istAktiv('/kreditkarten', '/kreditkarte'), false);
  assert.equal(istAktiv('/admin', '/admin/konten'), false);
});
test('bereichFuerPfad', () => {
  assert.equal(bereichFuerPfad('/admin'), 'admin');
  assert.equal(bereichFuerPfad('/admin/konten'), 'admin');
  assert.equal(bereichFuerPfad('/administration'), 'portal');
  assert.equal(bereichFuerPfad('/pool'), 'portal');
});
test('Portal: Spesen einreichen fehlt bei inaktivem Modul, Kreditkartenbelege nur mit Flag', ...);
test('Portal: Zähler nur bei offeneAufgaben > 0', () => {
  assert.equal(finde(bauePortalGruppen({ pfad: '/pool', spesenModulAktiv: true, zeigeKreditkarteNav: false, offeneAufgaben: 0 }), 'Aufgaben').zaehler, undefined);
  assert.equal(finde(bauePortalGruppen({ ..., offeneAufgaben: 3 }), 'Aufgaben').zaehler, 3);
});
```

- [ ] **Step 2: Run** `node --test test/unit/navigation.test.js`. Expected: FAIL (Modul fehlt).
- [ ] **Step 3: Implement `src/services/navigation.js`** mit den obigen Signaturen. Gruppen als Konstante (Label, Href, Flag-Schlüssel, Symbol), danach filtern. Symbole sind einfache Unicode-Zeichen, Wahl beim Umsetzer.
- [ ] **Step 4: Run** `node --test test/unit/navigation.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nav): Navigationsgruppen als reine Funktionen`

---

### Task 2: Aufgaben-Zähler und `res.locals.navigation`

**Files:**
- Create: `src/services/aufgabenZaehler.js`
- Modify: `src/middleware/nav.js`
- Test: `test/unit/aufgabenZaehler.test.js`

**Interfaces:**
- Consumes: Task 1 (alle Exporte).
- Produces:
  - `zaehleOffeneAufgaben(db, personId: string) -> number`. Summe aus `listZugewiesenJobsForPerson`, `listFreigabe2JobsForPerson` und `listSpesenFreigabe1JobsForPerson` (dieselben Repo-Funktionen wie `src/routes/poolPage.js:55-57`). Pool, Rückläufer, Eskalationen und abgelehnte Jobs zählen nicht mit.
  - `res.locals.navigation = { bereich, zeigeAdminReiter: boolean, gruppen: Gruppe[] }`. Wird nur gesetzt, wenn `req.currentPerson` existiert, sonst `null`. `zeigeAdminReiter` folgt der heutigen Logik aus `_header.ejs` (`navHatAdminZugang`: Superadmin, Manager oder ein beliebiges `adminNav`-Flag). `gruppen` hängt vom Bereich ab: im Admin-Bereich `baueAdminGruppen`, sonst `bauePortalGruppen`.
  - `spesenModulAktiv` setzt `loadBranding` (läuft in `src/app.js:103` vor `loadNavFlags` in Zeile 139). Fehlt der Wert (z. B. in Test-Apps ohne Branding), wird `!== false` angenommen, wie heute in `_header.ejs`.

- [ ] **Step 1: Failing tests:**
  - `zaehleOffeneAufgaben` liefert 0 für eine Person ohne Jobs.
  - Mit je einem zugewiesenen Kontierungs-, einem Freigabe-2- und einem Pool-Job liefert es 2. Der Pool-Job zählt nicht. Fixtures wie in `test/integration/poolPage.test.js`.
- [ ] **Step 2: Run** `node --test test/unit/aufgabenZaehler.test.js` → FAIL.
- [ ] **Step 3: Implement** Service und Erweiterung in `loadNavFlags`. Die bestehenden `res.locals`-Felder bleiben unverändert, bis Task 4 die alten Views entfernt.
- [ ] **Step 4: Run** `npm test` → PASS (bestehende Tests unberührt).
- [ ] **Step 5: Commit** `feat(nav): Aufgaben-Zähler und Navigationsdaten in res.locals`

---

### Task 3: Layout-Partials und Umstellung der Portal-Seiten

**Files:**
- Create: `views/_seite_anfang.ejs`, `views/_seite_ende.ejs`, `views/_seitenleiste.ejs`, `public/css/portal.css`, `public/js/portal.js`, `test/integration/layoutSweep.test.js`
- Modify: alle 17 Views direkt in `views/` (ohne `_`-Partials). Dazu `views/_footer.ejs` (wird nur noch von `_seite_ende` eingebunden), `test/integration/app.test.js:225-275, 600-720`, `test/integration/poolPage.test.js:85-105, 175-185`.
- Delete: noch nicht `_header.ejs` (Admin-Views brauchen es bis Task 4).

**Interfaces:**
- Consumes: `res.locals.navigation` (Task 2), `branding`, `currentPerson`, `currentPath`, `csrfToken`.
- Produces: `include('_seite_anfang', { titel: string, rahmen?: 'voll' | 'kompakt' | 'ohne' })` und `include('_seite_ende')`. Standard für `rahmen` ist `'voll'`. Admin-Views binden später `'../_seite_anfang'` ein.

Layout-Regeln:

- **`_seite_anfang`** erzeugt:
  - `<!DOCTYPE html>`, `<html>` mit den heutigen `data-theme`/`data-bs-theme`-Attributen, `<head>` mit Viewport, Bootstrap-CSS, `portal.css`, `_brand_styles` und `<title>` im Format der Global Constraints.
  - Das Theme-Vorab-Skript (heute oben in `_header.ejs`) unverändert als erstes Element.
  - Danach `<body>`, dann je nach `rahmen`:
    - `'voll'`: obere Leiste (`header.portal-kopf`), dann `div.container-xxl > div.portal-rahmen` mit `nav.portal-seitenleiste` und `main.portal-inhalt`.
    - `'kompakt'`: wie `'voll'`, aber die Seitenleiste wird nur als Symbolleiste gerendert (`.portal-seitenleiste.eingeklappt`; jedes Symbol ein Link mit `title` und `aria-label` = Label).
    - `'ohne'`: nur `<main class="container-xxl py-3">`, keine Leiste, keine Seitenleiste, kein Footer.
- **Obere Leiste:**
  - Logo gemäss `branding.logoAusrichtung` (`links`/`mitte`/`rechts`; ohne Logo `branding.seitenTitel` als Text).
  - Reiter „Portal“ (`/pool`) und „Admin“ (`/admin`, nur bei `navigation.zeigeAdminReiter`); der aktive Reiter bekommt `aria-current="page"`.
  - Rechts: „Angemeldet als …“, Theme-Knopf `#theme-toggle`, Abmelden-Formular mit `_csrf` (Markup wie heute in `_header.ejs`).
  - Unter `lg` zusätzlich ein „☰“-Knopf `#seitenleiste-toggle`, der die Seitenleiste als Offcanvas öffnet.
  - Ist `navigation` `null` (nicht eingeloggt, Fehlerseite), gibt es keine Reiter, keine Seitenleiste und keinen ☰-Knopf. `main` liegt dann direkt im `container-xxl`.
- **Aktionszeile:** Auf `/kontierung*` und `/freigabe2*` steht oben in `main` eine `div.portal-aktionen`, in genau dieser Reihenfolge:
  1. `<a href="/pool" class="btn btn-primary btn-sm">← Zurück</a>`
  2. `#preview-refresh-btn`
  3. auf `/kontierung*` zusätzlich der „+ Lieferant“-Knopf (`data-bs-target="#neuer-lieferant-modal"`)

  Die Pfadlogik ist dieselbe wie heute in `_header.ejs`. Der Neu-laden-Knopf auf `/pool` wandert in den Seitenkopf der Pool-View (Task 5); in diesem Task steht er vorerst in `.portal-aktionen`.
- **`public/js/portal.js`:** Theme-Toggle (aus `_header.ejs`) und Bootstrap-Tooltips für `.portal-seitenleiste.eingeklappt [title]`. Wird in `_seite_ende` mit `defer` geladen. Bootstrap-JS lädt `_seite_anfang` einmal.
- **`portal.css`:** Rahmen-Grid, Seitenleiste, aktive Markierung (`--brand-primary`), Badge-Zähler, `@media print` (`.portal-kopf`, `.portal-seitenleiste`, `footer` ausblenden; nötig für `zeitstempel-zertifikat`).
- **`rahmen`-Zuordnung:** `'kompakt'` für `kontierung`, `freigabe2`, `spesen-freigabe1`, `kk-abgleich`; `'ohne'` für `kontierung-aufsplitten` (iframe im Modal, siehe Spec); `'voll'` für alle übrigen.

- [ ] **Step 1: Failing tests in `layoutSweep.test.js`.** Ein statischer Test über alle Nicht-Partial-Views in `views/` (in Task 4 auf `views/admin/` erweitert):
  - Keine View enthält `<!DOCTYPE`, `container-fluid`, `include('_header'`, `include('../_header'` oder `navContainerClass`.
  - Jede View beginnt mit genau einem `include('_seite_anfang'` und endet mit `include('_seite_ende'`.
- [ ] **Step 2: Failing render tests** (im selben File, mit supertest und echter App wie `app.test.js`):
  - `GET /pool` als Buchhaltungs-Person: genau ein `bootstrap.min.css`, genau ein `bootstrap.bundle.min.js`, `container-xxl`, `nav.portal-seitenleiste` mit `aria-current="page"` auf `/pool`, Reiter „Portal“ aktiv, kein „Admin“-Reiter.
  - `GET /kontierung/:id`: `.portal-seitenleiste.eingeklappt`; in `.portal-aktionen` die Reihenfolge Zurück → Vorschau neu laden → + Lieferant.
  - `GET /abgemeldet` ohne Session und eine 404-Fehlerseite ohne Session: Status wie heute, `container-xxl`, kein `portal-seitenleiste`, kein `seitenleiste-toggle` (Review Focus 3).
  - Kontierung mit offenem Aufsplitten-Modal: `GET` der Aufsplitten-View enthält kein `portal-kopf` und kein `<footer`.
- [ ] **Step 3: Run** `node --test test/integration/layoutSweep.test.js` → FAIL.
- [ ] **Step 4: Implement** Partials, CSS und JS. Alle 17 Portal-Views umstellen: Kopf bis einschliesslich `<main …>` durch `include('_seite_anfang', {...})` ersetzen, `</main>` bis `</html>` durch `include('_seite_ende')`. Seiteneigene Skripte bleiben, wo sie sind, also vor `_seite_ende`.
- [ ] **Step 5: Alte Tests umschreiben.** Die Absicht bleibt erhalten:
  - `app.test.js` „Hauptmenü …“: Aktiv-Markierung jetzt über `aria-current="page"` in Seitenleiste bzw. Reiter.
  - „Zurück rechts vom Menü“ / „+ Lieferant in der Navigationsleiste“: Reihenfolge jetzt innerhalb von `.portal-aktionen`.
  - `poolPage.test.js` „nav bar as centered container“: prüft jetzt `container-xxl`.
  - `poolPage.test.js` „reload button next to Menü“: prüft vorerst den Knopf in `.portal-aktionen`.
  - Alle `hauptmenue-toggle`-Prüfungen werden durch `portal-seitenleiste` ersetzt.
- [ ] **Step 6: Run** `npm test` → PASS.
- [ ] **Step 7: Manuell prüfen:** `npm run dev` und `/pool`, `/kontierung/:id`, `/spesen/neu`, `/zeitstempel-pruefen` öffnen, jeweils bei Breite 1400 px und 400 px, hell und dunkel. Seitenleiste, Offcanvas und Theme-Wechsel prüfen.
- [ ] **Step 8: Commit** `feat(layout): gemeinsames Grundgerüst für Portal-Seiten`

---

### Task 4: Admin-Seiten umstellen, alte Navigation entfernen

**Files:**
- Modify: alle 25 Views in `views/admin/`, `test/integration/layoutSweep.test.js` (auf `views/admin/` erweitern), Admin-Tests, die `nav-pills`/`_nav`-Markup prüfen (per `grep -rn "nav-link\|nav-pills" test`).
- Delete: `views/admin/_nav.ejs`, `views/_header.ejs`. Aus `src/middleware/nav.js` alle `res.locals`-Felder entfernen, die danach keine View mehr liest; per `grep -rn` in `views/` prüfen.

**Interfaces:**
- Consumes: `include('../_seite_anfang', { titel, rahmen: 'voll' })`, `include('../_seite_ende')` aus Task 3.

- [ ] **Step 1: Failing tests:**
  - `layoutSweep` erweitern: zusätzlich keine View mit `include('./_nav')`.
  - Render-Test: Superadmin auf `GET /admin/konten/neu` → `aria-current="page"` auf `/admin/konten`, Reiter „Admin“ aktiv, alle 4 Gruppenüberschriften vorhanden.
  - Render-Test: Person nur mit `mails_einsehen` auf `GET /admin/mails` → nur Überschrift „Betrieb“, Reiter „Admin“ vorhanden (Review Focus 1, end-to-end).
  - Render-Test: `GET /admin` (Dashboard) → Reiter „Admin“ aktiv, kein Seitenleisten-Punkt aktiv.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement:** 25 Views umstellen. `admin/vorgaenge-liste.ejs` verliert `container-fluid`. Die Partials löschen.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(layout): Admin-Seiten im Grundgerüst, alte Navigation entfernt`

---

### Task 5: Einheitlicher Seitenaufbau

**Files:**
- Modify: alle Views mit `rahmen: 'voll'` oder `'kompakt'`, `public/css/portal.css`, `test/integration/layoutSweep.test.js`.

**Interfaces:**
- Produces: CSS-Klassen `.seitenkopf` (Flex-Zeile: `h1.seitenkopf-titel` links, `.seitenkopf-aktionen` rechts, umbrechend) und `.filterzeile` (für GET-Filterformulare).

Regeln aus der Spec „Einheitlicher Seitenaufbau“:

- **Reihenfolge:** `.seitenkopf` → Meldungen (`.alert`) → `.filterzeile` → Inhalt.
- **Genau ein `h1`** pro Seite, nur im Seitenkopf. Bisherige `h1 class="h3"` (Kontierung, Freigabe usw.) werden zu `h1.seitenkopf-titel`; die Grösse kommt aus CSS.
- **Unterüberschriften:** einheitlich `h2.h5`.
- **Knöpfe:** Die Hauptaktion der Seite (z. B. „Neues Konto anlegen“, „Spesen einreichen“) steht in `.seitenkopf-aktionen` als `btn btn-primary btn-sm`. Alles andere ist `btn-outline-*`, eine primäre Aktion pro Bereich.
- **`/pool`:** Der Neu-laden-Knopf (`aria-label="Dashboard neu laden"`) wandert aus `.portal-aktionen` in `.seitenkopf-aktionen`.

- [ ] **Step 1: Failing sweep tests** (statisch):
  - Jede View mit `rahmen` `'voll'` oder `'kompakt'` enthält genau ein `<h1`, und das steht in einem Element mit `class="seitenkopf`.
  - Keine View enthält `<h1 class="h3"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** über alle Views.
- [ ] **Step 4:** Den Test „reload button“ in `poolPage.test.js` auf `.seitenkopf-aktionen` umstellen.
- [ ] **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Manuell prüfen:** 5 zufällige Admin-Seiten und 3 Portal-Seiten nebeneinander vergleichen. Titel, Hauptaktion und Meldungen müssen an derselben Stelle stehen.
- [ ] **Step 7: Commit** `style(layout): einheitlicher Seitenkopf, Meldungen und Filter`

---

### Task 6: Ansichtswahl (Cookie, Middleware, Umschalter)

**Files:**
- Create: `src/middleware/ansicht.js`, `views/_ansicht_umschalter.ejs`, `test/unit/ansicht.test.js`
- Modify: `src/app.js` (Middleware nach `cookieParser`, vor den Routern), `public/css/portal.css`

**Interfaces:**
- Produces:
  - `ANSICHT_SCHLUESSEL: Record<string, string>` mit `{ '/pool': 'pool', '/meine-spesen': 'meine-spesen', '/meine-abgeschlossenen': 'meine-abgeschlossenen', '/kreditkarte': 'kreditkarte', '/admin/vorgaenge': 'admin-vorgaenge', '/admin/abgelehnt': 'admin-abgelehnt', '/admin/altfaelle': 'admin-altfaelle' }`. Abgeglichen wird gegen den exakten Pfad ohne abschliessenden Slash.
  - `ansichtWahl() -> express middleware`. Ablauf:
    1. GET mit gültigem `?ansicht=tabelle|kacheln` auf einem Pfad mit Schlüssel → Cookie `ansicht_<schluessel>` setzen, `302` auf denselben Pfad mit allen übrigen Query-Parametern (Reihenfolge bleibt), dann Ende.
    2. Sonst: `res.locals.ansichtSchluessel` (oder `null`) und `res.locals.ansicht` setzen. Wert ist `'tabelle'`, `'kacheln'` oder `'auto'`: aus dem Cookie, `'auto'` ohne bzw. bei ungültigem Cookie.
    3. Ungültiger `ansicht`-Wert oder Pfad ohne Schlüssel → kein Cookie, kein Redirect, normal weiter.
  - `include('_ansicht_umschalter')` rendert nur, wenn `ansichtSchluessel` gesetzt ist. Zwei Links `?ansicht=tabelle` / `?ansicht=kacheln`, die aktuelle Query bleibt erhalten. Bei `'auto'` sind beide nicht gedrückt. Mit `aria-pressed`, Beschriftung „☰ Tabelle“ / „▦ Kacheln“. Der Umschalter steht in `.seitenkopf-aktionen`.
  - CSS-Konvention für Listen: Tabelle in `div.ansicht-tabelle`, Kacheln in `div.ansicht-kacheln`. Bei `'auto'` erhalten sie zusätzlich `d-none d-lg-block` bzw. `d-lg-none`. Bei `'tabelle'`/`'kacheln'` wird nur die gewählte gerendert.

- [ ] **Step 1: Failing tests** (Mini-Express-App mit `cookieParser` und `ansichtWahl`, eine Route gibt `res.locals` als JSON zurück):
  - `GET /admin/vorgaenge?status=kontierung&ansicht=kacheln&probleme=1` → 302, `Location` = `/admin/vorgaenge?status=kontierung&probleme=1`, `Set-Cookie` enthält `ansicht_admin-vorgaenge=kacheln`, `Path=/`, `Max-Age=31536000`, `SameSite=Lax`.
  - `GET /pool?ansicht=quatsch` → 200, kein `Set-Cookie`, `ansicht === 'auto'`.
  - `GET /admin/konten?ansicht=kacheln` → 200, kein `Set-Cookie`, `ansichtSchluessel === null`.
  - Cookie `ansicht_pool=kacheln` auf `GET /pool/` → `ansicht === 'kacheln'`.
  - Cookie `ansicht_pool=kaputt` → `'auto'`.
- [ ] **Step 2: Run** `node --test test/unit/ansicht.test.js` → FAIL.
- [ ] **Step 3: Implement** Middleware, Umschalter-Partial und CSS-Grundlage für Kacheln: Raster `row-cols-1 row-cols-sm-2 row-cols-lg-3 row-cols-xl-4`; Klassen `.kachel`, `.kachel-haengt` (roter Rand), `.kachel-ueberfaellig` (oranger Rand).
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(ansicht): Tabelle/Kacheln-Wahl pro Liste per Cookie`

---

### Task 7: Kacheln für Aufgaben (`/pool`)

**Files:**
- Create: `views/_job_aktionen.ejs`, `views/_job_kacheln.ejs`, `test/integration/kachelansicht.test.js`
- Modify: `views/_job_table.ejs` (Aktionszelle durch `include('_job_aktionen')` ersetzen), `views/pool.ejs` (Umschalter im Seitenkopf; jeder Abschnitt rendert Tabelle und/oder Kacheln gemäss `ansicht`; Inline-Skript)

**Interfaces:**
- Consumes: `ansicht`, `ansichtSchluessel` (Task 6), Konvention `div.ansicht-tabelle` / `div.ansicht-kacheln`.
- Produces: `include('_job_kacheln', { jobs, idPrefix, istPoolArtig?, kannZuweisen?, zielPersonen?, linkPrefix?, aktionLabel? })`, dieselben Parameter wie `_job_table`.

Regeln:

- **Kachelinhalt:**
  - Oben `img.thumbnail-preview.pdf-preview` mit denselben `data-job-id`/`data-preview-url` wie in der Tabelle; ohne Thumbnail der Text „Keine Vorschau“.
  - Titel: Kreditor (`job.lieferant`), sonst Absender, sonst „—“.
  - Darunter Quelle, Eingang und Konto bzw. Kontohinweis, mit denselben Ausdrücken wie in `_job_table.ejs`.
  - Unten `include('_job_aktionen')`.
- **Element-ID:** `<idPrefix>-kachel-<id>`. In der Tabelle bleibt `<idPrefix>-row-<id>`, damit es keine doppelten IDs gibt.
- **Container:** Jede Zeile und jede Kachel bekommt `data-job-container`.
- **Skript in `pool.ejs`:** `btn.closest('tr')` wird zu `btn.closest('[data-job-container]')`. Die Fehlermeldung ersetzt den Container durch ein Element desselben Typs: in der Tabelle `tr > td[colspan]`, in der Kachel `div.kachel` mit dem Text.

- [ ] **Step 1: Failing tests:**
  - `/pool` ohne Cookie mit 2 Pool-Jobs: Beide Ansichten sind vorhanden (`ansicht-tabelle d-none d-lg-block`, `ansicht-kacheln d-lg-none`). Alle `id="…"`-Werte im HTML sind eindeutig (Review Focus 4).
  - Mit Cookie `ansicht_pool=kacheln`: kein `<table`. Jede Kachel enthält `beanspruchen-btn` mit `data-job-id`. Bei `pool_zuweisen` enthält sie die `zuweisen-form` mit `<select name="personId">`.
  - Mit Cookie `ansicht_pool=tabelle`: kein `ansicht-kacheln`.
  - Paritätstest: Für einen Abschnitt mit `linkPrefix: '/kontierung'` enthalten Tabelle und Kachel dieselbe Menge an `href`- und `action`-Werten. Die Werte werden per Regex aus `div.ansicht-tabelle` bzw. `div.ansicht-kacheln` extrahiert, inklusive „In den Pool legen“ mit `_csrf`.
- [ ] **Step 2: Run** `node --test test/integration/kachelansicht.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → PASS. `poolPage.test.js` muss unverändert grün bleiben, weil die Tabelle im Auto-Modus weiter gerendert wird.
- [ ] **Step 5: Manuell prüfen:** `/pool` in beiden Ansichten. „Beanspruchen“ auf einen bereits vergebenen Job zeigt die Fehlermeldung in der Kachel. Ein Klick auf das Vorschaubild öffnet den PDF-Dialog.
- [ ] **Step 6: Commit** `feat(kacheln): Aufgaben als Kacheln`

---

### Task 8: Kacheln für die übrigen sechs Listen

**Files:**
- Create: `views/_abgeschlossen_kacheln.ejs`, `views/_spesen_meine_kacheln.ejs`, `views/_kk_beleg_kacheln.ejs`, `views/admin/_vorgaenge_kacheln.ejs`, `views/admin/_abgelehnt_kacheln.ejs`, `views/admin/_altfaelle_kacheln.ejs`
- Modify: `views/meine-abgeschlossenen.ejs`, `views/meine-spesen.ejs`, `views/kreditkarte.ejs`, `views/admin/vorgaenge-liste.ejs`, `views/admin/abgelehnt-liste.ejs`, `views/admin/altfaelle-liste.ejs`, `test/integration/kachelansicht.test.js`

**Interfaces:**
- Consumes: wie Task 7. Jede Kachel-Partial nimmt dieselben Daten wie ihre Tabellen-Partial bzw. ihre Tabellenschleife.

Regeln pro Liste:

- **Inhalte:** Jede Kachel zeigt alle Spalten ihrer Tabelle als Label/Wert-Zeilen, mit dem ersten inhaltlichen Feld als Titel:
  - `meine-abgeschlossenen`: Dateiname
  - `meine-spesen`: Verwendungszweck
  - `kreditkarte`: Beschreibung
  - `admin/vorgaenge`: Lieferant/Einreicher
  - `admin/abgelehnt`: Lieferant, sonst Dateiname
  - `admin/altfaelle`: Dateiname
- **Betrag** in der Kachel hervorgehoben (`fs-5`, `font-variant-numeric: tabular-nums`).
- **Aktionen:** alle Links und Formulare der Zeile.
- **`admin/vorgaenge`:**
  - `v.haengt` → `.kachel-haengt` plus Badge „hängt“.
  - `v.ueberfaellig` → `.kachel-ueberfaellig` plus Badge „überfällig“.
  - Kennzeichen-Badges, Zuständig mit „vertreten durch …“, Prognose Freigabe 2 mit Badge „Prognose“, „Umhängen“ nur bei `darfEingreifen`.
- **IDs:** Wo die Tabellenzeile eine `id` hat (`abgeschlossen-row-*`, `spesen-meine-row-*`), bekommt die Kachel `…-kachel-*`.
- **Umschalter** im Seitenkopf aller sechs Seiten. Die Filterzeile auf `admin/vorgaenge` bleibt über beiden Ansichten.

- [ ] **Step 1: Failing tests:** je Liste ein Test mit Cookie `=kacheln`. Er prüft, dass kein `<table` erscheint und die Kachel Titel, Betrag (falls vorhanden) und alle Aktions-`href`s der Tabellenansicht enthält (Paritäts-Helfer aus Task 7 wiederverwenden). Dazu:
  - `/admin/vorgaenge` mit einem hängenden Vorgang → `kachel-haengt` und Text „hängt“.
  - `/admin/vorgaenge?ansicht=kacheln&status=…` → Redirect behält `status`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(kacheln): Kacheln für Spesen, Abgeschlossene, Kreditkarte und Admin-Listen`

---

### Task 9: Doku nachziehen

**Files:**
- Modify: `README.md`, `docs/admin-bereich.md` und alle weiteren Dateien in `docs/`, die das „Menü“-Dropdown, die Admin-Linkleiste oder Menüpfade beschreiben (`grep -rln "Menü\|Admin-Navigation\|Menüpunkt" docs README.md`). Ausgenommen sind `docs/superpowers/`.

- [ ] **Step 1:** Navigationsbeschreibungen auf „Reiter Portal/Admin + Seitenleiste mit Gruppen“ umstellen. Pfadangaben im Stil „Admin → Stammdaten → Konten“. Die Kachelansicht mit den sieben Listen und der Cookie-Speicherung pro Gerät dokumentieren.
- [ ] **Step 2:** `grep -rn "Menü-Dropdown\|hauptmenue\|container-fluid" docs README.md` → keine Treffer ausser in historischen Plänen und Specs unter `docs/superpowers/`.
- [ ] **Step 3: Run** `npm test` → PASS.
- [ ] **Step 4: Commit** `docs: neue Navigation und Kachelansicht beschreiben`
