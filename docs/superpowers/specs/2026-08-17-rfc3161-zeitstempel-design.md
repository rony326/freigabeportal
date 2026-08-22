# RFC3161-Zeitstempel für abgeschlossene Rechnungen — Design

## Kontext

Langfristiges Ziel des Projekts ist die Abschaffung des Papier-Rechnungsarchivs zugunsten einer rein digitalen, GeBüV-konformen Archivierung (siehe Projekt-Memory `project_paperless_archival_goal`). GeBüV verlangt für elektronisch archivierte Buchhaltungsunterlagen, die Papier-Originale ersetzen sollen, einen Nachweis, dass das archivierte Dokument seit einem bestimmten Zeitpunkt unverändert ist.

Das Tool zeichnet bereits (seit der jüngsten Umstellung, siehe `src/services/pdfStamp.js`) eine für Menschen lesbare Freigabe-Historie (wer hat wann mit welcher IP freigegeben, vollständiges Audit-Log) als Text auf eine selbst angehängte PDF-Seite. Das ist eine Prozesskontrolle, aber kein kryptographischer Integritätsnachweis — jeder mit einem PDF-Editor könnte diesen Text nachträglich verändern, ohne dass es auffällt.

Ein RFC3161-Zeitstempel (nicht eine zertifikatsbasierte Signatur) schliesst genau diese Lücke: er beweist "dieser exakte Datei-Hash existierte unverändert zum Zeitpunkt T", ohne dass eine Signier-Identität (Zertifikat, privater Schlüssel pro Person) verwaltet werden muss. Das passt zum bestehenden Modell, bei dem "wer hat freigegeben" bereits über den eingeloggten ChurchTools-Account und das Audit-Log abgedeckt ist.

