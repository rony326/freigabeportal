# Freigabeportal — Phase B: Admin-Bereich

Status: approved (Phase B only)
Datum: 2026-08-14

## Kontext

Phase A (Fundament & Auth) ist abgeschlossen und auf `master` gemerged: Express/SQLite-Skeleton,
ChurchTools-OAuth2-Login, Rollen-Ableitung aus Gruppen (`requireRole(config, role)`), Personen-Sync
(Webcron + JIT-Refresh), Mailer-Grundgerüst, `admin_config`-Key/Value-Store mit Seed-Defaults
(`reminder_stunden: '24'`, `eskalation_stunden: '48'`).

Phase B baut den geschützten Admin-Bereich: Konten-Verwaltung (die vier Freigabe-Rollen pro Konto
inkl. Hart-Validierung), Zuweisungsregeln (Lieferant/Absender → Konto) und die
Eskalationszeiten-Konfiguration. Ausserdem schliesst Phase B eine in Phase A offen gelassene
Anforderung: `ct_person_unresolved` soll "im Admin-Bereich als Warnung" sichtbar werden.
Zusätzlich liefert Phase B die visuelle Anpassbarkeit des Portals ans Corporate Design der
Kirchgemeinde (Logo, Farben) sowie einen Dark/Light-Modus mit Admin-Vorgabe und Nutzer-Umschalter.

### Phasenplan (Kontext, aus Phase A übernommen)

- Phase A – Fundament & Auth (abgeschlossen, gemerged)
- **Phase B – Admin-Bereich (dieses Dokument)**
- Phase C – n8n-Schnittstelle & Job-Datenmodell
- Phase D – Freigabe-Workflow-UI (inkl. tatsächlichem Versand von Reminder-/Eskalations-Mails)
- Phase E – Härtung & Deployment (inkl. Rate-Limiting)

## Architektur & Routing

- Neuer geschützter Bereich unter `/admin/*`, gated durch `requireRole(config, 'portal-admin')`
  (Phase A) als Middleware auf einem eigenen Admin-Router.
- Server-rendered EJS, gleiche Konvention wie Phase A: Formulare per POST + Server-Redirect,
  keine SPA, kein Build-Schritt.
- **Kein CSRF-Token-Mechanismus.** Die `sameSite: 'lax'`-Session-Cookie-Einstellung aus Phase A
  verhindert bereits, dass die Session-Cookie bei einer Cross-Site-POST-Navigation mitgeschickt
  wird — ausreichender Basisschutz für die kleine Zahl interner Admin-Nutzer. Ein zusätzlicher
  CSRF-Token-Layer wäre für diesen Anwendungsfall Overengineering (YAGNI).
- Dateistruktur:
  ```
  src/routes/admin/
    konten.js
    zuweisungsregeln.js
    eskalation.js
    erscheinungsbild.js
    personen.js         -- read-only
  src/routes/
    branding.js          -- GET /branding/logo (öffentlich, kein Admin-Gate)
  src/db/
    kontenRepo.js
    zuweisungsregelnRepo.js
  src/middleware/
    branding.js           -- loadBranding(db), global gemountet
  views/
    _header.ejs            -- gemeinsames Partial: Logo, Farb-/Theme-Style-Block, Umschalter
  views/admin/
    _nav.ejs             -- gemeinsame Navigation, per EJS-Include eingebunden
    konten-liste.ejs
    konten-form.ejs
    zuweisungsregeln-liste.ejs
    zuweisungsregeln-form.ejs
    eskalation-form.ejs
    erscheinungsbild-form.ejs
    personen-liste.ejs
  ```
  Die fünf Admin-Router werden in `src/app.js` unter `/admin` gemountet, hinter der
  `requireRole(config, 'portal-admin')`-Middleware. `loadBranding(db)` und die öffentliche
  `GET /branding/logo`-Route werden **global** gemountet (auch Login-Seite, Startseite und
  Fehlerseiten brauchen Logo/Farben/Theme).
- Neue Abhängigkeit: `multer` (reines JS, keine native Kompilierung) für den
  Multipart-Datei-Upload des Logos.

### Rechteprüfung: ausschliesslich serverseitig, kein Bypass über direkten URL-Zugriff

