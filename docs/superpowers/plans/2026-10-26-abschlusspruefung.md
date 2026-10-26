# Abschlussprüfung vor dem Launch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Das ganze Portal ist auf CVEs, nach CIA/Echtheit/Nachvollziehbarkeit und auf Ausfallsicherheit geprüft; kritische, hohe und mittlere Funde sind mit Tests behoben; ein verständlicher Prüfbericht liegt vor.

**Architecture:** Drei Prüfphasen erzeugen Funde in einer gemeinsamen Fundliste (git-ignoriert, im Plan-Arbeitsverzeichnis): (1) Abhängigkeiten/CVEs, (2) Live von aussen (Skripte, Ziel aus einer Umgebungsvariable), (3) innen am Code und an einer lokalen Kopie, aufgeteilt in fünf Prüfbereiche. Danach Behebung in Wellen nach Schwere, dann Bericht. Die Nachprüfung nach dem Aufspielen des neuen Stands ist ein eigener, späterer Schritt.

**Tech Stack:** Node.js 22, Express 4, node:sqlite, `npm audit`, curl/Node-Skripte, Playwright (vorhanden), undici MockAgent, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-26-abschlusspruefung-design.md`

## Global Constraints

- **Die Live-Adresse erscheint in keiner committeten Datei und keiner Commit-Nachricht.** Skripte lesen das Ziel aus der Umgebungsvariable `PRUEF_ZIEL_URL`; im Bericht heisst das Ziel „Live-Portal“. Vor jedem Commit prüfen, dass der Hostname nicht im Diff steht: Hostname in eine lokale Variable legen (`H=$(printf %s "$PRUEF_ZIEL_URL" | sed -E 's|https?://||;s|/.*||')`) und `git grep -iF "$H"` muss leer sein. Keine Live-URL, kein Cookie, kein Token in Fundliste/Bericht/Logs.
- Live-Grenzen: nur ohne gültige Anmeldung; im Mittel ≤ 2 Anfragen/s, Stösse ≤ 20 Anfragen, insgesamt ≤ 5000; keine Last-/Absturztests, keine Uploads > 1 MB, keine echten Konten. Ein gelungener Angriff, der etwas anlegt → sofort melden, nicht weiter ausnutzen.
- Fund-Format (eine Zeile pro Fund in `<workspace>/funde.md`): `ID | Schwere (kritisch/hoch/mittel/niedrig/hinweis) | Ziel (V/I/A/Echtheit/Nachvollziehbarkeit) | Ort (Datei:Zeile oder Pfad) | Kurzbeschreibung | Nachweis (Befehl/Test, ohne Geheimnisse) | live/master | Status`.
- Behebung auf Branch `feature/abschlusspruefung`, jede mit Test; Abhängigkeits-Updates nur Patch/Minor; Major oder Verhaltensänderung → Vorschlag im Bericht statt stiller Umbau.
- Prüfungen werden nie abgeschwächt, Tests nie gelockert, um Funde „zu beheben“.
- `npm test` grün (aktuell 2291) und `npm run test:responsive` grün nach jeder Behebungswelle.

## Review Focus

1. Fund als behoben markiert, aber nur ein Symptom abgedeckt (eine Route geschützt, die Nachbarroute nicht) → jede Behebung nennt alle betroffenen Stellen; wo möglich ein Sweep-Test statt Einzelfall (Task 5).
2. Live-Skript läuft ohne Grenzen (Schleife, Wiederholungen) → hartes Anfragebudget und Abbruch im Skript (Task 2).
3. Bericht/Commit enthält Adresse, Cookie-Werte oder Pfade mit Geheimnissen → Prüfschritt vor jedem Commit (alle Tasks, Task 6).
4. Ein CVE betrifft nur ungenutzten Code → Bericht begründet „nicht ausnutzbar“ mit Code-Nachweis statt still zu ignorieren (Task 1).
5. Fix für Ausfall (z. B. ein Limit) sperrt legitime Nutzung (grosse echte Rechnungs-PDFs, Monatsabrechnung) → Grenzen mit realistischen Grössen testen (Task 4/5).

---

### Task 1: Abhängigkeiten und CVEs

**Files:** Create: `.superpowers/.../funde.md` (Abschnitt CVE), `task-1-report.md`
- [ ] **Step 1:** `npm audit --json` (prod und dev getrennt), `npm ls --all`; Node-Version aus `.nvmrc`/`engines` und das von Infomaniak angebotene Node-Angebot recherchieren.
- [ ] **Step 2:** Web-Recherche neuer Meldungen der letzten ~8 Wochen für jede direkte Abhängigkeit (express, undici, multer/busboy, pdf-lib, nodemailer, ejs, csrf-csrf, cookie, …) und Node.js 22 Security-Releases.
- [ ] **Step 3:** Je Treffer: wird der betroffene Code genutzt und ist er erreichbar? Schwere für dieses Portal, Fundzeile mit Code-Nachweis (Review Focus 4).
- [ ] **Step 4:** Kein Commit (nur Fundliste), Report schreiben.

### Task 2: Prüfung von aussen (Live)

**Files:** Create: `scripts/pruefung/aussen.mjs` (liest `PRUEF_ZIEL_URL`, hartes Budget, Protokoll ohne Geheimnisse), Fundzeilen, `task-2-report.md`
- [ ] **Step 1:** Skript-Gerüst: Zähler (gesamt/Rate), Abbruch bei Überschreitung, keine URL im Repo (Review Focus 2).
- [ ] **Step 2:** Prüfungen: TLS/HTTPS und Weiterleitung, Sicherheitsheader (CSP, HSTS, Referrer-Policy, X-Content-Type-Options, Frame-Schutz), Cookie-Attribute (Secure/HttpOnly/SameSite), erreichbare Pfade ohne Anmeldung, Fehlerseiten ohne interne Details, `/healthz` ohne Schlüssel, öffentliche Prüfseiten, Anmelde-Rückkehr mit fremdem Ziel (offene Weiterleitung), manipulierte IDs/Parameter/Header, ungültige/fehlende Maschinenschlüssel, CSRF mit ungültigem Token, ein kurzer Ratenbegrenzungs-Test innerhalb des Budgets.
- [ ] **Step 3:** Fundzeilen (je live/master markieren, gegen Code abgleichen); kein Live-Treffer wird ausgenutzt, der etwas anlegt.
- [ ] **Step 4:** Commit `test(pruefung): Aussen-Prüfskript` (ohne Adresse; Vor-Commit-Check).

### Task 3: Innen — Zugriff, Rechte, Eingaben, Integrität

**Files:** Create: `test/sicherheit/zugriffSweep.test.js`, ggf. weitere; Fundzeilen, `task-3-report.md`
- [ ] **Step 1:** Jede Route mit ihrer Rechteprüfung auflisten (aus `src/app.js` und Routern) und gegen die Rollen/Rechte prüfen; IDOR: fremde Job-/Datei-/Kommentar-/KK-IDs als jede Rolle (lokal, Testmodus-Instanz + ChurchTools-Mock).
- [ ] **Step 2:** Eingaben/Uploads: Typ-/Grössen-/Pfadprüfung, PDF-Parser mit kaputten/riesigen Dateien, Dateinamen (Path-Traversal), QR-/IBAN-Eingaben, Freitext → XSS in gerenderten Seiten und im PDF.
- [ ] **Step 3:** Integrität/Nachvollziehbarkeit: Audit-Trigger unveränderlich, Stempel/Zeitstempel/Hash-Kette, Snapshot/Export, keine stillen Updates/Deletes an append-only Tabellen.
- [ ] **Step 4:** Fundzeilen; failing tests für reproduzierbare Funde; Commit `test(sicherheit): Zugriffs- und Integritätsprüfungen`.

### Task 4: Innen — Verfügbarkeit, Betrieb, Konfiguration

**Files:** Create: `test/sicherheit/verfuegbarkeit.test.js`, Fundzeilen, `task-4-report.md`
- [ ] **Step 1:** Absturzpfade lokal: unerwarteter Fehler ohne Abfang, grosse/kaputte Uploads (mit realistischen Grössen, Review Focus 5), viele parallele Anfragen (moderat, lokal), ungültige Eingaben an Maschinen-Routen; voller Datenträger / nicht beschreibbares Verzeichnis simuliert.
- [ ] **Step 2:** Ausfall von ChurchTools/TSA/SMTP (Mock-Fehler/Timeouts) → Portal bleibt bedienbar, Outbox/Retry greift, kein Hängen; Neustart mitten in Freigabe → konsistenter Zustand.
- [ ] **Step 3:** Betrieb/Infomaniak: `trust proxy`, sichere Cookies hinter Proxy, Dateipfade/Persistenz, Umgebungsvariablen beim Start geprüft, Zeitzone, Logrotation/Grösse, `/healthz` und Uptime-Kuma-Meldung eines echten Ausfalls (Mock).
- [ ] **Step 4:** Fundzeilen; Commit `test(sicherheit): Verfügbarkeit und Betrieb`.

### Task 5: Behebung

**Files:** Modify: je nach Funden; Tests je Behebung
- [ ] **Step 1:** Funde nach Schwere ordnen (kritisch → hoch → mittel). Je Fund: failing test (wo sinnvoll Sweep statt Einzelfall, Review Focus 1), Fix, grün; Status in `funde.md` pflegen.
- [ ] **Step 2:** Niedrige Funde und Major-/Verhaltens-Vorschläge nicht umsetzen, nur im Bericht sammeln.
- [ ] **Step 3:** Nach jeder Welle `npm test` + `npm run test:responsive` grün; Commits je Themenblock, Vor-Commit-Adresscheck.

### Task 6: Prüfbericht

**Files:** Create: `docs/pruefbericht-2026-10.md`
- [ ] **Step 1:** Bericht in verständlichem Deutsch: was geprüft wurde (Umfang, Methode, CIA-Ziele, CVE-Stand), alle Funde nach Schwere mit Status (behoben/offen/vorgelegt), live-vs-master.
- [ ] **Step 2:** Zwei Checklisten für den Nutzer: (a) Infomaniak-Einstellungen, die nur er prüfen kann; (b) Geheimnisse, die er prüfen/erneuern sollte. Offene Punkte (echte Geräte, Nachprüfung nach dem Aufspielen).
- [ ] **Step 3:** Adress-/Geheimnis-Check (Review Focus 3); `npm test` grün; Commit `docs: Prüfbericht Abschlussprüfung`.

### Task 7: Nachprüfung nach dem Aufspielen (separat, nach dem Launch-Deploy)

- [ ] Sobald der neue Stand live ist: `scripts/pruefung/aussen.mjs` erneut gegen `PRUEF_ZIEL_URL`; Bericht um „Nachprüfung“ ergänzen. Kein Code-Commit nötig, ausser es fällt etwas auf.
