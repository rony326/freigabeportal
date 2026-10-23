# Einheitliches Layout, Seitenleisten-Navigation und Kachelansicht

Stand: 2026-10-23 · Status: Entwurf zur Freigabe

Visueller Entwurf (von Rony abgenommen): https://claude.ai/artifact/ToeuNW2xAnq6C54sXhFaes
Abschnitte 1–4 dort entsprechen den Abschnitten „Benutzerbereich“, „Admin-Bereich“,
„Seiten mit PDF-Vorschau“ und „Kacheln oder Tabelle“ unten.

## Warum

Das Portal wirkt „zusammengebastelt“. Es gibt zwei Navigationssysteme
nebeneinander: das „Menü“-Dropdown im Header und darunter 18 lose Admin-Links
(`views/admin/_nav.ejs`) ohne Gruppierung und ohne Markierung der aktuellen
Seite. Dazu kommen uneinheitliche Breiten: 36 Seiten nutzen `container`,
6 Seiten `container-fluid`. Betroffen sind Pool, Kontierung, Freigabe 2,
Spesen-Freigabe 1, KK-Abgleich und Admin → Laufende Vorgänge. Menü und Inhalt
springen deshalb beim Seitenwechsel an andere Stellen, und auf breiten Monitoren
ziehen sich Tabellen über mehr als 2000 px.

Ziel ist eine bessere Oberfläche und Bedienbarkeit: ein Grundgerüst, eine
Navigation und eine Breite für alle Seiten. Zusätzlich soll jede Person selbst
wählen können, ob Beleg- und Vorgangslisten als Tabelle oder als Kacheln
erscheinen.

## Ziele

1. Jede Seite hat dasselbe Grundgerüst: obere Leiste, Seitenleiste links,
   Inhalt rechts, Footer.
2. Jede Seite hat dieselbe äussere Breite: max. 1320 px, zentriert
   (Bootstrap `container-xxl`).
3. Die Navigation zeigt immer, wo man ist (aktive Seite markiert) und ist nach
   Themen gruppiert.
4. Seitenkopf, Aktionsknöpfe, Filter, Erfolgs- und Fehlermeldungen sind auf allen
   Seiten gleich angeordnet.
5. Auf ausgewählten Listen kann die Ansicht zwischen Tabelle und Kacheln
   umgeschaltet werden.
6. Das Layout funktioniert auch auf dem Handy.

## Nicht-Ziele

- Keine neuen Funktionen, Routen, Rechte oder Workflow-Änderungen. Das ist ein
  reiner Umbau der Oberfläche.
- Kein Wechsel weg von Bootstrap 5.3 und EJS, keine Build-Pipeline, kein
  Frontend-Framework.
- Kein neues Farbschema. Die Branding-Farben aus „Erscheinungsbild“ gelten weiter.
- Keine Kachelansicht für Protokoll- und Einstellungslisten (siehe unten).

## Was es nicht werden darf (Anti-Ziele)

- Es fehlt danach ein Menüpunkt, den jemand vorher hatte, oder es erscheint
  einer, den er nicht sehen darf.
- PDF-Vorschau und Formular auf Kontierung oder Freigabe werden so eng, dass das
  Arbeiten schlechter wird als heute.
- Ein Teil der Seiten ist umgebaut und der Rest nicht, sodass es noch
  uneinheitlicher wirkt. Jede Etappe muss für sich ein konsistentes Ergebnis
  liefern.
- Die Kachelansicht zeigt weniger oder andere Aktionen als die Tabellenzeile.

## Grundgerüst

### Obere Leiste (alle Seiten)

Von links nach rechts:

- **Logo.** Die Logo-Ausrichtung aus „Erscheinungsbild“ (`links`/`mitte`/`rechts`)
  gilt weiter innerhalb dieser Leiste. Ohne Logo steht dort der Seitentitel aus
  dem Branding.
- **Bereichsreiter:** „Portal“ und „Admin“. „Admin“ erscheint nur, wenn die
  Person mindestens eine Admin-Seite sehen darf (heutige Logik
  `navHatAdminZugang`). Der Reiter des aktuellen Bereichs ist markiert. Alles
  unter `/admin` gehört zu „Admin“, alles andere zu „Portal“.