**Leitentscheidungen aus dem Brainstorming (bereits vom Nutzer bestätigt):**
- Zeitstempel statt Zertifikats-Signatur (siehe oben).
- Start mit [FreeTSA](https://www.freetsa.org/) (kostenlos, RFC3161-konform, `https://freetsa.org/tsr`) — TSA-Endpunkt muss aber jederzeit ohne Code-Änderung austauschbar sein (Ziel: später ein akkreditierter Anbieter wie SwissSign).
- TSA-Ausfall beim Abschluss von Freigabe 2 blockiert die Freigabe **nicht** — der Zeitstempel wird best-effort nachgeholt.
- **Aber:** die Abholung durch n8n ist gesperrt, bis der Zeitstempel gesetzt ist (nur solange das Feature aktiv ist, siehe unten "n8n-Abholung-Sperre"). Damit verschwindet das ursprünglich akzeptierte Restrisiko aus der "Bekannten Einschränkung" praktisch vollständig — auf Kosten eines neuen Risikos bei dauerhaftem TSA-Ausfall (siehe dort). Eine Admin-Warnung (siehe unten) macht diesen Fall sichtbar.
- Nachholen: automatisch per Cron **und** manuell auslösbar im Admin-Bereich.
- TSA-Konfiguration (URL, optional Benutzername/Passwort) liegt in der bestehenden `admin_config`-Tabelle, admin-editierbar über die UI — bewusste Abweichung vom sonstigen Muster dieses Projekts, wonach Geheimnisse ausschliesslich in `.env` liegen (SMTP-Passwort, API-Keys). Das TSA-Passwort liegt damit im Klartext in der SQLite-DB.
- Verifikation ist **im Portal selbst** möglich, allgemein verfügbar (keine Admin-Rolle nötig), über zwei Einstiegspunkte (siehe unten).

## Bibliothek

[`pdf-rfc3161`](https://www.npmjs.com/package/pdf-rfc3161) (npm, MIT, Node ≥20, pure JS, keine nativen Abhängigkeiten). Bettet einen echten PAdES-konformen `ETSI.RFC3161`-DocTimeStamp direkt ins PDF ein (verifizierbar auch ausserhalb des Portals, z.B. in Adobe Acrobat) — kein separates Sidecar-File nötig. Liefert die Bausteine für beide Richtungen:

```js
const result = await timestampPdf({ pdf: pdfBytes, tsa: { url, auth } });
// result.pdf ist der neue, zeitgestempelte PDF-Buffer

const timestamps = await extractTimestamps(pdfBytes);
const verified = await verifyTimestamp(timestamps[0]);
```

Einschränkung des Projekts (nicht dieser Bibliothek): kleines Projekt (2 Stars, ein Maintainer, 7 Monate alt) — funktional passend, aber ein Bus-Factor-Risiko, das im Hinterkopf bleiben sollte.

**Wichtig zum Verständnis:** Ein PAdES-DocTimeStamp ist **unsichtbar** im Seiteninhalt — anders als die von `pdfStamp.js` gezeichneten Freigabe-Blöcke ist er eine kryptographische Struktur im PDF-Innenleben, kein sichtbarer Text. Der im Portal bereits verwendete PDF.js-Viewer zeigt dafür kein Signatur-Panel an (anders als z.B. Adobe Acrobat) — ohne die unten beschriebene Prüf-Funktion wäre der Zeitstempel für Nutzer des Portals unsichtbar und nicht verifizierbar.

## Datenmodell

- Neue Spalte `jobs.zeitstempel_gesetzt_am TEXT` (NULL = noch kein gültiger Zeitstempel gesetzt, sonst ISO-Zeitpunkt des letzten erfolgreichen Setzens). Kein weiteres Feld nötig — Fehlversuche werden nicht pro Job persistiert, nur im `cron_log` des Nachhol-Laufs sichtbar.
- Neue Spalte `jobs.abgeschlossen_am TEXT` (NULL = Job wurde vor Einführung dieser Spalte abgeschlossen, sonst ISO-Zeitpunkt des Freigabe-2-Abschlusses). Wird von der Admin-Warnung gebraucht, um zu bestimmen, wie lange ein Job schon ohne Zeitstempel wartet — dafür reicht `zeitstempel_gesetzt_am IS NULL` allein nicht, weil das nicht verrät, seit wann.
- Neue `admin_config`-Einträge (Default jeweils leerer String, ausser vermerkt):
  - `zeitstempel_tsa_url` (Default: `https://freetsa.org/tsr`)
  - `zeitstempel_tsa_user` (Default: leer)
  - `zeitstempel_tsa_passwort` (Default: leer)
  - `cron_zeitstempel_nachholen_intervall_minuten` (Default: `5`) — bewusst kurz, siehe Abschnitt "n8n-Abholung-Sperre" unten.
  - `zeitstempel_warnung_ab_stunden` (Default: `2`) — Schwelle für die Admin-Warnung, siehe unten.
- **Leere `zeitstempel_tsa_url` = Feature deaktiviert.** Kein Fehler, kein Log-Eintrag, der Zeitstempel-Schritt wird beim Freigabe-2-Abschluss und im Nachhol-Job einfach übersprungen. So kann die Funktion vor dem ersten TSA-Setup unauffällig inaktiv bleiben.

## Ablauf bei Freigabe-2-Abschluss

In `src/routes/freigabe2.js`, direkt nach dem bestehenden `stampAndFinalize`-Aufruf, vor `writeFileSync`:

```js
stamped = await stampAndFinalize(pdfBuffer, stampData);
const tsaUrl = getConfigValue(db, 'zeitstempel_tsa_url');
let zeitstempelErfolgreich = false;
if (tsaUrl) {
  try {
    const tsaConfig = {
      url: tsaUrl,
      user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
      passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
    };
    stamped = await setZeitstempel(stamped, tsaConfig);
    zeitstempelErfolgreich = true;
  } catch (err) {
    console.error(`Zeitstempel für Job ${job.id} fehlgeschlagen, wird nachgeholt:`, err.message);
  }
}
```

(`zeitstempelErfolgreich` steuert weiter unten, ob die bestehende Transaktion zusätzlich `UPDATE jobs SET zeitstempel_gesetzt_am = ?` ausführt.)

Neue, kleine Service-Datei `src/services/zeitstempel.js` kapselt `pdf-rfc3161`: `setZeitstempel(pdfBuffer, tsaConfig)` (wirft bei Fehler, wie `stampAndFinalize`) und `verifyZeitstempel(pdfBuffer)` (gibt `{ vorhanden, gueltig, zeitpunkt, tsaName }` zurück, wirft nicht — eine fehlende/kaputte Zeitstempel-Struktur ist ein normales, darstellbares Ergebnis, kein Fehlerfall).

Bei Erfolg wird `jobs.zeitstempel_gesetzt_am` in derselben Transaktion wie der übrige Freigabe-2-Abschluss gesetzt. Bei Misserfolg bleibt es `NULL`, und die Freigabe schliesst trotzdem normal ab (Status `abgeschlossen`) — der Aufruf ist bewusst nicht Teil der Transaktion, die bei Fehlschlag zurückgerollt würde.

## Nachhol-Mechanismus

Folgt exakt dem bestehenden Muster aus `src/services/cronJobs.js`/`scheduler.js`/`routes/admin/geplanteJobs.js` (Personen-Sync, Pool-Erinnerungen, PDF-Bereinigung):

- Neue Funktion `runZeitstempelNachholenJob(db, config)` in `cronJobs.js`: sucht `SELECT * FROM jobs WHERE status = 'abgeschlossen' AND zeitstempel_gesetzt_am IS NULL`, versucht pro Job `setZeitstempel`, protokolliert Ergebnis über das bestehende `logCronLauf` (Job-Name `'zeitstempel-nachholen'`) — kein neues Tabellenschema nötig, `cron_log` ist bereits generisch.
- Eingebunden in `scheduler.js` über `scheduleInterval`, liest `cron_zeitstempel_nachholen_intervall_minuten` aus `admin_config`.
- Manueller Trigger: neue Route `POST /admin/geplante-jobs/zeitstempel-nachholen/jetzt-ausfuehren`, neue Sektion in `views/admin/geplante-jobs.ejs` (Log-Anzeige + Button), identisch zu den drei bestehenden Sektionen.
- Neue Route `POST /internal/cron/zeitstempel-nachholen` in `routes/cron.js` für externes/manuelles Auslösen (wie die drei bestehenden).

## n8n-Abholung-Sperre

Sobald n8n einen Job abholt (`POST /api/n8n/jobs/:id/abholung-bestaetigen`), löscht das Portal die lokale PDF-Datei (`src/routes/n8n/jobs.js`). Ein Zeitstempel kann danach nicht mehr nachträglich gesetzt werden — die Datei existiert nicht mehr.

Um das zu verhindern, ist die Abholung gesperrt, solange ein Job keinen Zeitstempel hat **und** das Feature aktiv ist (TSA-URL konfiguriert):

- `GET /api/n8n/jobs/abholbereit` (`listAbholbereitJobs` in `jobsRepo.js`) listet einen `abgeschlossen`-Job erst, wenn `zeitstempel_gesetzt_am IS NOT NULL` — solange nicht, taucht er für n8n einfach gar nicht auf.
- `POST /api/n8n/jobs/:id/abholung-bestaetigen` (`confirmAbholung`) prüft dieselbe Bedingung nochmal atomar im UPDATE, damit auch ein Job, den n8n aus einem anderen Weg schon kennt, nicht ohne Zeitstempel bestätigt werden kann. Antwort in diesem Fall: bestehender `409`, erweiterte Fehlermeldung — kein neuer Status-Code.
- Ist keine TSA-URL konfiguriert (Feature deaktiviert), gilt die Sperre nicht — sonst könnte vor dem ersten TSA-Setup nie etwas abgeholt werden.

Beide Routen ermitteln den Feature-Status selbst über `getConfigValue(db, 'zeitstempel_tsa_url')` und reichen ihn als Boolean-Parameter an die beiden Repo-Funktionen durch.

**Damit verschiebt sich das Restrisiko:** Statt eines fehlenden Häkchens im Dashboard blockiert ein dauerhafter TSA-Ausfall jetzt die komplette Abholung der betroffenen Rechnungen — der Nachhol-Job versucht es zwar unbegrenzt weiter, aber ohne erreichbare TSA bleiben diese Jobs für immer im Status `abgeschlossen` hängen. Die folgende Admin-Warnung macht diesen Zustand aktiv sichtbar, statt ihn nur passiv im Dashboard abzuwarten.

## Admin-Warnung bei überfälligen Zeitstempeln

Auf dem Admin-Dashboard (`GET /admin`, `views/admin/dashboard.ejs`) erscheint ein roter Alert-Banner, sobald mindestens ein `abgeschlossen`-Job seit mehr als `zeitstempel_warnung_ab_stunden` Stunden (Default `2`, admin-konfigurierbar auf derselben Seite wie die TSA-Zugangsdaten, `/admin/zeitstempel`) ohne Zeitstempel wartet:

```
<N> abgeschlossene Rechnung(en) seit über <X> Stunden ohne Zeitstempel — TSA-Konfiguration prüfen.
```

Der Banner verlinkt direkt auf `/admin/zeitstempel`. Neue Repo-Funktion `countZeitstempelUeberfaellig(db, schwellenStunden)`:

```sql
SELECT COUNT(*) FROM jobs
WHERE status = 'abgeschlossen' AND zeitstempel_gesetzt_am IS NULL
  AND abgeschlossen_am IS NOT NULL AND abgeschlossen_am < <jetzt minus schwellenStunden>
```

Die Warnung wird nur berechnet, wenn das Feature aktiv ist (TSA-URL konfiguriert) — sonst wäre sie vor dem ersten TSA-Setup auf jeder frischen Installation fälschlich rot. `abgeschlossen_am IS NOT NULL` schliesst Jobs aus, die vor Einführung dieser Spalte abgeschlossen wurden (deren `abgeschlossen_am` bleibt für immer NULL, siehe "Bewusst nicht Teil dieser Spec"); die sind weiterhin über die Dashboard-Sektion "Meine abgeschlossenen Rechnungen" pro Person sichtbar.

## Verifikation — zwei Einstiegspunkte

Aktuell zeigt keine Seite im Portal einen Job nach Abschluss von Freigabe 2 an (weder `abgeschlossen` noch `abgeholt`/`archiviert` — bestätigt per Code-Suche, es existiert keine entsprechende View). Beide folgenden Punkte sind also neue UI-Flächen, nicht Erweiterungen bestehender Seiten.

### a) Dashboard-Sektion "Meine abgeschlossenen Rechnungen"

Neue Sektion auf `views/pool.ejs`, analog zu den bestehenden ("Meine offenen Kontierungen" etc.). Neue Repo-Funktion `listAbgeschlossenJobsForPerson(db, personId)` in `jobsRepo.js`:

```sql
SELECT jobs.* FROM jobs
JOIN konten ON konten.id = jobs.konto_id
WHERE jobs.status IN ('abgeschlossen', 'abgeholt', 'archiviert')
  AND (
    jobs.zugewiesen_an = ?
    OR (jobs.freigabe2_eskaliert_von IS NULL AND konten.freigeber2_id = ?)
    OR (jobs.freigabe2_eskaliert_von IS NOT NULL AND konten.stellvertreter2_id = ?)
  )
ORDER BY jobs.eingang_am DESC
```

(Gleiche Zugehörigkeits-Logik wie die bestehende `listFreigabe2JobsForPerson`/`canViewJobPdf`, nur auf die drei Abschluss-Status erweitert — `canViewJobPdf` selbst braucht dafür keine Änderung, sie deckt diese Status bereits korrekt ab.)

Pro Zeile: Dateiname, Status, Zeitstempel-Status (`✓ gesetzt am <Datum>` / `ausstehend`). Für Status `abgeschlossen` (Datei noch vorhanden) zusätzlich ein "Jetzt prüfen"-Link — das ist derselbe Prüfmechanismus wie Einstiegspunkt b, nur ohne Datei-Upload: `GET /zeitstempel-pruefen?jobId=<id>` prüft (nach erneutem `canViewJobPdf`-Check) direkt die Datei unter `job.pdf_pfad`, statt eine Upload-Datei zu erwarten. Für `abgeholt`/`archiviert` gibt es keinen solchen Link (Datei existiert nicht mehr) — nur der zuletzt bekannte DB-Status (`zeitstempel_gesetzt_am`) wird angezeigt.

### b) Allgemeines Upload-Prüfwerkzeug

Neue, eigenständige Seite (`GET /zeitstempel-pruefen`, `POST /zeitstempel-pruefen`), erreichbar für jede eingeloggte Person unabhängig von einem bestimmten Job. Formular mit Datei-Upload (PDF); ohne Job-Bezug in der DB. Ergebnis zeigt `verifyZeitstempel`s Rückgabe: vorhanden/nicht vorhanden, gültig/ungültig, Zeitpunkt, TSA-Name falls ermittelbar. Funktioniert auch für PDFs, die das Portal gar nicht mehr kennt (z.B. extern archivierte Kopien in Paperless-ngx) — passt zum Papierarchiv-Ziel, wo Verifizierbarkeit auch nach dem Verschwinden des Original-Jobs aus dieser DB gefragt sein wird.

Dieselbe Route bedient beide Fälle: `GET /zeitstempel-pruefen` ohne `jobId` zeigt das Upload-Formular; mit `?jobId=<id>` (nur erreichbar über den Dashboard-Link aus a) prüft sie direkt die Datei des Jobs, nach erneuter `canViewJobPdf`-Autorisierung — kein Upload-Formular in diesem Fall. Neue Route-Datei `src/routes/zeitstempelPruefen.js`, gemountet unter `/zeitstempel-pruefen` mit `requireLogin()`. Neue View `views/zeitstempel-pruefen.ejs`. Neuer Menüpunkt im Haupt-Menü (`_header.ejs`), sichtbar für jede eingeloggte Person (nicht rollen-gebunden).

## Admin-Konfiguration der TSA

Neue eigenständige Admin-Seite `views/admin/zeitstempel-form.ejs` + `src/routes/admin/zeitstempel.js`, gemountet unter `/admin/zeitstempel` (Portal-Admin-Rolle, wie die übrigen `/admin/*`-Seiten) — folgt exakt dem Formular-Muster von `erscheinungsbild.js` (GET/POST, Validierung, `?gespeichert=1`-Flash). Felder: TSA-URL (Pflicht für aktives Feature, sonst leer lassen zum Deaktivieren), Benutzername (optional), Passwort (optional, wie ein normales Passwortfeld — kein Klartext-Reveal), Admin-Warnung ab (Stunden) — ganze Zahl grösser 0, steuert `zeitstempel_warnung_ab_stunden` (siehe "Admin-Warnung bei überfälligen Zeitstempeln"). Neuer Eintrag im Admin-Dashboard (`views/admin/dashboard.ejs`) und in der Admin-Nav (`views/admin/_nav.ejs`).

## Testing

- Unit-Tests für `src/services/zeitstempel.js`: `setZeitstempel` erfolgreich gegen einen Test-TSA-Mock (kein echter Netzwerk-Call in Tests — `pdf-rfc3161`s TSA-Client müsste dafür injizierbar/mockbar sein, sonst über einen lokalen Mock-HTTP-Server im Test), `verifyZeitstempel` für ein Dokument mit/ohne Zeitstempel, Fehlerfall (TSA nicht erreichbar → Error, wie `stampAndFinalize`).
- Integrationstests für `freigabe2.js`: Zeitstempel-Erfolg setzt `zeitstempel_gesetzt_am`, Zeitstempel-Fehlschlag lässt Freigabe trotzdem abschliessen (`status = 'abgeschlossen'`, `zeitstempel_gesetzt_am` bleibt NULL).
- Unit-Test für `runZeitstempelNachholenJob`: holt ausstehende Jobs nach, protokolliert in `cron_log`, lässt bereits gesetzte/nicht-abgeschlossene Jobs unangetastet.
- Integrationstests für die neue Dashboard-Sektion (`poolPage.test.js`) und das Upload-Prüfwerkzeug (`zeitstempelPruefen.test.js`).
- Integrationstest für `/admin/zeitstempel` (401/403/Validierung/Speichern, inkl. der neuen Warnschwelle), nach dem Muster von `erscheinungsbild.test.js`.
- Unit-Tests für `listAbholbereitJobs`/`confirmAbholung` mit `nurMitZeitstempel`: Job ohne Zeitstempel wird ausgeblendet/abgelehnt, Job mit Zeitstempel wird gelistet/bestätigt, `nurMitZeitstempel = false` ändert nichts am bisherigen Verhalten.
- Integrationstests für `/api/n8n/jobs/abholbereit` und `/api/n8n/jobs/:id/abholung-bestaetigen`: Sperre greift bei konfigurierter TSA, greift nicht bei deaktiviertem Feature, PDF wird bei gesperrter Bestätigung nicht gelöscht.
- Unit-Test für `abschliessenFreigabe2`: setzt `abgeschlossen_am`.
- Unit-Tests für `countZeitstempelUeberfaellig`: zählt überfällige Jobs korrekt, ignoriert bereits gestempelte/noch nicht überfällige/Alt-Jobs ohne `abgeschlossen_am`.
- Integrationstest für den Dashboard-Warnbanner (`app.test.js`, volle `createApp`-Verdrahtung): erscheint bei überfälligen Jobs mit aktiver TSA, erscheint nicht ohne konfigurierte TSA.

## Bewusst nicht Teil dieser Spec (YAGNI)

- Keine automatische Migration/Nachholung für bereits vor diesem Feature abgeschlossene, aber noch nicht abgeholte Jobs — der neue Nachhol-Job deckt das ohnehin ab, sobald er läuft (`zeitstempel_gesetzt_am IS NULL` trifft auf alle bestehenden `abgeschlossen`-Jobs zu).
- Keine Unterstützung für mehrere TSA-Anbieter gleichzeitig oder Fallback-TSA — ein konfigurierter Endpunkt zur Zeit.
- Keine Rückwirkende Zeitstempelung bereits `abgeholt`/`archiviert`er Jobs — technisch unmöglich, da die PDF-Datei nicht mehr existiert (siehe "n8n-Abholung-Sperre").
- Keine automatische Eskalation/Benachrichtigung bei überfälligen Zeitstempeln über den Dashboard-Banner hinaus (kein E-Mail-Alarm) — der Banner ist beim nächsten Admin-Login sichtbar, das reicht für den Anwendungsfall.
- Spesen sind nicht Teil dieser Spec (noch nicht gebaut).

## Betroffene/neue Dateien

**Neu:**
- `src/services/zeitstempel.js`
- `src/routes/admin/zeitstempel.js`, `views/admin/zeitstempel-form.ejs`
- `src/routes/zeitstempelPruefen.js`, `views/zeitstempel-pruefen.ejs`

**Geändert:**
- `src/db/schema.sql`, `src/db/index.js` (Migration: `jobs.zeitstempel_gesetzt_am`, `jobs.abgeschlossen_am`)
- `src/db/adminConfigRepo.js` (neue DEFAULTS, inkl. `zeitstempel_warnung_ab_stunden`)
- `src/db/jobsRepo.js` (neue `listAbgeschlossenJobsForPerson`; `listAbholbereitJobs`/`confirmAbholung` bekommen `nurMitZeitstempel`; `abschliessenFreigabe2` setzt `abgeschlossen_am`; neue `countZeitstempelUeberfaellig`)
- `src/routes/freigabe2.js` (Zeitstempel-Versuch nach `stampAndFinalize`)
- `src/routes/n8n/jobs.js` (Abholung-Sperre auf `/abholbereit` und `/abholung-bestaetigen`)
- `src/services/cronJobs.js`, `src/services/scheduler.js`, `src/routes/cron.js`, `src/routes/admin/geplanteJobs.js`, `views/admin/geplante-jobs.ejs` (neuer Nachhol-Job)
- `src/routes/poolPage.js`, `views/pool.ejs` (neue Dashboard-Sektion)
- `views/_header.ejs` (neuer Menüpunkt)
- `src/app.js`, `views/admin/dashboard.ejs`, `views/admin/_nav.ejs` (neue Admin-Seite verlinken, Warnbanner)
- `package.json` (neue Abhängigkeit `pdf-rfc3161`)
