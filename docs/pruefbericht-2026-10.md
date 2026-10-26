# Prüfbericht Abschlussprüfung (Oktober 2026)

Stand: 2026-10-26, Branch `feature/abschlusspruefung`. Geprüft wurde der Code
(master-Stand) und, ohne Anmeldung, das laufende **Live-Portal** von aussen.

## 1. Zusammenfassung

**Was geprüft wurde:** Das Portal wurde nach den drei Schutzzielen
Vertraulichkeit (nur Berechtigte sehen Daten), Integrität/Echtheit (Belege,
Freigaben und Zeitstempel lassen sich nicht unbemerkt verändern) und
Verfügbarkeit (das Portal fällt nicht leicht aus) untersucht, dazu die
Nachvollziehbarkeit (Protokolle). Das umfasste: bekannte und neu
veröffentlichte Sicherheitslücken in den verwendeten Bausteinen (CVEs), eine
Prüfung des Live-Portals von aussen, eine Prüfung des Codes von innen
(Zugriffsrechte, Uploads, Eingaben, Unveränderlichkeit) und die
Ausfallsicherheit.

**Gesamtergebnis:** Es gibt **keine offenen kritischen oder hohen Funde im
Code**. Die zwei als „hoch“ eingestuften Funde (eine Lücke, mit der ein
unangemeldeter Besucher das Portal zum Absturz hätte bringen können, und eine
veraltete Node-Version) sind im Code behoben bzw. als Aufgabe an dich
übergeben. Vier mittlere, vier niedrige und mehrere Hinweis-Funde wurden behoben. Alles Weitere
ist unten aufgelistet. Die Zugriffskontrolle (niemand sieht fremde Vorgänge)
und die Maschinenschnittstellen erwiesen sich als solide.

**Was du noch tun musst (Details in Abschnitt 4 und 5):**

1. Auf Infomaniak bestätigen, dass Datenbank, Beleg-PDFs und Backups auf
   **dauerhaftem Speicher** liegen (sonst Datenverlust bei einem Neuaufsetzen).
2. Im Infomaniak-Manager **Node.js mindestens 22.23.4** einstellen.
3. Die restlichen Betriebspunkte (Neustart bei Absturz, Proxy, Adresse,
   Logrotation, Überwachung) abhaken.
4. Geheimnisse (Schlüssel/Passwörter) auf Länge prüfen und vor dem Start ggf.
   erneuern.
5. Den neuen Stand aufspielen und danach die Prüfung von aussen wiederholen
   lassen (Abschnitt 7).

## 2. Was geprüft wurde und wie

| Bereich | Vorgehen |
|---|---|
| Abhängigkeiten / CVEs | `npm audit`, Abfrage der öffentlichen Sicherheitsmeldungen (GitHub Advisories) für jede direkte Abhängigkeit seit 1. August 2026, Node.js-Sicherheitsmeldungen. Jeder Treffer wurde danach beurteilt, ob das Portal ihn überhaupt erreichen kann. |
| Live von aussen | Skript, das **nur ohne Anmeldung** prüft: Verschlüsselung (TLS), Sicherheits-Header, Cookies, ca. 25 geschützte Seiten, Fehlerseiten, Maschinenschnittstellen ohne/mit falschem Schlüssel, offene Weiterleitungen, manipulierte Header, CSRF-Schutz, Ratenbegrenzung. |
| Innen am Code | Lokale Tests und Quellcode-Durchsicht: Zugriff auf fremde Vorgänge, Datei-Downloads, Uploads, Eingaben (XSS), Unveränderlichkeit der Nachweis-Tabellen. |
| Ausfallsicherheit | Verhalten bei hängendem ChurchTools, defekten Anfragen, vollem Speicher, Neustart mitten im Vorgang, Überwachung. |

**Grenzen:**

- Live wurde **ausschliesslich unangemeldet** geprüft. Alles, was eine
  Anmeldung braucht, wurde lokal mit der Testinstanz geprüft, nicht am Live-Portal.
