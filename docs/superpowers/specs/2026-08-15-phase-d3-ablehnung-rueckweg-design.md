# Sub-Phase D3 – Ablehnung/Rückweg — Design

## Kontext & Phasenplan

Aus Lastenheft Abschnitt 9 (Fallstrick): *"Kein vollständig definierter Rückwärtspfad bei Ablehnung: Baue einen einfachen, funktionierenden Grundmechanismus (Job wird auf Status `abgelehnt` gesetzt, Freigeber 1 bzw. die kontierende Person wird per Mail benachrichtigt, kann den Job erneut bearbeiten und zurück in den Ablauf schicken) — dies ist noch nicht im Detail durchdacht, daher pragmatisch, aber funktional umsetzen."*

D1/D2 hatten diese Sub-Phase ursprünglich als ein gemeinsames "D3 – Ablehnung/Rückweg & Mailversand" vorgesehen. Beim Brainstorming für D3 stellte sich heraus, dass der volle Umfang (Rückweg-Workflow **inklusive** eines lückenlosen Audit-Trails auf dem gestempelten PDF, **plus** tatsächlicher Mailversand mit admin-konfigurierbaren, gemischten Empfängerlisten) vergleichbar gross ist wie D1+D2 zusammen. Er wird daher in zwei Sub-Phasen aufgeteilt:

- **D3 – Ablehnung/Rückweg (dieses Dokument)**: Der komplette Rückweg-Workflow ist ohne Mailversand voll funktionsfähig — die Pool-Seite bekommt einen dritten Abschnitt "Meine abgelehnten Jobs", der Ablehnungen ohne jede E-Mail sichtbar/erreichbar macht.
- **D4 – Mailversand**: Tatsächlicher Versand von Zuweisungs-/Reminder-/Eskalations-Mails (inkl. Ablehnungs-Benachrichtigung) als Komfort-Schicht obendrauf, mit admin-konfigurierbaren Empfängerlisten (ChurchTools-Gruppe und/oder einzelne Adressen, getrennt für Reminder und Eskalation).

### Phasenplan (Kontext)

- Phase A – Fundament & Auth (abgeschlossen, gemerged)
- Phase B – Admin-Bereich (abgeschlossen, gemerged)
- Phase C – n8n-Schnittstelle & Job-Datenmodell (abgeschlossen, gemerged)
- Phase D – Freigabe-Workflow-UI
  - D1 – PDF-Verarbeitung (abgeschlossen, gemerged)
  - D2 – Freigabe-Workflow-UI (abgeschlossen, gemerged)
  - **D3 – Ablehnung/Rückweg (dieses Dokument)**
  - D4 – Mailversand
- Phase E – Härtung & Deployment (inkl. Rate-Limiting)

## Architektur & Routen

- `POST /freigabe2/:id` (bestehend, D2) bekommt eine zweite Aktion: das Formular sendet ein Feld `aktion` (`freigeben` | `ablehnen`) über zwei Submit-Buttons mit demselben `name="aktion"`. Beide Zweige teilen sich das bestehende Begründungsfeld — Pflicht bei `aktion=ablehnen` genauso wie bei `interessenskonflikt=ja`. Ablehnen setzt `job.status = 'abgelehnt'`, schreibt `abgelehnt_von`/`ablehnungsgrund` und protokolliert das Ereignis in `freigaben` (siehe Datenmodell). Kein PDF-Stempeln bei Ablehnung.
- Neuer Router `src/routes/ablehnung.js`, gemountet unter `/abgelehnt`:
  - `GET /abgelehnt/:id` — zeigt Ablehnungsgrund, wer/wann abgelehnt hat, Button "Überarbeiten".
  - `POST /abgelehnt/:id/ueberarbeiten` — setzt `status` zurück auf `'zugewiesen'`, löscht `abgelehnt_von`/`ablehnungsgrund`, redirect zu `/kontierung/:id`. `konto_id` bleibt erhalten (die Kontierungs-Seite zeigt es wie gewohnt vorausgefüllt, änderbar).
- Zugriff auf beide neuen Routen: nur `job.zugewiesen_an` (die Person, die die ursprüngliche Kontierung + Freigabe 1 durchgeführt hat — diese Spalte bleibt seit D2 über Freigabe 2 hinweg unverändert erhalten, also auch nach einer Ablehnung noch korrekt). Gleiches 403-Muster wie bei Kontierung/Freigabe 2.
- Pool-Seite (`views/pool.ejs`, `src/routes/poolPage.js`) bekommt einen dritten Abschnitt "Meine abgelehnten Jobs" über eine neue `listAbgelehntJobsForPerson(db, personId)`, verlinkt auf `/abgelehnt/:id` — das macht Ablehnungen ohne jede E-Mail auffindbar.

## Datenmodell

