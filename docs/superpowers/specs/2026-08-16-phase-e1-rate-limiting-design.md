# Sub-Phase E1 – Rate-Limiting — Design

## Kontext & Phasenplan

Dies ist der erste Teil von Phase E (Härtung & Deployment), der letzten Phase
des Freigabeportal-Projekts. Phasen A (Auth), B (Admin-Bereich), C
(n8n-Schnittstelle), D1 (PDF-Verarbeitung), D2 (Freigabe-Workflow-UI), D3
(Ablehnung/Rückweg) und D4 (Mailversand) sind bereits vollständig umgesetzt
und auf `master` gemerged.

Der ursprüngliche Lastenheft-Abschnitt 8 (Sicherheitsanforderungen) verlangt
"Rate-Limiting auf allen öffentlichen Endpunkten". Jede D1–D4-Spec hat dies
explizit auf Phase E verschoben.

### Phasenplan (Kontext)

Phase E wird in drei unabhängige Sub-Phasen aufgeteilt, da sie inhaltlich
sehr unterschiedliche Arbeit sind:

- **E1 – Rate-Limiting** (dieses Dokument): Middleware-Ergänzung mit echten
  Code-Änderungen, folgt dem etablierten Spec → Plan → Umsetzung-Zyklus.
- **E2 – Security-Review-Pass**: Audit des bestehenden Codes, erzeugt eine
  Findings-Liste zur Behebung — eher ein Review-Workflow als ein
  Feature-Build.
- **E3 – Infomaniak-Deployment**: Operatives Runbook (Account/DNS-Setup,
  Env-Variablen, Task-Scheduler-Einträge für beide Cron-Jobs, Verifikation
  von `node:sqlite` auf dem Hosting) — wird zuletzt gemacht, damit danach
  nichts mehr neu deployed werden muss.

Reihenfolge: E1 → E2 → E3. Jede Sub-Phase bekommt ihren eigenen
Design → Spec → Plan → Umsetzung-Zyklus.

## Architektur & Übersicht

`express-rate-limit` wird als neue Abhängigkeit eingeführt (keine eigenen
Laufzeit-Abhängigkeiten, passt zum bestehenden schlanken Dependency-Profil
neben `express-session`). Zähler leben ausschliesslich im Prozessspeicher
(`MemoryStore`, die Standardimplementierung von `express-rate-limit`) — das
passt zur bereits überall im Code dokumentierten Single-Process-Annahme
(`node:sqlite`s `DatabaseSync`, der Session-Store, die Kommentare in
`jobsRepo.js` zu synchroner Ausführung ohne Interleaving). Keine neue
Infrastruktur, kein Redis.

Eine neue Datei `src/middleware/rateLimit.js` folgt demselben
Factory-Pattern wie die bestehenden `apiKey.js`/`cronAuth.js`/`roles.js`:
drei Factory-Funktionen, die je einen vorkonfigurierten Limiter für eine
Stufe erzeugen. `createApp()` ruft diese Factories bei jedem Aufruf frisch
auf (keine Modul-Level-Singletons) — dadurch bekommt jeder Test, der
`createApp({ db, config })` neu aufruft (praktisch jede Testdatei in diesem
Projekt), automatisch eigene, isolierte Zähler, ohne eine
`NODE_ENV === 'test'`-Sonderbehandlung. Eine solche umgebungsabhängige
Bypass-Verzweigung wird bewusst vermieden: sie ist genau die Art Code, die
in Produktion versehentlich aktiv bleiben kann, wenn eine Umgebungsvariable
falsch gesetzt ist — und sie ist hier schlicht nicht nötig, da
Instanz-pro-Test die Isolation bereits kostenlos liefert.

Es gibt **einen globalen Limiter pro Stufe**, nicht einen Blanket-Limiter
für die ganze App und nicht einen Limiter pro einzelner Route — die drei
Stufen unterscheiden sich in Form (Traffic-Volumen, Sensitivität,
legitime Burst-Muster wie ein n8n-Bulk-Upload) genug, um eigene
Konfigurationen zu rechtfertigen, aber nicht genug, um pro-Route-Tuning zu
brauchen.

## Stufen & Limits

| Stufe | Routen | Limit | Begründung |
|---|---|---|---|
| Öffentlich | `/auth/*`, `/downloads/:jobId`, `/branding/*`, `/` | 100 Anfragen / 15 Min pro IP | Grosszügig genug für echte Nutzer, die einen Mail-Link mehrfach anklicken; bremst automatisiertes Scannen/Signatur-Raten |
| Session-authentifiziert | `/pool`, `/api/pool`, `/kontierung`, `/freigabe2`, `/abgelehnt`, `/admin/*` | 300 Anfragen / 15 Min pro Person | Hoch genug, dass eine intensive Bearbeitungs-Session (viele Rechnungen nacheinander) nie gedrosselt wird |
| Maschine-zu-Maschine | `/api/n8n/jobs/*`, `/internal/cron/*` | 60 Anfragen / 1 Min pro IP | n8n-Polling/-Uploads und die geplanten Infomaniak-Cron-Aufrufe sind bereits über ein Secret abgesichert; dies ist ein DoS-/Missbrauchs-Backstop, kein Auth-Mechanismus, und kann daher grosszügig sein |

