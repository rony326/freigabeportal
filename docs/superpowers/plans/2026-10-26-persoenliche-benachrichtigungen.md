# Persönliche Benachrichtigungen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jede Person wählt sofort / täglich / wöchentlich; der Admin legt den Standard und den Wochentag fest; Erinnerungen, Eskalationen und Sicherheits-Mails gehen immer sofort.

**Architecture:** Die Entscheidung "sofort oder geplant" fällt weiterhin beim Einreihen (`reiheBenachrichtigungEin` in `src/services/notify.js`), jetzt pro Empfänger-Adresse über eine neue Funktion `benachrichtigungFuer`. Der bestehende Job `mail-digest` läuft weiter täglich und verschickt pro Empfänger nur, wenn dessen **aktuelle** Einstellung heute fällig ist (täglich: jeden Tag; wöchentlich: am eingestellten Wochentag, Datum Europe/Zurich). Wer auf "sofort" wechselt, bekommt seine geplanten Mails sofort als Digest.

**Tech Stack:** Node.js ESM, Express 4, EJS, node:sqlite, `node:test` + supertest.

**Spec:** `docs/superpowers/specs/2026-10-25-persoenliche-benachrichtigungen-design.md`

## Global Constraints

- Werte exakt: `'sofort' | 'taeglich' | 'woechentlich'`; Spalte `personen.benachrichtigung` (NULL = Standard).
- Neue Config-Schlüssel: `mail_standard_benachrichtigung` (Default `'sofort'`), `mail_digest_wochentag` (`'1'` = Montag … `'7'` = Sonntag, Default `'1'`). Bestehende `mail_batching_stunde`/`mail_batching_minute` gelten für täglich und wöchentlich.
- Migration (einmalig, idempotent): fehlt `mail_standard_benachrichtigung` und ist `mail_batching_aktiv = '1'` → `'taeglich'`, sonst `'sofort'`. `mail_batching_aktiv` wird danach nirgends mehr gelesen (Schlüssel darf bleiben).
- `IMMER_SOFORT_TYPEN` zusätzlich: `reminder`, `eskalation`, `freigabe2-reminder`, `freigabe2-eskalation`, `kk-beleg-erinnerung`, `sicherheitsalarm`, `duplikat-warnung`, `rechnungsnummer-warnung` (die letzten drei sind Warnungen; prüfen, ob sie heute schon sofort gehen — Verhalten für Warnungen nie verschlechtern).
- Adresse ohne Person (z. B. freie Empfängerzeilen) oder Person ohne Wahl → Standard.
- Digest-Betreff/-Text: neue Variable `%zusammenfassung%` (`Tägliche` / `Wöchentliche`) und `%einstellungenLink%` (absoluter Link auf `/meine-benachrichtigungen`, wie andere Links gebaut). Gespeicherte Vorlage, die exakt dem alten Default entspricht, wird auf den neuen Default gehoben; angepasste Vorlagen bleiben unverändert.
- Keine Mail geht verloren oder doppelt: Zeilen bleiben `geplant`, bis ihr Digest versendet ist; Beanspruchen wie heute (`beanspruche` in `src/services/mailZustellung.js`).
- Responsive, CSRF, `csrfSweep`/`layoutSweep` grün; jede Task endet mit `npm test` grün (aktuell 2225).

## Review Focus

1. Person wechselt von "wöchentlich" auf "sofort", während 5 Mails geplant sind → genau eine Digest-Mail sofort, keine Zeile bleibt hängen, kein zweiter Versand beim nächsten Lauf (Task 2 Test).
2. Wechsel "täglich" → "wöchentlich" nach dem Einreihen → Mails warten bis zum Wochentag (Einstellung zur Laufzeit zählt), gehen dann vollständig raus (Task 1 Test).
3. Lauf kurz nach Mitternacht UTC, Zürich noch Vortag (bzw. umgekehrt, Sommerzeit) → Wochentag nach Zürcher Datum (Task 1 Test mit festem `jetzt`).
4. Erinnerung/Eskalation für eine Person mit "wöchentlich" → sofort, nie im Digest (Task 1 Test).
5. Zwei Personen teilen sich eine Adresse oder Gross/Kleinschreibung der Adresse weicht ab → Zuordnung über `lower(email)`; bei mehreren Personen gilt die kürzeste Bündelung (sofort < täglich < wöchentlich) (Task 1 Test).

---

### Task 1: Einstellung, Zuordnung und Digest-Logik

**Files:**
- Modify: `src/db/index.js` (Spalte, Migration Standard + Vorlagen-Default), `src/db/adminConfigRepo.js` (DEFAULTS, Digest-Vorlage), `src/services/notify.js`, `src/services/cronJobs.js` (`runMailDigestJobInternal`), ggf. `src/services/mailZustellung.js` (Gruppierung/Filter), `src/db/personenRepo.js`
- Create: `src/services/benachrichtigung.js`
- Test: `test/unit/benachrichtigung.test.js`, bestehende Digest-/notify-Tests anpassen