- Das Anfragebudget betrug höchstens 5000 Anfragen, **tatsächlich waren es 187**
  (rund 1,8 pro Sekunde, nie mehr als 20 gleichzeitig). **Es wurde nichts
  angelegt oder verändert**; keine der schreibenden Test-Anfragen wurde
  angenommen. Abgelehnte Zugriffe erscheinen im Zugriffs-Protokoll des
  Live-Portals.
- Der Absturz-Test für die gzip-Lücke (CVE-01) wurde live bewusst **nicht**
  ausgeführt, weil er den Produktivdienst hätte beenden können.
- Das Live-Portal läuft auf einem **älteren Stand** als der Code. Neuere Seiten
  (z. B. Audit-Prüfung, Kommentare) gab es dort nicht und konnten live nicht
  geprüft werden.
- Was Infomaniak im Hintergrund einstellt (Speicher, Neustart, Node-Version),
  kann nur du im Manager sehen.
- Eine Prüfung ist eine Momentaufnahme: „keine Funde“ heisst nicht „beweisbar
  fehlerfrei“, und noch nicht gemeldete Lücken kann niemand finden.

## 3. Funde

Legende Status: **behoben** (im Code korrigiert, mit Test) · **vom Nutzer zu
erledigen** · **Vorschlag** (später sinnvoll) · **akzeptiert** (bewusst so).
„Live“ = betraf das Live-Portal, „master“ = betraf den aktuellen Code.

### Hoch

| ID | Beschreibung | Ziel | Wo | Status |
|---|---|---|---|---|
| CVE-01 | Eine einzige präparierte Anfrage ohne Anmeldung konnte das Portal beenden (Fehler im Baustein „body-parser“). | Verfügbarkeit | live + master (live wahrscheinlich, nicht getestet) | **behoben** durch Aktualisierung auf body-parser 1.20.9. Lokal liess sich der Absturz mit dem alten Stand nicht nachstellen; ein Wächter-Test bleibt trotzdem aktiv. |
| NODE-01 | Node.js 22.23.4 schliesst 10 Sicherheitslücken (u. a. im Brotli-Decoder). Das Portal erreicht sie nur über Antworten von ChurchTools/Zeitstempeldienst, also nur bei einer kompromittierten Gegenstelle. | Vertraulichkeit/Verfügbarkeit | live | **teils behoben**: Mindestversion im Code auf 22.23.4 angehoben. **Vom Nutzer zu erledigen**: Version im Infomaniak-Manager (Checkliste N1). |

### Mittel

| ID | Beschreibung | Ziel | Wo | Status |
|---|---|---|---|---|
| CVE-02 | Mailbaustein „nodemailer“ konnte Adressen falsch lesen; Mail ginge an eine andere Adresse. Nur über ein manipuliertes ChurchTools-Profil erreichbar. | Vertraulichkeit | live + master | **behoben** (nodemailer 10.2.1). |
| AUS-01 | Kein HSTS-Header: Browser wurden nicht auf HTTPS festgelegt. | Vertraulichkeit | live + master | **behoben** (HSTS 1 Jahr, nur über HTTPS gesetzt). |
| T3-INT-1 | Die Tabelle der Vier-Augen-Freigaben war als einzige Nachweis-Tabelle nicht gegen nachträgliches Ändern/Löschen gesperrt. Über das Portal nicht erreichbar, aber Lücke in der Beweiskette. | Echtheit/Nachvollziehbarkeit | master | **behoben** (Sperr-Trigger, greift auch für bestehende Datenbanken). |
| A4-01 | ChurchTools-Aufrufe beim Login und im nächtlichen Abgleich hatten kein Zeitlimit: Ein hängendes ChurchTools hätte Logins blockiert und den Abgleich bis zum Neustart stillgelegt. | Verfügbarkeit | live + master | **behoben** (15 s Zeitlimit; bei Login Meldung „ChurchTools antwortet gerade nicht“). |

### Niedrig