Die Autorisierung ist **rein serverseitig** und greift auf jeder einzelnen Route — nicht nur auf
Navigations-/Menü-Ebene. Konkret:

- `requireRole(config, 'portal-admin')` wird als Middleware auf den **gemeinsamen `/admin`-Router**
  gemountet (`app.use('/admin', requireRole(config, 'portal-admin'), adminRouter)`), sodass
  **jede** Methode, jede Route und jeder Sub-Pfad unter `/admin/*` die Prüfung durchläuft, bevor
  auch nur ein Route-Handler erreicht wird — inklusive GET-Listen, GET-Formulare, POST-Anlegen,
  POST-Bearbeiten, POST-Deaktivieren/Löschen. Es gibt keinen Pfad unter `/admin/*`, der die
  Middleware umgehen könnte, und keine Admin-Funktionalität, die sich allein auf verstecktes
  UI (z.B. ausgeblendete Menüpunkte) statt auf eine serverseitige Prüfung verlässt.
- Die Prüfung erfolgt bei **jedem Request neu** anhand der aktuell in `personen.gruppen`
  gespeicherten Gruppenzugehörigkeit (siehe Phase A: keine Rollen-Caching in der Session) — ein
  Admin, dem die "Portal-Admin"-Gruppenmitgliedschaft entzogen wird, verliert den Zugriff ab dem
  nächsten Request, unabhängig von einer weiterhin gültigen Session.
- Ein direkter POST an z.B. `/admin/konten` (ohne je die Liste oder das Formular geladen zu
  haben) wird exakt gleich behandelt wie ein GET auf `/admin/konten` — beide durchlaufen dieselbe
  Middleware, beide erhalten ohne gültige Portal-Admin-Session ein 403 mit deutscher Fehlerseite,
  nie eine 200-Antwort mit Daten oder eine erfolgreiche Zustandsänderung.
- Tests (siehe Abschnitt "Tests") decken explizit jede einzelne Route-Methode-Kombination ab, nicht
  nur eine repräsentative Stichprobe — siehe dort.

## Datenmodell

```sql
CREATE TABLE konten (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kontonummer TEXT NOT NULL,
  bezeichnung TEXT NOT NULL,
  freigeber1_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  stellvertreter1_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  freigeber2_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  stellvertreter2_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  aktiv INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE zuweisungsregeln (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  absender_muster TEXT NOT NULL UNIQUE,
  konto_id INTEGER NOT NULL REFERENCES konten(id)
);
```

`admin_config` (Phase A, generischer Key/Value-Store) bekommt einen weiteren Key:
`eskalation_fallback_email` (Freitext-E-Mail-Adresse, kein Verweis auf `personen` — die
Fallback-Instanz muss keine synchronisierte ChurchTools-Person sein, z.B. eine Funktionsadresse
wie `kirchenpflege@musterkirche.ch`).

Beide neuen Tabellen werden in `src/db/schema.sql` ergänzt (`CREATE TABLE IF NOT EXISTS`, wie
die bestehenden Tabellen).

### Validierung Konten (hart, serverseitig, bei Anlegen UND Bearbeiten)

- Alle vier Rollen (`freigeber1_id`, `stellvertreter1_id`, `freigeber2_id`,
  `stellvertreter2_id`) sind Pflichtfelder.
- Alle vier müssen **paarweise verschiedene** Personen sein (nicht nur `freigeber1 !=
  freigeber2` wie im Lastenheft wörtlich gefordert, sondern strenger: keine der vier Rollen darf
  mit einer anderen übereinstimmen). Begründung: verhindert, dass eine Person z.B. als
  `freigeber1` UND `stellvertreter2` eingetragen ist und so im Interessenskonflikt-Fall beide
  Seiten der Freigabe abdecken könnte — das würde das Vier-Augen-Prinzip stillschweigend
  aushebeln, genau der in Abschnitt 9 des Lastenhefts benannte Fallstrick.
- Alle vier referenzierten Personen müssen `aktiv = 1` sein.
- Bei Verstoss: Formular wird mit den bisherigen Eingaben und einer deutschen Fehlermeldung neu
  gerendert (kein Redirect, keine verlorenen Eingaben).