`freigaben.rolle`-CHECK-Constraint erweitert sich von `('freigeber1', 'freigeber2')` auf `('freigeber1', 'freigeber2', 'ablehnung')`. Ablehnung nutzt die bestehende `createFreigabe`-Funktion unverändert — `rolle: 'ablehnung'`, `kommentar` = Ablehnungsgrund, `interessenskonflikt: false`, `eskaliertVon: null`. Damit liegt die vollständige chronologische Historie eines Jobs — jede Freigabe 1, jede Freigabe 2, jede Ablehnung, über beliebig viele Rückweg-Zyklen — in einer einzigen, nach `id` geordneten Tabelle.

**Konsequenz für bestehenden D2-Code:** `src/routes/freigabe2.js` verwendet aktuell `freigaben.find(f => f.rolle === 'freigeber1')`, um "die" Freigabe-1-Genehmigung zu finden. Nach einem abgelehnten-und-überarbeiteten Zyklus existiert eine *zweite* `freigeber1`-Zeile; `.find()` (erster Treffer) würde die veraltete, überholte Zeile liefern. Überall dort, wo "die aktuell gültige Genehmigung" gesucht wird — `freigabe2.js`s `renderForm` und die Stempel-Stelle — wird das zu `.findLast(f => f.rolle === 'freigeber1')` (letzter Treffer). Dies ist ein echter, in bereits gemergtem D2-Code latenter Fehler, der als Teil von D3 behoben wird, nicht als eigenständige Aufgabe.

**Neue Repo-Funktionen** (`src/db/jobsRepo.js`):
- `ablehnenJob(db, jobId, { abgelehntVon, grund })` — `UPDATE jobs SET status='abgelehnt', abgelehnt_von=?, ablehnungsgrund=? WHERE id=? AND status='freigabe2'` (Guard, boolescher Rückgabewert — gleiches Double-Submit-Schutzmuster wie `abschliessenFreigabe2`).
- `wiederOeffnenJob(db, jobId, personId)` — `UPDATE jobs SET status='zugewiesen', abgelehnt_von=NULL, ablehnungsgrund=NULL WHERE id=? AND zugewiesen_an=? AND status='abgelehnt'` (boolescher Rückgabewert).
- `listAbgelehntJobsForPerson(db, personId)` — `SELECT * FROM jobs WHERE status='abgelehnt' AND zugewiesen_an=? ORDER BY eingang_am`.

## Audit-Trail-Stempelung (erweitert D1s `stampAndFinalize`)

`stampAndFinalize`s `stampData`-Parameter bekommt ein drittes Feld: `{ freigeber1, freigeber2, verlauf }`. `freigeber1`/`freigeber2` bleiben exakt wie bisher — die zwei prominenten, fest positionierten Blöcke auf der Visum-Seite, die die *finalen* Genehmigungen zeigen, die den Job tatsächlich abgeschlossen haben. `verlauf` ist neu: die vollständige geordnete Liste aus `listFreigabenByJob` (jede Freigabe 1, Freigabe 2 und Ablehnung über alle Rückweg-Zyklen), gemappt auf `{ rolleLabel, name, identitaet, zeitpunkt, ip, interessenskonflikt, kommentar }` (`rolleLabel`: "Freigabe 1" / "Freigabe 2" / "Abgelehnt").

Darstellung: ein kompaktes, ein-bis-zweizeiliges Protokoll pro Eintrag (`"12.03.2026 14:32 — Freigabe 1 — Hans Meier (12345)"`, plus bei vorhandenem Kommentar eine eingerückte Zeile `"   Kommentar: ..."`), **immer auf neuer/n Seite(n) am Ende des Dokuments angehängt** — unabhängig von `visumSeitePosition`, ohne den Koordinatenraum der Visum-Seite zu teilen. Das vermeidet jeden Konflikt mit den festen y-Koordinaten der zwei Hauptblöcke und hält den Normalfall (keine Ablehnung, 2 Einträge) einfach — nur eine kurze zusätzliche Seite. Passt das Protokoll nicht auf eine Seite (mehrere Ablehnungs-Zyklen), hängt `stampAndFinalize` über `doc.addPage()` so viele Seiten an wie nötig, gleiche Seitengrösse, von oben nach unten gefüllt mit Bodenrand, gleiche Schriftart/-grösse wie `drawFreigabeBlock`.

Die Stempel-Stelle in `src/routes/freigabe2.js` baut `verlauf` aus `listFreigabenByJob(db, job.id)` (ohnehin schon für die `.findLast`-Lookups geladen) und reicht es unverändert durch.

Dies ist der einzige Teil von D3, der D1s bereits gemergtes, bereits getestetes Modul anfasst — die bestehenden `stampAndFinalize`-Tests und D2s Ende-zu-Ende-Test prüfen beide das Zwei-Block-Layout und werden im Rahmen dieser Arbeit für die neue Signatur aktualisiert, nicht kaputt zurückgelassen.

## UI-Details

**Freigabe-2-Formular (`views/freigabe2.ejs`)**: aktuell ein "Freigeben"-Submit-Button plus Interessenskonflikt-Ja/Nein + Begründung. Bekommt einen zweiten Submit-Button `<button type="submit" name="aktion" value="ablehnen">Ablehnen</button>` neben dem bestehenden `<button type="submit" name="aktion" value="freigeben">Freigeben</button>`. Label/Hilfetext des Begründungsfelds wird angepasst, um beide Fälle abzudecken ("Begründung (bei Interessenskonflikt oder Ablehnung Pflicht)"); serverseitige Validierung verlangt sie immer, wenn `aktion === 'ablehnen'` ODER `interessenskonflikt === 'ja'`, gleiches 400-mit-neu-gerendertem-Formular-Muster wie bisher.