| ID | Beschreibung | Ziel | Wo | Status |
|---|---|---|---|---|
| AUS-02 | Kein Permissions-Policy-Header (Kamera, Mikrofon, Standort nicht ausdrücklich gesperrt). | Vertraulichkeit | live + master | **behoben**. |
| AUS-03 | Antwort verriet „X-Powered-By: Express“. | Vertraulichkeit | live + master | **behoben**. |
| AUS-04 | Kaputtes JSON an der Schnittstelle ergab live einen Serverfehler (500). | Nachvollziehbarkeit | nur live | In master bereits früher behoben (400); erledigt sich durch das Aufspielen. |
| A4-04 | Defekte komprimierte Anfragen wurden als Serverfehler gezählt und füllten das Log mit Fehlerprotokollen; ein Unangemeldeter hätte das Log fluten können. | Verfügbarkeit | master | **behoben** (400 ohne Stack-Log; echte Serverfehler loggen weiterhin). |

### Hinweise

| ID | Beschreibung | Status |
|---|---|---|
| A4-02 | Ein vergessener Fehlerfang in einer asynchronen Seite hätte das ganze Portal beenden können. Alle 43 Handler fingen intern ab, es war also nur latent. | **behoben**: alle Handler laufen über einen Schutz-Wrapper, ein Test prüft das automatisch für künftige Seiten; zusätzlich ein Prozess-Wächter, der sauber protokolliert und neu starten lässt. Ein Auto-Neustart auf Infomaniak wird vorausgesetzt (O2). |
| AUS-07 | Kein COOP/CORP-Header (zusätzliche Abschottung). | **behoben**. |
| AUS-09 | Gzip-Absturz live nicht getestet. | Erledigt durch CVE-01. |
| NODE-02 | Mindestversion in `package.json` zu niedrig (`>=22.13.0`). | **behoben** (`>=22.23.4`). |
| CVE-03 bis CVE-07 | Meldungen zu multer, proxy-addr, ip-address, brace-expansion, undici. Keine war erreichbar (keine asynchronen Datei-Filter, kein Subnetz-Proxy, Test-/Entwicklungs-Bausteine). | **behoben** vorsorglich durch Aktualisierung; `npm audit` meldet 0. |
| AUS-06 | Live-Portal ist ein älterer Stand. | Erledigt durch das Aufspielen; Nachprüfung (Abschnitt 7). |
| AUS-08 | TLS 1.0/1.1: Ablehnung liess sich vom lokalen Werkzeug nicht belastbar prüfen. TLS 1.3 und gültiges Zertifikat (4096 Bit, 65 Tage Restlaufzeit) wurden bestätigt. | **Vom Nutzer zu erledigen** (Checkliste N2). |
| AUS-05 | Die Inhaltsrichtlinie (CSP) erlaubt `'unsafe-inline'` für Skripte und Stile. Sonst streng (keine fremden Objekte, Formulare nur zu sich selbst, kein Einbetten durch andere). | **akzeptiert**; Verbesserung als Vorschlag (Abschnitt 6). |
| T3-INT-2 | `final_datei_hash` (Prüfsumme des Dokuments) ist bewusst veränderbar, weil der Zeitstempel-Nachhol-Job ihn legitim neu schreibt. Sobald der Zeitstempel gesetzt ist, gilt dessen unveränderliche Prüfsumme. Nur im Betrieb ganz ohne Zeitstempeldienst ist dies der schwächere Anker. | **akzeptiert** (bewusst so, sonst bräche der Nachhol-Job). |
| ZIP-01 | Zip-Baustein hat einen ungepatchten Hinweis (Entpacken folgt Symlinks). Das Portal entpackt nur in ein frisches, privates Verzeichnis mit festem Dateinamen. | **akzeptiert**, nicht erreichbar; bei neuem Patch aktualisieren. |
| AUS-10 | Positive Bestätigung: Ohne Anmeldung sind alle geschützten Seiten und Maschinenschnittstellen gesperrt (401/403), keine offene Weiterleitung, keine manipulierbaren Header, keine Dateilisten, keine Stacktraces, Cookies Secure/HttpOnly/SameSite=Lax, kein CORS, Ratenbegrenzung aktiv. | Kein Befund. |