`/healthz` ist explizit von allen drei Limitern ausgenommen — es ist ein
Infrastruktur-Endpunkt, der planmässig von Infomaniak/externen
Uptime-Monitoren angefragt wird; ein Drosseln würde zu falschen
"Down"-Alarmen führen und den Zweck des Endpunkts untergraben.

## Keying-Strategie

- **Öffentliche Stufe**: Key = `req.ip`. Es gibt keine Person, an die man
  binden könnte. `app.js` setzt bereits `app.set('trust proxy', 1)`, sodass
  `req.ip` hinter Infomaniaks Reverse-Proxy korrekt die echte Client-IP
  liefert — keine weitere Konfiguration nötig.
- **Session-authentifizierte Stufe**: Key = `req.currentPerson.churchtools_person_id`.
  Kirchgemeinde-Personal arbeitet vermutlich aus einem gemeinsamen
  Büro-Netz/derselben IP; ein IP-basiertes Limit würde Mitarbeitende
  gegenseitig drosseln. Fällt auf `req.ip` zurück, falls
  `req.currentPerson` aus irgendeinem Grund fehlt (sollte durch
  `requireRole`, das vor jedem dieser Mounts sitzt, praktisch nie
  vorkommen, ist aber ein sicherer Fallback statt eines Crashs).
- **Maschine-Stufe**: Key = `req.ip`. Es gibt keine Person; die
  eigentliche Autorisierung läuft bereits über `X-API-Key`/`X-Cron-Secret`,
  IP ist hier nur ein sekundärer Drosselwert.

## Antwortformat bei Überschreitung

Alle drei Stufen antworten einheitlich mit **429 + minimalem JSON-Body**
(`{ error: 'Zu viele Anfragen, bitte später erneut versuchen.' }`) — das
entspricht der bestehenden Konvention dieses Codebase für
Middleware-Level-Ablehnungen (`apiKey.js`/`cronAuth.js` antworten bei
Auth-Fehlern ebenfalls mit JSON, nicht mit gerenderten Views; gerenderte
Views entstehen erst auf Route-Handler-Ebene). Da ein einzelner Limiter
über Routen mit unterschiedlichen Antwortformaten hängt (`downloads.js`
antwortet z. B. mit JSON, `auth.js` mit gerenderten Views), ist ein
einheitliches JSON-429 die pragmatischste, konsistenteste Wahl.

Alle drei Stufen setzen zusätzlich die modernen `RateLimit-*`-Antwort-Header
(nicht die veralteten `X-RateLimit-*`), damit sich wohlerzogene Clients wie
n8n selbst drosseln können.

## Fehlerbehandlung

- Ein Limiter-Treffer ist kein Fehler im Sinne der bestehenden
  Error-Handling-Middleware (`app.js`s letzter `app.use((err, req, res, next) => ...)`)
  — er wird direkt in der Limiter-Middleware selbst mit 429 beantwortet,
  bevor die Anfrage den eigentlichen Route-Handler erreicht.
- `/healthz` bypass (siehe oben) ist die einzige explizite Ausnahme.
- Kein Interleaving-Risiko: `express-rate-limit`s Zähler-Inkrement ist pro
  eingehender Anfrage synchron genug, dass es zum bestehenden
  Single-Process-Modell dieser App passt (keine zusätzliche
  Transaktionslogik nötig, das ist reiner In-Memory-Zustand, keine
  SQLite-Schreiboperation).

## Tests

- Für jede der drei Stufen: ein Test, der die konfigurierte Anzahl
  Anfragen überschreitet und einen `429` mit dem korrekten JSON-Body und
  den `RateLimit-*`-Headern erwartet.
- Ein Test, der bestätigt, dass `/healthz` auch nach Überschreiten des
  öffentlichen Limits weiterhin `200` liefert.
- Ein Test, der bestätigt, dass zwei verschiedene Personen (Session-Stufe)
  bzw. zwei verschiedene IPs (öffentliche/Maschine-Stufe) unabhängige
  Zähler haben — keine gegenseitige Drosselung.
- Volle Suite (`node --test 'test/**/*.test.js'`) muss unverändert grün
  bleiben — insbesondere `test/integration/admin/authz-sweep.test.js`
  (21 Routen × 2 Auth-Checks pro Testlauf) und
  `test/integration/mailversandEndToEnd.test.js` (~10 Anfragen pro
  Testlauf) bleiben beide deutlich unter selbst der strengsten Stufe
  (60/Min); dies wird beim finalen vollen Testlauf explizit verifiziert,
  nicht nur angenommen.

## Nicht Teil von Sub-Phase E1

Kein persistenter/geteilter Store (Redis o. ä.) — die App läuft
single-process, ein In-Memory-Store ist ausreichend und konsistent mit
jeder anderen Zustandsannahme im Code. Keine admin-konfigurierbaren
Limit-Werte — das sind Ops-Level-Konstanten, kein Laufzeit-Setting im
Admin-Bereich (ein kompromittierter Admin-Account könnte sonst die eigenen
Schutzmassnahmen hochsetzen). Kein feineres Tuning innerhalb einer Stufe
(z. B. ein eigenes, strengeres Sub-Limit nur für `/auth/callback`) — falls
sich das als nötig erweist, ist das eine spätere, gezielte Verfeinerung,
kein Teil dieser Sub-Phase. Security-Review-Pass (E2) und Infomaniak-
Deployment (E3) sind eigene Sub-Phasen mit eigenen Specs.