### Zuweisungsregeln

- `absender_muster`: Freitext — entweder eine volle E-Mail-Adresse (`rechnungen@lieferant.ch`)
  oder eine nackte Domain (`lieferant.ch`). Die UI zeigt einen Hinweistext zum erlaubten Format;
  serverseitig wird nur auf Nicht-Leerheit und Eindeutigkeit geprüft (die tatsächliche
  Absender→Muster-Matching-Logik gehört zu Phase C, wenn Rechnungen real ankommen).
- `UNIQUE`-Constraint auf `absender_muster` verhindert doppelte Regeln.
- `konto_id`-Dropdown zeigt nur aktive Konten.

## Erscheinungsbild: Logo, Farben, Dark/Light Mode

### Speicherung

- Zwei neue `admin_config`-Keys für Farben: `branding_farbe_primaer`, `branding_farbe_sekundaer`
  (Hex-Format `^#[0-9A-Fa-f]{6}$`), vorgeseedet mit neutralen Default-Werten bis der Admin die
  echten CI-Farben einträgt.
- Ein neuer `admin_config`-Key für den Farbmodus: `branding_theme_default` mit den Werten `hell`,
  `dunkel` oder `system` (Default: `system`).
- Logo: Datei-Upload via `multer`, gespeichert unter `data/branding/logo.<ext>` (gitignored, wie
  die SQLite-DB). Bei jedem neuen Upload wird die vorherige Datei ersetzt. Pfad und Mimetype
  werden in `admin_config` (`branding_logo_pfad`, `branding_logo_mimetype`) vermerkt.
  **Nur PNG/JPEG erlaubt, kein SVG** — bewusste Vereinfachung, die jede Diskussion über
  SVG-Script-Injection von vornherein vermeidet und praktisch jedes Kirchen-Logo abdeckt.
  Max. Dateigrösse 2 MB, serverseitige Mimetype-Prüfung (nicht nur Dateiendung).

### Ausgabe (gilt global, nicht nur im Admin-Bereich)

- `GET /branding/logo` liefert die Logo-Datei mit korrektem `Content-Type` aus; ohne
  konfiguriertes Logo → 404, Header-Partial zeigt dann nur den Gemeinde-Namen als Text-Fallback.
  Diese Route ist bewusst **nicht** hinter `requireRole` — das Logo muss auch auf der
  Login-Seite sichtbar sein, bevor überhaupt eine Session existiert.
- `middleware/branding.js` (`loadBranding(db)`) wird **global** in `src/app.js` gemountet (vor
  allen Routern) und setzt auf jedem Request `res.locals.branding = { primaryColor,
  secondaryColor, hasLogo, themeAttr }`.
- **Rangfolge für `themeAttr`** (serverseitig ausgewertet, verhindert Flackern beim Laden):
  1. Nutzer-Cookie `theme` (Werte `hell`/`dunkel`, nicht-httpOnly, `sameSite=lax`, langlebig,
     unabhängig von der Login-Session) gesetzt → dessen Wert gilt, immer stärker als die
     Admin-Vorgabe.
  2. Sonst `admin_config`-Wert `branding_theme_default` = `hell`/`dunkel` → gilt für alle ohne
     eigene Wahl.
  3. Sonst (`system`, oder kein Cookie und kein expliziter Admin-Default) → `themeAttr` ist
     `null`, keine feste Vorgabe; CSS `prefers-color-scheme` entscheidet rein clientseitig
     anhand der Geräteeinstellung.
- `views/_header.ejs` setzt `data-theme="<%= branding.themeAttr %>"` auf `<html>` nur wenn
  `themeAttr` nicht `null` ist, sowie einen `<style>`-Block mit den Farb-Custom-Properties
  (`--brand-primary`, `--brand-secondary`). CSS-Tokens werden auf `:root` definiert, unter
  `[data-theme="dunkel"]` und unter `prefers-color-scheme: dark` (geguarded durch
  `:not([data-theme="hell"])`) überschrieben — ein expliziter Hell-Wunsch gewinnt auch bei
  dunklem System-Theme.
