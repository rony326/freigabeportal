# Phase F – UI-Modernisierung — Design

## Kontext & Phasenplan

Phase E (Härtung & Deployment) ist abgeschlossen: E1 (Rate-Limiting), E2
(vierteiliger Security-Review-Pass) und E3 (Infomaniak-Deployment, inkl.
Live-Gang und Behebung mehrerer ChurchTools-Integrationsfehler, die erst im
echten Betrieb sichtbar wurden) sind gemerged bzw. live. Das Portal läuft
produktiv unter `https://portal.example.org`.

Phase F ist rein UI-fokussiert: die bestehenden EJS-Views sind funktional
vollständig, aber komplett unstyled (kein eigenes CSS-Framework, nur eine
Handvoll CSS-Variablen in `_header.ejs` für Marken-Farben und Darkmode).
Nutzer-Feedback: "kommt bisher altbaken rüber". Diese Phase bringt ein
konsistentes, professionelles Erscheinungsbild — keine Routen-, Auth- oder
Datenmodell-Änderungen ausserhalb der explizit unten genannten Punkte.

**Technologie-Entscheidung** (im Chat besprochen, Trade-offs zwischen
Angular/React/Bootstrap/handgeschriebenem CSS abgewogen): **Bootstrap**,
selbst gehostet (keine CDN-Abhängigkeit, kein Build-Schritt), nicht Angular
oder React — beide hätten eine vollständige SPA-Umstellung samt neuer
JSON-API für jede bisher serverseitig gerenderte Ansicht bedeutet, unverhältnismässig
zum eigentlichen Bedarf ("Formulare und Tabellen sollen besser aussehen").

## Bootstrap-Integration

`public/vendor/bootstrap/bootstrap.min.css` und
`public/vendor/bootstrap/bootstrap.bundle.min.js` (Version 5.3.3, von
`https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/...` einmalig bezogen und
committed) — keine CDN-Einbindung zur Laufzeit, kein npm-Paket, kein
Build-Schritt. `src/app.js` erhält einen neuen `express.static('public')`-Mount
(existiert noch nicht).

`_header.ejs`s bestehende `<style>`-Variablen bleiben die Quelle der Wahrheit
für Marken-Farben; sie werden zusätzlich auf Bootstraps eigene
CSS-Variablen gemappt (`--bs-primary: var(--brand-primary)` usw.), sodass
alle Bootstrap-Komponenten (Buttons, Alerts, aktive Nav-Elemente) automatisch
die pro Instanz konfigurierten Farben übernehmen, ohne jede Komponente einzeln
zu überschreiben.

**Darkmode**: Bootstrap 5.3 hat natives Theming über `data-bs-theme="dark"`.
Der bestehende Toggle (`_header.ejs`s Script, setzt `data-theme="dunkel"/"hell"`
und ein Cookie) wird erweitert: derselbe Klick setzt zusätzlich
`data-bs-theme="dark"/"light"` auf `<html>`, damit Bootstraps eigene
Komponenten korrekt mitschalten. Kein zweites, unabhängiges Theme-System.

## Neue Admin-Startseite

`GET /admin` (aktuell 404 — der Blanket-Guard in `app.js:94` existiert, aber
keine Route dahinter) bekommt einen Handler direkt in `app.js` (analog zu
`GET /healthz`/`GET /`, kein eigener Sub-Router nötig für eine einzelne
statische Seite): rendert `views/admin/dashboard.ejs`, eine Kachel-Übersicht
mit einem Link pro Admin-Bereich (dieselben acht Ziele wie in
`admin/_nav.ejs`: Konten, Zuweisungsregeln, Eskalationszeiten,
Erscheinungsbild, Personen, PDF-Einstellungen, Mail-Protokoll,
Sync-Übersicht).

## Navigation: Tab für Aufgaben/Admin

`_header.ejs` bekommt eine echte Bootstrap-Nav (`nav-tabs`, passend zum
Nutzerwunsch "als Tab oder ähnliches" — nicht mehr ein einzelner
Klartext-Link wie bisher auf `home.ejs` beschränkt)
mit bis zu zwei Einträgen, sichtbar auf **jeder** Seite (nicht nur der
Startseite):

- **"Aufgaben"** (`/pool`) — sichtbar, wenn die Person Mitglied der
  Buchhaltungs- oder Portal-Admin-Gruppe ist (deckt sich mit `/pool`s
  bestehendem `requireAnyRole`-Gate).
- **"Admin"** (`/admin`) — sichtbar, wenn die Person Mitglied der
  Portal-Admin-Gruppe ist.

Der aktuell aktive Tab wird optisch hervorgehoben (Bootstrap `.active`,
bestimmt über den angeforderten Pfad).

## Automatische Weiterleitung nach Login