**Geprüft und sauber:** fremde Vorgänge/Dateien/Kommentare sind pro Vorgang
geschützt (auch Buchhaltungsrolle sieht Unbeteiligtes nicht), signierte
Download-Links sind an den Vorgang gebunden, Uploads werden am Dateiinhalt
geprüft, Ausgaben sind gegen Einschleusen von Code escaped.

## 4. Checkliste für dich auf Infomaniak

Diese Punkte kann nur du im Infomaniak-Manager bzw. in deiner Konfiguration prüfen.

- [ ] **O1 (hoch) – Dauerhafter Speicher.** Liegen `DB_PATH`, `JOBS_DIR`,
  `BACKUP_DIR` und `BRANDING_DIR` auf **dauerhaftem** Speicher und **nicht** im
  Deploy-Verzeichnis? Ohne Angabe gelten Standardpfade unter `./data/...`
  relativ zum Programmordner. Wird dieser beim Aufspielen oder Neuaufsetzen
  geleert, gehen Datenbank, alle Beleg-PDFs und Backups verloren. Das ist das
  grösste Datenverlust-Risiko. Vor dem Aufspielen des neuen Stands prüfen und
  ein Backup extern sichern.
- [ ] **O2 – Neustart bei Absturz.** Startet Infomaniak die Node-App
  automatisch neu, wenn sie sich beendet? Das Portal beendet sich bei
  unerwarteten Fehlern bewusst sauber, damit der Neustart den Dienst wieder
  herstellt. Ohne Auto-Neustart bleibt es bis zu deinem Eingriff aus.
- [ ] **O3 – Genau ein Proxy.** Das Portal geht von **einem** Proxy-Schritt
  vor sich aus (`trust proxy` = 1). Stimmt das bei Infomaniak? Sonst ist die
  erkannte Besucheradresse falsch: Die Ratenbegrenzung lässt sich umgehen, oder
  alle Besucher teilen sich eine Adresse und sperren sich gegenseitig aus.
- [ ] **O4 – Adresse in der Konfiguration.** Beginnt `PUBLIC_BASE_URL` mit
  `https://` und passt `CT_REDIRECT_URI` dazu? Davon hängt ab, ob das
  Anmelde-Cookie als „Secure“ markiert wird.
- [ ] **O5 – Zeitzone.** Der Host sollte in UTC laufen (Code rechnet intern in
  UTC und plant in Europe/Zurich). Nur bestätigen, keine Einstellung nötig.
- [ ] **O6 – Logrotation.** Begrenzt oder rotiert Infomaniak die Logdatei? Das
  Portal rotiert nicht selbst; ein volles Log könnte sonst die Platte füllen.
- [ ] **O7 – Überwachung mit Schlüssel.** Ist Uptime Kuma (o. ä.) **mit dem
  Überwachungsschlüssel** auf `/healthz` eingerichtet? Ohne Schlüssel sieht die
  Überwachung nur „Datenbank erreichbar“; veraltete Backups, Mail-Stau, hängender
  ChurchTools-Abgleich oder wenig Speicher blieben unsichtbar. Der Schlüssel
  wird im Portal verwaltet (siehe `docs/statusseite-und-monitoring.md`).
- [ ] **N1 (NODE-01) – Node-Version.** Im Infomaniak-Manager Node.js
  **mindestens 22.23.4** einstellen (Release vom 20./21. Oktober 2026). Ein
  Wert unter 22.23.4 lässt bekannte Sicherheitslücken offen.
- [ ] **N2 (AUS-08) – Alte TLS-Versionen.** Prüfen, dass TLS 1.0 und 1.1
  abgelehnt werden, z. B. mit einem Online-Test wie SSL Labs (Gegenprobe
  ausserhalb) oder `openssl s_client -tls1_1 -connect <Host>:443` (muss
  scheitern). Das ist meist Infomaniak-Standard, wurde aber nicht belastbar
  nachgewiesen.