- Kleiner Umschalt-Button im Header (minimales Vanilla-JS, kein Framework, konsistent mit der
  Phase-A-Entscheidung gegen ein Frontend-Framework): flippt `data-theme` sofort im DOM und
  schreibt den `theme`-Cookie.
- `views/_header.ejs` wird in alle bestehenden Views eingebunden (`home.ejs`, `error.ejs`) sowie
  in alle neuen Admin-Views — spätere Phasen (C/D) erben Branding/Theme automatisch, sobald sie
  dasselbe Partial verwenden.

### Admin-UI

- Neue Route `/admin/erscheinungsbild`: Formular mit zwei Farbfeldern (`<input type="color">` +
  Hex-Textfeld als Fallback), einem Dropdown "Standard-Farbmodus" (Hell / Dunkel / Folgt
  Geräteeinstellung) und einem Datei-Upload-Feld mit Vorschau des aktuellen Logos.
- Validierung: Hex-Format für Farben, gültiger Wert für den Theme-Default, Mimetype/Grösse fürs
  Logo — bei Fehler wird das Formular mit Fehlermeldung neu gerendert, bestehende
  Farben/Theme/Logo bleiben unangetastet.
- Gleiche serverseitige `requireRole(config, 'portal-admin')`-Absicherung wie die übrigen
  Admin-Routen (siehe Abschnitt "Rechteprüfung" oben) — `GET /branding/logo` ist die einzige
  Ausnahme, absichtlich öffentlich.

## Personen-Übersicht (read-only)

Schliesst eine in Phase A offen gelassene Anforderung: `ct_person_unresolved` soll admin-sichtbar
sein statt stillem Datenverlust. `/admin/personen` zeigt eine read-only Liste aller
synchronisierten Personen: Name, E-Mail, Status (aktiv/inaktiv), und eine auffällige Warnung bei
`ct_person_unresolved = true`. Keine Bearbeitung — Personendaten kommen ausschliesslich aus dem
Sync (Phase A); dieser Screen ist reine Diagnose-/Warnfläche für den Admin.

## CRUD-Umfang

- **Konten**: Liste (Default nur aktive, Filter-Toggle für inaktive), Anlegen, Bearbeiten,
  Deaktivieren. **Kein Hard-Delete** — spätere Rechnungen (Phase C/D) referenzieren `konto_id`
  per Fremdschlüssel; ein gelöschtes Konto würde den Audit-Trail alter Freigaben beschädigen.
  Deaktivierte Konten bleiben in der DB, verschwinden aber aus Dropdowns (Zuweisungsregeln) und
  der Standard-Kontenliste.
- **Zuweisungsregeln**: Liste, Anlegen, Bearbeiten, **echtes Löschen erlaubt** (reine
  Routing-Regel ohne Audit-Bezug, kein Fremdschlüssel zeigt auf sie).
- **Eskalationszeiten**: Ein Formular mit drei Feldern (`reminder_stunden`, `eskalation_stunden`,
  `eskalation_fallback_email`), liest/schreibt direkt über die generischen `admin_config`-Helper
  aus Phase A (`getConfigValue`/`setConfigValue`). `reminder_stunden`/`eskalation_stunden` werden
  als positive Ganzzahlen validiert; `eskalation_fallback_email` auf ein plausibles
  E-Mail-Format (einfache Regex-Prüfung, kein Mailversand-Test).
- **Erscheinungsbild**: Ein Formular für Farben, Theme-Default und Logo-Upload (siehe Abschnitt
  "Erscheinungsbild: Logo, Farben, Dark/Light Mode" oben). Liest/schreibt ebenfalls über die
  `admin_config`-Helper, das Logo zusätzlich als Datei unter `data/branding/`.

## Fehlerbehandlung

- Zugriff auf `/admin/*` ohne "Portal-Admin"-Gruppenzugehörigkeit → 403, deutsche Fehlerseite
  (bestehende `requireRole`-Middleware aus Phase A, unverändert).
- Validierungsfehler (Konten-Vier-Rollen-Check, Zuweisungsregel-Duplikat, ungültige
  Eskalationszeiten) → Formular wird mit Fehlermeldung und den bisherigen Eingaben neu gerendert,
  kein Datenverlust.