- **Rechts:** „Angemeldet als …“, Farbmodus-Knopf, Abmelden. Das Verhalten bleibt
  wie heute, einschliesslich der Theme-Cookie-Logik und des
  Theme-Vorab-Skripts in `_header.ejs`.

### Seitenleiste links

Sie zeigt die Seiten des aktuellen Bereichs, in Gruppen mit kleinen
Überschriften. Die aktuelle Seite ist markiert, auch auf Unterseiten (z. B. ist
`/admin/konten/neu` unter „Konten“ markiert). Jeder Punkt erscheint nur, wenn er
heute auch erscheint, mit denselben Bedingungen.

**Portal:**

| Gruppe | Punkte | Bedingung wie heute |
|---|---|---|
| Arbeit | Aufgaben (`/pool`) | eingeloggt |
| Spesen | Spesen einreichen, Meine Spesen | „Spesen einreichen“ nur bei aktivem Spesenmodul |
| Belege | Abgeschlossene Rechnungen, Kreditkartenbelege | Kreditkartenbelege nur bei `zeigeKreditkarteNav` |
| Persönlich | Ferienmodus, Zeitstempel prüfen | eingeloggt |

**Admin:**

| Gruppe | Punkte (Schlüssel in `adminNav`) |
|---|---|
| Vorgänge | Laufende Vorgänge (`vorgaenge`), Abgelehnte Rechnungen (`abgelehnt`), Altfälle (`altfaelle`) |
| Stammdaten | Konten (`konten`), Kreditoren (`kreditoren`), Kreditkarten (`kreditkarten`), Personen (`personen`) |
| Einstellungen | Eskalationszeiten (`eskalation`), Mail-Einstellungen (`mailEinstellungen`), Erscheinungsbild (`erscheinungsbild`), Module (`module`), Zeitstempel (`zeitstempel`) |
| Betrieb | Datenbank-Backup (`backup`), Datei-Quarantäne (`backup`), Mail-Protokoll (`mails`), Sync-Übersicht (`sync`), Geplante Jobs (`geplanteJobs`), Audit-Log (`auditLog`) |

Eine Gruppe ohne sichtbare Punkte wird ganz ausgeblendet. Die Admin-Startseite
`/admin` (`views/admin/dashboard.ejs`) bleibt erreichbar, z. B. über einen Klick
auf den Reiter „Admin“.

**Zähler (Badges):** „Aufgaben“ zeigt die Zahl der persönlich offenen Aufgaben.
Das ist die Summe der Einträge in den persönlichen Abschnitten der Pool-Seite:
eigene offene Kontierungen, eigene Freigaben, eigene Spesen-Freigaben. Der
allgemeine Pool zählt nicht mit. Ohne offene Aufgaben wird kein Zähler gezeigt.
Ein Zähler bei „Kreditkartenbelege“ (offene Vorab-Belege bzw. offene
Abgleiche) ist erwünscht, wenn er sich mit einer einfachen Abfrage ermitteln
lässt. Andernfalls entfällt er. *(Entscheidung von Claude)*

### Breite und Inhalt

- Ein gemeinsamer Wrapper `container-xxl` für obere Leiste, Seitenleiste+Inhalt
  und Footer, auf **allen** Seiten. Alle `container-fluid`-Varianten und der
  Parameter `navContainerClass` entfallen.
- Seitenleiste ca. 200–220 px breit, der Inhalt nimmt den Rest.
- Breite Tabellen scrollen innerhalb ihres Bereichs (`table-responsive`, wie
  heute), nie die ganze Seite.

### Seiten mit PDF-Vorschau

Betroffen: Kontierung, Kontierung-Aufsplitten, Freigabe 2, Spesen-Freigabe 1,
KK-Abgleich. Dort ist die Seitenleiste standardmässig auf eine schmale
Symbolleiste (ca. 44 px) eingeklappt. Jedes Symbol hat einen Tooltip und ein
`aria-label`. Dadurch behalten PDF und Formular fast die ganze Breite des
gemeinsamen 1320-px-Rahmens. Die heutigen Zusatzknöpfe „← Zurück“,
„Vorschau neu laden“ und „+ Lieferant“ wandern aus der Navigationszeile in eine
Aktionszeile über dem Seiteninhalt. Ihre Reihenfolge bleibt erhalten.