**Neu `views/abgelehnt.ejs`**: minimale Seite — Dateiname, Ablehnungsgrund, wer/wann abgelehnt hat (aufgelöst zu Anzeigename), ein "Überarbeiten"-Button, der auf `/abgelehnt/:id/ueberarbeiten` postet. Keine PDF-Vorschau nötig (der Zweck ist, das *Warum* zu zeigen, dann zurück zur vertrauten Kontierungs-Seite mit eigener Vorschau).

**Pool-Seite (`views/pool.ejs`)**: dritter Abschnitt "Meine abgelehnten Jobs" (gleicher Listen-Stil wie "Meine offenen Kontierungen"/"Meine Freigaben"), befüllt aus `listAbgelehntJobsForPerson`, verlinkt auf `/abgelehnt/:id`. Leer-Zustand-Text im gleichen Muster wie die anderen zwei Abschnitte ("Keine abgelehnten Rechnungen.").

## Fehlerbehandlung

- `/abgelehnt/:id` und `/abgelehnt/:id/ueberarbeiten`: 403 (bestehende `error.ejs`), wenn `job.status !== 'abgelehnt'` oder Anfragende(r) nicht `job.zugewiesen_an` ist — gleiche Form wie bei Kontierung/Freigabe 2.
- Freigabe-2-POST mit `aktion === 'ablehnen'` ohne Begründung: 400, Formular neu gerendert, nichts persistiert — gleiches Muster wie die bestehende Konflikt-Begründungsprüfung.
- `ablehnenJob`s `WHERE status='freigabe2'`-Guard und `wiederOeffnenJob`s `WHERE zugewiesen_an=? AND status='abgelehnt'`-Guard geben beide einen booleschen Wert zurück; ein `false` (Double-Submit-Race) rendert die bestehende generische "wurde bereits von einem anderen Vorgang bearbeitet"-Meldung, gleiches etabliertes Muster wie bei `abschliessenFreigabe2`.
- Alles bleibt innerhalb des bestehenden `db.exec('BEGIN')`/`COMMIT`/`ROLLBACK`-Transaktionsmusters.

## Tests

Wie in Phase A–D2: echte HTTP-Requests via `supertest`, echte In-Memory-SQLite-DB, echte PDF-Fixtures, keine Mocks der eigenen Business-Logik.

- Zugriffskontrolle auf beiden neuen Routen: keine Session → 401, falsche Person aus `buchhaltung` → 403, richtige Person → 200.
- Voller Zyklus Ablehnen → Überarbeiten → erneut Einreichen → (erneute) Freigabe 1 → (erneute) Freigabe 2 → `abgeschlossen`, Ende-zu-Ende, mit Prüfung, dass die finale gestempelte PDF-Audit-Trail-Seite **sowohl** den ursprünglichen Ablehnungs-Eintrag **als auch** die finalen Genehmigungen enthält (mupdf-Textextraktion, gleiche Technik wie D1/D2s Ende-zu-Ende-Test) — dieser Test beweist, dass der `.findLast`-Fix und das mehrseitige Audit-Trail tatsächlich zusammenspielen.
- Ein Job, der zweimal abgelehnt wird, bevor er schliesslich genehmigt wird — beweist, dass das Audit-Trail mehr als einen Zyklus verarbeitet und, falls es nicht auf eine Seite passt, tatsächlich auf eine zusätzliche Seite überläuft (Seitenzahl-Zuwachs verifizieren).
- Ablehnen eines Jobs, der nicht mehr in `freigabe2` ist (jemand anderes war zuerst da) → Guard greift, kein doppelter Übergang.
- Bestehende `stampAndFinalize`-Unit-Tests aktualisiert für das neue `verlauf`-Feld; ein Fall mit nur den zwei finalen Einträgen (keine Ablehnung) rendert weiterhin korrekt auf einer kleinen zusätzlichen Seite.
- Konto-Dropdown/Vorbefüllung nach "Überarbeiten": `konto_id` bleibt erhalten, Formular zeigt es vorausgewählt.

## Nicht Teil von Sub-Phase D3

Tatsächlicher Versand von Zuweisungs-/Reminder-/Eskalations-Mails (inkl. Ablehnungs-Benachrichtigung) — das ist D4. `src/services/mailer.js` existiert bereits (aus einer früheren Phase vorbereitet), wird aber in D3 nicht verdrahtet; Ablehnungen sind ausschliesslich über die Pool-Seite ("Meine abgelehnten Jobs") auffindbar, ohne jede E-Mail. Admin-konfigurierbare Empfänger-Listen (ChurchTools-Gruppe und/oder einzelne Adressen, getrennt für Reminder/Eskalation) sind ebenfalls D4. Rate-Limiting auf den neuen Routen ist Phase E.
