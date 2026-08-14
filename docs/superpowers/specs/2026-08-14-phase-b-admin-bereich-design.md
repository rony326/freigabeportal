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
    personen.js         -- read-only
  src/db/
    kontenRepo.js
    zuweisungsregelnRepo.js
  views/admin/
    _nav.ejs             -- gemeinsame Navigation, per EJS-Include eingebunden
    konten-liste.ejs
    konten-form.ejs
    zuweisungsregeln-liste.ejs
    zuweisungsregeln-form.ejs
    eskalation-form.ejs
    personen-liste.ejs
  ```
  Alle vier Router werden in `src/app.js` unter `/admin` gemountet, hinter der
  `requireRole(config, 'portal-admin')`-Middleware.

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

## Fehlerbehandlung

- Zugriff auf `/admin/*` ohne "Portal-Admin"-Gruppenzugehörigkeit → 403, deutsche Fehlerseite
  (bestehende `requireRole`-Middleware aus Phase A, unverändert).
- Validierungsfehler (Konten-Vier-Rollen-Check, Zuweisungsregel-Duplikat, ungültige
  Eskalationszeiten) → Formular wird mit Fehlermeldung und den bisherigen Eingaben neu gerendert,
  kein Datenverlust.
- Referenzierte `konto_id`/`churchtools_person_id` existiert nicht mehr (z.B. Race Condition
  durch parallele Bearbeitung) → generische deutsche Fehlerseite (zentrale Error-Middleware aus
  Phase A greift).

## Tests

Gleiches Muster wie Phase A: reale HTTP-Requests via `supertest` gegen eine reale In-Memory-SQLite-DB,
keine Mocks der eigenen Business-Logik. Schwerpunkte:

- Vier-Rollen-Validierung: alle Verstoss-Kombinationen (Pflichtfeld fehlt, zwei Rollen identisch,
  referenzierte Person inaktiv) werden abgelehnt; eine gültige Kombination wird akzeptiert.
- Zuweisungsregeln-Uniqueness (Duplikat wird abgelehnt).
- Zugriffsschutz: 403 ohne "Portal-Admin"-Gruppe für jede der vier `/admin/*`-Routen-Familien.
- Deaktivierte Konten und inaktive Personen verschwinden aus den jeweiligen Dropdowns/Listen,
  bleiben aber über direkten DB-Zugriff auffindbar (Audit-Trail-Erhalt).
- `ct_person_unresolved = true` wird auf `/admin/personen` sichtbar dargestellt.
- Eskalationszeiten-Formular: gültige Werte werden persistiert und beim erneuten Laden
  vorausgefüllt angezeigt; ungültige Werte (negative Zahl, kaputte E-Mail) werden abgelehnt.

## Nicht Teil von Phase B

Job-Datenmodell, n8n-Schnittstelle, tatsächlicher Versand von Reminder-/Eskalations-Mails (nur
die Konfiguration dafür entsteht hier — das Versenden ist Teil von Phase D, sobald Jobs
existieren), PDF-Verarbeitung, Freigabe-Workflow-UI, Rate-Limiting (Phase E). Die tatsächliche
Absender→Zuweisungsregel-Matching-Logik (Domain- vs. Exakt-Treffer-Priorität) gehört ebenfalls zu
Phase C, wenn eingehende Rechnungen real verarbeitet werden — Phase B liefert nur die
Datenpflege-UI dafür.