### Handy (< 992 px, Bootstrap `lg`)

Die Seitenleiste verschwindet hinter einem „☰“-Knopf in der oberen Leiste und
öffnet sich als Bootstrap-Offcanvas. Die Bereichsreiter bleiben sichtbar. Die
eingeklappte Symbolleiste der PDF-Seiten entfällt auf dem Handy ebenfalls
zugunsten des ☰-Knopfs.

### Einheitlicher Seitenaufbau

Jede Seite folgt derselben Reihenfolge:

1. Seitentitel (`h1`, einheitliche Grösse), rechts daneben die Hauptaktion der
   Seite (z. B. „Neues Konto anlegen“) und, wo vorhanden, der
   Tabelle/Kacheln-Umschalter
2. Erfolgs- und Fehlermeldungen
3. Filter (einheitliche Filterzeile)
4. Inhalt

Unterüberschriften innerhalb einer Seite (z. B. die Abschnitte im Pool)
bekommen eine einheitliche Stufe. Knopfgrössen und Knopfvarianten werden
vereinheitlicht: eine primäre Aktion pro Bereich, alles andere „outline“.

## Kacheln oder Tabelle

### Wo es den Umschalter gibt

Nur auf Listen mit Belegen oder Vorgängen:

- Aufgaben (`/pool`), für jeden Abschnitt (Pool, Rückläufer, eskalierte Fälle,
  eigene Kontierungen, Freigaben, Spesen-Freigaben, abgelehnte Jobs)
- Meine Spesen
- Abgeschlossene Rechnungen
- Kreditkartenbelege
- Admin → Laufende Vorgänge
- Admin → Abgelehnte Rechnungen
- Admin → Altfälle

Alle anderen Listen bleiben Tabellen, zum Beispiel Konten, Kreditoren,
Personen, Mail-Protokoll, Audit-Log, Geplante Jobs, Sync, Backup und Quarantäne.

### Wie eine Kachel aussieht

- Kacheln stehen im Raster, je nach Breite 1–4 Spalten.
- **Belege mit Vorschaubild** (Pool-Abschnitte, Abgeschlossene, Kreditkarte,
  Meine Spesen): oben das Vorschaubild. Ein Klick öffnet die PDF-Vorschau wie
  heute (`.pdf-preview`). Darunter folgen Lieferant/Einreicher als Titel, der
  Betrag hervorgehoben, dann Quelle, Eingang und Konto bzw. Kontohinweis. Unten
  stehen Status und Aktionen.
- **Admin-Vorgänge:** ohne Bild. Titel Lieferant/Einreicher, Art, Betrag,
  Status mit allen Kennzeichen, „seit“, Zuständig (mit Vertretung),
  voraussichtliche Freigabe 2, „Umhängen“.
- Jede Kachel enthält **alle** Angaben und **alle** Aktionen der
  Tabellenzeile, auch Formulare wie „Beanspruchen“, „An Person senden“ und
  „In den Pool legen“. Ebenso Hinweise wie die Rückläufer-Bemerkung.
- Hängende Fälle bekommen einen roten Rand, überfällige einen orangen. Das
  ersetzt die heutigen eingefärbten Tabellenzeilen (`table-danger`,
  `table-warning`). Zusätzlich steht der Status als Badge in der Kachel, damit
  die Information nicht nur über Farbe läuft.

### Wie die Wahl gespeichert wird

- Die Wahl gilt **pro Liste**: Ein Schlüssel pro Seite, z. B. `pool`,
  `meine-spesen`, `admin-vorgaenge`. Die Abschnitte auf `/pool` teilen sich einen
  Schlüssel.