Das sind **9** Punkte.

## 5. Checkliste Geheimnisse

Nur Namen, keine Werte. Das Portal verweigert den Start, wenn ein Pflicht-Geheimnis
fehlt, kürzer als 32 Zeichen ist oder noch den Platzhalter `changeme` enthält.

Prüfen, dass jedes Pflicht-Geheimnis **mindestens 32 zufällige Zeichen** hat,
nicht aus der Vorlage `.env.example` stammt und nirgends sonst (Mail, Chat,
Repository) liegt:

- [ ] `SESSION_SECRET` – signiert Anmelde-Sitzungen. Bei Änderung werden alle abgemeldet.
- [ ] `DOWNLOAD_SIGNING_SECRET` – signiert die zeitlich begrenzten PDF-Links.
- [ ] `CT_CLIENT_SECRET` – OAuth-Geheimnis gegenüber ChurchTools.
- [ ] `CT_SYNC_SERVICE_TOKEN` – Zugangstoken für den Personen-Abgleich.
- [ ] `CRON_SECRET` – schützt die internen Zeitplan-Aufrufe.
- [ ] `N8N_API_KEY` – schützt die n8n-Schnittstelle.
- [ ] `BACKUP_API_KEY` (optional) – falls gesetzt, muss er sich von `N8N_API_KEY` unterscheiden.
- [ ] `SMTP_PASS` (zusammen mit `SMTP_USER`) – Mail-Zugang; Länge liegt beim Mail-Anbieter, bei Verdacht erneuern.
- [ ] Überwachungsschlüssel (`monitoring_secret`, im Portal verwaltet) – wird für Uptime Kuma gebraucht (O7).
- [ ] Pfad der Backup-Schlüsseldatei (`BACKUP_KEYRING_FILE`, falls verwendet) – Datei sicher und getrennt vom Backup aufbewahren; ohne sie sind verschlüsselte Backups nicht lesbar (siehe `docs/backup-verschluesselung.md`).

**Vor dem Start erneuern**, wenn ein Wert je in einem Chat, einer Mail oder
einem Screenshot stand oder noch ein Entwicklungswert ist. `SESSION_SECRET`
und `DOWNLOAD_SIGNING_SECRET` können ohne Datenverlust gewechselt werden
(Folge: alle müssen sich neu anmelden, alte Download-Links verfallen).
`N8N_API_KEY`, `CRON_SECRET` und `CT_SYNC_SERVICE_TOKEN` müssen gleichzeitig in
n8n bzw. ChurchTools nachgeführt werden.

Das sind **10** Punkte.

## 6. Vorschläge für später

- **CSP ohne `'unsafe-inline'`:** pro Anfrage eine Nonce erzeugen, jedes
  Inline-Skript damit kennzeichnen und `'unsafe-inline'` streichen. Eigenes
  Arbeitspaket, weil alle Ansichten und der Roh-Ausgabe-Sweep angepasst werden
  müssen. Heute durch die übrige strenge CSP und das Escaping abgefedert.
- **Fehler-Handler: `headersSent`-Schutz** in `src/app.js`. Wirft ein Handler,
  nachdem die Antwort schon begonnen hat, wird die Verbindung hart geschlossen
  statt sauber beendet. Kein Absturz, daher keine Regression.
- **Grenzen der async-Prüfung:** Der Sweep-Test (`asyncHandlerSweep.test.js`)
  erfasst asynchrone Pfeilfunktionen ohne Block nicht, wenn sie nicht mit
  `(req` beginnen. Heuristik bei Bedarf verschärfen.
- **Test-Node:** lokale Testumgebung auf Node >= 22.23.4 heben.
- **Optional:** zlib-Fehler der Anfrage genauer klassifizieren, ZIP-01
  beobachten (neue Version von adm-zip), Login-Zeitlimit-Fall (Erfassung als
  token_fehler/profil_fehler) explizit testen.