**Interfaces:**
- Produces (`src/services/benachrichtigung.js`):
  - `BENACHRICHTIGUNG_WERTE = ['sofort','taeglich','woechentlich']`
  - `standardBenachrichtigung(db) → Wert`
  - `benachrichtigungFuer(db, email) → Wert` (Review Focus 5)
  - `istDigestFaellig(wert, jetzt, wochentag) → boolean` (`sofort` → true; `taeglich` → true; `woechentlich` → Zürcher Wochentag von `jetzt` === `wochentag`)
  - `setzeBenachrichtigung(db, personId, wert | null)`
- `reiheBenachrichtigungEin`: `geplant = !IMMER_SOFORT_TYPEN.has(typ) && benachrichtigungFuer(db, to) !== 'sofort'`.
- `runMailDigestJob(db, config, mailer, { jetzt } = {})`: pro Empfänger nur, wenn `istDigestFaellig(benachrichtigungFuer(db, empfaenger), jetzt, wochentag)`; Empfänger mit aktueller Wahl `sofort` (gewechselt) werden ebenfalls versendet. Rückgabe zusätzlich `zurueckgestellt` (Anzahl Empfänger, die bis zum Wochentag warten). `%zusammenfassung%` je Empfänger.

- [ ] **Step 1: Failing tests:** Migration (batching 1 → taeglich, 0 → sofort, idempotent, alte Default-Vorlage gehoben, angepasste bleibt); Zuordnung Person/Standard/unbekannte Adresse/Case/zwei Personen (Review Focus 5); `istDigestFaellig` mit Zürcher Datum an DST-Grenzen (Review Focus 3); Einreihen sofort vs. geplant je Wahl; Immer-sofort-Typen bei "wöchentlich" (Review Focus 4); Digest-Lauf Dienstag: täglich versendet, wöchentlich (Montag) zurückgestellt; Montag: beide; Wechsel täglich→wöchentlich nach Einreihen (Review Focus 2); keine Doppelzustellung bei zwei Läufen am selben Tag; Betreff "Wöchentliche".
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(benachrichtigungen): persönliche Bündelung und wöchentlicher Digest`.

### Task 2: Seite "Meine Benachrichtigungen" und Admin-Standard

**Files:**
- Create: `src/routes/meineBenachrichtigungen.js`, `views/meine-benachrichtigungen.ejs`
- Modify: `src/app.js` (Mount `/meine-benachrichtigungen`, angemeldet), `src/services/navigation.js` (Persönlich → "Benachrichtigungen", vor "Ferienmodus"), `src/routes/admin/mailEinstellungen.js` + View (Schalter sofort/gebündelt → Auswahl Standard sofort/täglich/wöchentlich, Wochentag-Auswahl, Uhrzeit bleibt)
- Test: `test/integration/meineBenachrichtigungen.test.js`, `csrfSweep`, `navigation.test.js`, bestehende Mail-Einstellungs-Tests

**Interfaces:**
- Consumes: Task 1.
- `GET /meine-benachrichtigungen`: Radios "Sofort", "Täglich um HH:MM", "Wöchentlich am <Wochentag> um HH:MM", "Standard verwenden (<Standard>)"; Hinweis unter den Radios: "Erinnerungen, Eskalationen und Sicherheitsmeldungen kommen immer sofort."; Warnhinweis (Spec Ziel 5), wenn die Bündelungsdauer (täglich 24 h, wöchentlich 168 h) die kürzeste für die Person relevante Frist übersteigt (Minimum aus `reminder_stunden`, `eskalation_stunden`, `freigabe2_reminder_stunden`, `freigabe2_eskalation_stunden` — relevant = die Person ist Freigeber/Buchhaltung; im Zweifel alle). Text exakt: "Bei dieser Bündelung siehst du neue Aufgaben eventuell erst nach der Erinnerung — Erinnerungen kommen trotzdem sofort."
- `POST /meine-benachrichtigungen` (CSRF): Wert prüfen (nur `BENACHRICHTIGUNG_WERTE` oder `standard`), speichern; ist die neue effektive Wahl `sofort` und gibt es geplante Zeilen für die Adresse → sofort als Digest zustellen (bestehende `stelleDigestZu`), Erfolgsmeldung nennt die Anzahl; Redirect mit Meldung.

- [ ] **Step 1: Failing tests:** Seite für jede angemeldete Person, zeigt aktuelle Wahl; Speichern jeder Option; ungültiger Wert → 422; Wechsel auf sofort mit geplanten Mails (Review Focus 1); Hinweis erscheint bei wöchentlich mit 48-h-Frist, nicht bei sofort; Admin: Standard und Wochentag speichern, alte Batching-Checkbox verschwunden; Navigation; CSRF-Sweep.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(benachrichtigungen): Seite Meine Benachrichtigungen und Admin-Standard`.

### Task 3: Dokumentation

**Files:**
- Modify: `docs/geplante-jobs-und-benachrichtigungen.md`, `docs/admin-bereich.md`, `docs/datenmodell.md` (Spalte), `docs/README.md` falls Featureliste, `docs/kommentare.md` (Kommentar-Mails folgen der persönlichen Wahl)
- [ ] **Step 1:** Doku schreiben; Schlüssel, Routen, Typenliste per `grep` prüfen.
- [ ] **Step 2:** `npm test` → PASS.
- [ ] **Step 3:** Commit `docs: persönliche Benachrichtigungen dokumentieren`.