`src/routes/auth.js`s `/callback`-Handler leitet aktuell immer auf `/` weiter.
Neu: direkt auf `/pool`, wenn die Person Buchhaltungs- oder
Portal-Admin-Gruppenmitglied ist (also `/pool` ohnehin nicht 403en würde) —
deckt den alltäglichen Fall ohne zusätzlichen Klick ab. Für eine Person in
keiner der beiden Gruppen (Freigeber/Stellvertreter ausserhalb von
Buchhaltung/Admin, seit AUTH-WIDEN-1 explizit eine unterstützte
Login-Population) bleibt es bei `/`, da `/pool` für sie weiterhin korrekt
403en würde — keine Verhaltensänderung für diesen Fall, nur der bereits
bestehende Pfad.

## Speichern-Rückmeldung

Alle sieben Stellen, an denen ein Admin-POST-Handler bei Erfolg per
Redirect-nach-POST auf sich selbst zurückspringt, bekommen denselben Marker:
`res.redirect('/admin/xyz')` → `res.redirect('/admin/xyz?gespeichert=1')`.
Der jeweilige `GET`-Handler liest `req.query.gespeichert === '1'` und gibt
`gespeichert: true` an die View; die View zeigt dann eine dismissible
Bootstrap-`alert-success` ("Gespeichert.") neben dem Speichern-Button.
Betroffen: `admin/konten.js` (beide POST-Routen: `/` und `/:id`),
`admin/zuweisungsregeln.js`, `admin/eskalation.js`, `admin/erscheinungsbild.js`,
`admin/pdf-einstellungen.js`, `admin/sync.js`, sowie `admin/mails.js`s
`/:id/erneut-versenden`-Aktion (kein Formular, aber derselbe
Redirect-nach-Aktion-Fall — "Erneut gesendet." statt "Gespeichert.").

## View-Behandlung

Alle 11 Views + `_header.ejs` bekommen Bootstrap-Klassen und leichte
Markup-Anpassungen (Grid/Utility-Klassen statt `<br>`-basiertem Abstand,
`.table`, `.form-control`/`.form-check`, `.btn`/`.btn-primary`/`.btn-outline-*`,
`.alert`, `.card` für die Split-View-Panels in `kontierung.ejs`/`freigabe2.ejs`).
Keine Struktur-Umbauten über das für Bootstrap-Klassen nötige Minimum hinaus —
bestehende IDs/Datenattribute, die von Inline-`<script>`-Blöcken referenziert
werden (`#preview-dialog`, `.beanspruchen-btn`, `.thumbnail-preview` usw.),
bleiben unverändert, damit die vorhandene Client-Logik ohne Anpassung
weiterläuft.

## Tests

- **Unit/Integration**: `GET /admin` rendert 200 mit Links zu allen acht
  Bereichen; bleibt für Nicht-Portal-Admins weiterhin 403 (bestehendes
  Blanket-Gate). Der Nav-Tab-Sichtbarkeits-Split (Aufgaben-Tab nur für
  Buchhaltung/Admin, Admin-Tab nur für Portal-Admin, kein Tab für
  Nicht-Mitglieder) — Erweiterung der bestehenden `home.ejs`-Sichtbarkeitstests
  auf `_header.ejs`, da die Nav jetzt global ist. Post-Login-Redirect: neuer
  Test pro Fall (Buchhaltung → `/pool`, Portal-Admin (nicht Buchhaltung) →
  `/pool`, keine der beiden Gruppen → `/`) — Erweiterung der bestehenden
  `auth.test.js`-Suite. Speichern-Rückmeldung: je ein Test pro betroffener
  Route, der auf `?gespeichert=1` im Redirect-Ziel prüft, plus ein Test, dass
  ein fehlgeschlagenes Speichern (400, Validierungsfehler) diesen Marker
  **nicht** setzt.
- **Manuell/visuell**: da dies eine reine Darstellungsänderung ist, die von
  der bestehenden Testsuite nicht sinnvoll auf "sieht gut aus" geprüft werden
  kann, wird nach Abschluss jeder Implementierungs-Aufgabe eine kurze
  Sichtprüfung im Browser (Light + Dark) empfohlen, bevor der finale
  Review läuft.

## Nicht Teil dieser Phase

Keine Änderung an `/pool`, `/api/pool` oder `/admin`s bestehendem
Autorisierungs-Gate (`requireRole`/`requireAnyRole`) — nur die
Sichtbarkeit von Links/Tabs ändert sich, nicht wer worauf zugreifen darf.
Keine SPA-Umstellung, keine neue JSON-API. Keine Änderung an der
Kontierungs-/Freigabe-Workflow-Logik, nur an deren Darstellung. Kein
automatisches Ausblenden der Erfolgs-Meldung nach X Sekunden (Bootstraps
dismissible Alert reicht — manuelles Schliessen per Klick).