## 7. Offene Punkte

- **Nachprüfung von aussen nach dem Aufspielen** des neuen Stands (Task 7):
  Header (HSTS, Permissions-Policy, COOP/CORP, kein X-Powered-By), kaputtes
  JSON -> 400, die neuen Seiten (Audit-Prüfung, Kommentare u. a.), und TLS 1.0/1.1.
- **Test auf echten Handys und Tablets:** die Prüfung war nicht-visuell; neue
  Header (z. B. COOP/CORP) sollten PDF-Vorschau, Thumbnails und Download auf
  echten Geräten bestätigt werden.
- **Lokales Node unter dem neuen Minimum:** Die Testläufe dieser Prüfung liefen
  auf Node 22.23.3, also unter der neuen Untergrenze 22.23.4. Lokal auf
  >= 22.23.4 heben und die Tests wiederholen.
- Eine Umgebungsnotiz: Die Testumgebung hat ausserhalb des Projekts einen
  Schriftarten-Link angelegt (`/config/.fonts`); er hat keine Wirkung auf das Portal.

## 8. Anhang (technisch)

### Abhängigkeiten nach den Fixes (direkt)

adm-zip 0.6.1, asn1js 3.0.10, cookie-parser 1.4.7, csrf-csrf 4.0.3, ejs 3.1.10,
express 4.22.3 (kein Major-Sprung), express-rate-limit 8.6.2, express-session
1.19.0, jsqr 1.4.0, multer 2.5.0, mupdf 1.28.0, nodemailer 10.2.1, pdf-lib 1.17.1,
pdf-rfc3161 0.1.4, pkijs 3.4.0. Dev: pdfkit 0.19.1, playwright 1.63.0,
supertest 7.2.2, swissqrbill 4.4.1, undici 6.29.1.
Transitiv aktualisiert: body-parser 1.20.9, proxy-addr 2.0.8, ip-address 10.7.5,
brace-expansion 2.1.7. `engines.node` = `>=22.23.4` (package.json und Lockfile).

`npm audit`: **0 Schwachstellen.** `npm test`: 2315 von 2315 grün, keine
übersprungenen Tests (Stand nach Fix-Runde 1).

### Neue Sicherheitstests (`test/sicherheit/`)

- `zugriffSweep.test.js` – Zugriff auf fremde Vorgänge/Dateien (IDOR) und signierte Download-Links.
- `integritaetAppendOnly.test.js` – Nachweis-Tabellen append-only (inkl. `freigaben`), unveränderliche Spalten.
- `verfuegbarkeit.test.js` – gzip-Wächter (A4-03), defekter JSON/gzip-Body (A4-04), ChurchTools-Zeitlimit (A4-01), Prozess-Wächter (A4-02), `/healthz`.
- `asyncHandlerSweep.test.js` – jeder asynchrone Handler ist abgesichert; DB-Fehler ergibt 500, Prozess läuft weiter.

Ergänzt in bestehenden Tests: Header-Test in `test/integration/app.test.js`
(HSTS, Permissions-Policy, COOP/CORP, x-powered-by), `testmodusWeiche.test.js`.
Prüfskript Aussen: `scripts/pruefung/aussen.mjs` (liest das Ziel aus der
Umgebungsvariable `PRUEF_ZIEL_URL`; keine Adresse im Repository).

### Commits (Branch feature/abschlusspruefung)

| Commit | Inhalt |
|---|---|
| a534caf | test(pruefung): Aussen-Prüfskript |
| 96788b9 | Zugriff/Integrität: Tests |
| 6a427d1 | test(sicherheit): Verfügbarkeit und Betrieb |
| a97aac5, 64b1fed, 8d0c306, bd1b4a3 | fix(sicherheit): Behebungswelle (Abhängigkeiten, Header, Trigger, Zeitlimit, Wächter) |
| 43758f3 | fix(sicherheit): Fehlerpfade abgesichert (async-Wrapper, Login-503, Lockfile) |