- Referenzierte `konto_id`/`churchtools_person_id` existiert nicht mehr (z.B. Race Condition
  durch parallele Bearbeitung) → generische deutsche Fehlerseite (zentrale Error-Middleware aus
  Phase A greift).
- Logo-Upload mit falschem Mimetype oder zu grosser Datei → Formular mit deutscher
  Fehlermeldung neu gerendert, bestehendes Logo bleibt unverändert (kein Teil-Upload).

## Tests

Gleiches Muster wie Phase A: reale HTTP-Requests via `supertest` gegen eine reale In-Memory-SQLite-DB,
keine Mocks der eigenen Business-Logik. Schwerpunkte:

- Vier-Rollen-Validierung: alle Verstoss-Kombinationen (Pflichtfeld fehlt, zwei Rollen identisch,
  referenzierte Person inaktiv) werden abgelehnt; eine gültige Kombination wird akzeptiert.
- Zuweisungsregeln-Uniqueness (Duplikat wird abgelehnt).
- Zugriffsschutz: 403 ohne "Portal-Admin"-Gruppe für **jede einzelne Route-Methode-Kombination**
  unter `/admin/*` (nicht nur stichprobenartig eine pro Bereich) — jede GET-Liste, jedes
  GET-Formular, jedes POST-Anlegen/-Bearbeiten/-Deaktivieren/-Löschen in allen vier Bereichen
  (Konten, Zuweisungsregeln, Eskalation, Personen-Übersicht). Zusätzlich: ein direkter POST ohne
  vorheriges Laden der zugehörigen Seite verhält sich identisch (403, keine Zustandsänderung) —
  es gibt keinen Pfad, der die Middleware umgeht.
- Deaktivierte Konten und inaktive Personen verschwinden aus den jeweiligen Dropdowns/Listen,
  bleiben aber über direkten DB-Zugriff auffindbar (Audit-Trail-Erhalt).
- `ct_person_unresolved = true` wird auf `/admin/personen` sichtbar dargestellt.
- Eskalationszeiten-Formular: gültige Werte werden persistiert und beim erneuten Laden
  vorausgefüllt angezeigt; ungültige Werte (negative Zahl, kaputte E-Mail) werden abgelehnt.
- Erscheinungsbild: gültige Hex-Farben und Theme-Default-Werte werden persistiert; ungültige
  Werte abgelehnt. Logo-Upload: gültiger PNG/JPEG-Upload wird gespeichert und über
  `GET /branding/logo` mit korrektem `Content-Type` wieder ausgeliefert; zu grosse Datei oder
  falscher Mimetype (z.B. `.exe` mit vorgetäuschter Endung) wird abgelehnt, bestehendes Logo
  bleibt bestehen.
- Theme-Rangfolge: Für alle drei Admin-Default-Werte (`hell`/`dunkel`/`system`) und mit/ohne
  gesetztem `theme`-Cookie wird per supertest die tatsächlich gerenderte `data-theme`-Ausgabe
  (vorhanden mit korrektem Wert, oder bewusst abwesend bei `system` ohne Cookie) geprüft — inkl.
  des Falls, dass ein Nutzer-Cookie einen abweichenden Admin-Default überstimmt.

## Nicht Teil von Phase B

Job-Datenmodell, n8n-Schnittstelle, tatsächlicher Versand von Reminder-/Eskalations-Mails (nur
die Konfiguration dafür entsteht hier — das Versenden ist Teil von Phase D, sobald Jobs
existieren), PDF-Verarbeitung, Freigabe-Workflow-UI, Rate-Limiting (Phase E). Die tatsächliche
Absender→Zuweisungsregel-Matching-Logik (Domain- vs. Exakt-Treffer-Priorität) gehört ebenfalls zu
Phase C, wenn eingehende Rechnungen real verarbeitet werden — Phase B liefert nur die
Datenpflege-UI dafür. Das clientseitige Umschalt-Verhalten des Dark/Light-Buttons selbst (DOM-
Manipulation, Cookie-Schreiben im Browser) ist wie in Phase A kein Teil der automatisierten
Node-Test-Suite — kein Browser-/E2E-Test in dieser Phase; getestet wird die serverseitige
Rangfolge-Logik, die den initialen Zustand liefert.