- Sie wird **pro Gerät** in einem Cookie gespeichert, analog zum Theme-Cookie
  (`path=/`, 1 Jahr, `samesite=lax`). Der Server liest den Cookie und rendert
  direkt die gewählte Ansicht, damit nichts flackert.
- **Ohne gespeicherte Wahl** zeigt ein grosser Bildschirm (≥ `lg`) die Tabelle,
  ein kleiner die Kacheln. Die Weiche läuft per Skript beim ersten Besuch, oder
  beide Varianten werden gerendert und per CSS gewählt. Das entscheidet der
  Umsetzer.
- Der Umschalter ist eine Bootstrap-Button-Gruppe „☰ Tabelle | ▦ Kacheln“ mit
  `aria-pressed`. Er funktioniert auch ohne JavaScript, als Link mit
  Query-Parameter, der den Cookie setzt. *(Entscheidung von Claude)*

## Rahmenbedingungen

- **CSP:** `src/app.js` erlaubt heute Inline-Skripte und `style=""`. Neue
  Skripte möglichst als Datei unter `public/`, damit eine spätere Nonce-CSP
  nicht schwerer wird.
- **CSRF:** Alle Formulare in Kacheln brauchen weiterhin das `_csrf`-Feld.
  `csrfSweep.test.js` muss grün bleiben.
- **Dark Mode und Branding:** Alles muss mit hell/dunkel/System und mit den
  Branding-Farben (`_brand_styles.ejs`) funktionieren. Aktive Markierungen und
  Primärknöpfe nutzen `--brand-primary`.
- **Bootstrap** wird heute doppelt geladen (in jeder Seite und in
  `_header.ejs`). Beim Umbau nur noch einmal laden.
- **Tests:** `test/integration/app.test.js` prüft heute das „Menü“-Dropdown und
  die Reihenfolge Menü → Zurück → + Lieferant. Diese Tests werden auf die neue
  Struktur umgeschrieben, nicht gelöscht: Die Absicht (Knöpfe vorhanden, in
  dieser Reihenfolge) bleibt bestehen. Neu kommen Tests dazu für die
  Sichtbarkeit jedes Seitenleisten-Punkts pro Recht, die aktive Markierung,
  den Umschalter samt Cookie und dafür, dass Kachel und Tabelle dieselben
  Aktionen enthalten.
- **Doku:** `docs/` (u. a. `admin-bereich.md`) und README beschreiben
  Navigation und Menüpunkte. Sie werden mitgezogen, wie für Routen- und
  Rollenänderungen vereinbart.
- **Seiten ohne Anmeldung** (`abgemeldet.ejs`, `error.ejs` ohne Session)
  bekommen das Grundgerüst ohne Seitenleiste und ohne Bereichsreiter, aber mit
  derselben Breite.

## Etappen

Jede Etappe ist für sich auslieferbar und lässt das Portal einheitlich
aussehen.

1. **Grundgerüst und Navigation:** gemeinsames Layout-Partial (obere Leiste,
   Seitenleiste, Wrapper, Footer), Navigationsdaten zentral in
   `src/middleware/nav.js`, alle Seiten auf `container-xxl` umstellen,
   `_nav.ejs` und das Menü-Dropdown entfernen, Symbolleiste auf PDF-Seiten,
   Handy-Offcanvas, Zähler.
2. **Seiten vereinheitlichen:** Seitenkopf, Aktionen, Meldungen, Filter,
   Knöpfe auf allen Seiten nach dem einheitlichen Seitenaufbau.
3. **Kacheln:** Umschalter, Cookie, Kachel-Partials für Belege und Vorgänge auf
   den sieben Listen.

## Dem Umsetzer überlassen

- Ob das Layout als gemeinsames „Rahmen“-Partial (Kopf + Fuss) in jede Seite
  eingebunden wird oder über ein Layout-Muster in EJS. Hauptsache, keine Seite
  dupliziert danach noch das `<head>`/Header-Markup.
- Die genaue Wahl der Symbole für die eingeklappte Leiste.
- Feinheiten von Abständen und Typografie, solange sie überall gleich sind.
- Wie die Zähler technisch berechnet werden, solange pro Seitenaufruf keine
  spürbare Last entsteht.
