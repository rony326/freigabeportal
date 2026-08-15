# Sub-Phase D4 – Mailversand — Design

## Kontext & Phasenplan

Aus Lastenheft Abschnitt 9 (Fallstrick, teilweise): *"...Freigeber 1 bzw. die kontierende Person wird per Mail benachrichtigt..."* Aus D1s Phasenplan-Vorschau: *"D3 – Ablehnung/Rückweg & Mailversand: Rückwärtspfad bei Ablehnung, tatsächlicher Versand von Zuweisungs-/Reminder-/Eskalations-Mails."* Beim Brainstorming für D3 wurde dieser ursprünglich kombinierte Umfang aufgeteilt, da der volle Umfang (Rückweg-Workflow inkl. Audit-Trail-Stempelung **plus** ein vollständiges Mail-System) zusammen vergleichbar gross war wie D1+D2. D3 lieferte den Rückweg-Workflow vollständig ohne jede E-Mail (Ablehnungen sind über die Pool-Seite auffindbar). D4 liefert nun die tatsächlich versendeten Benachrichtigungen als Komfort-Schicht obendrauf.

### Phasenplan (Kontext)

- Phase A – Fundament & Auth (abgeschlossen, gemerged)
- Phase B – Admin-Bereich (abgeschlossen, gemerged)
- Phase C – n8n-Schnittstelle & Job-Datenmodell (abgeschlossen, gemerged)
- Phase D – Freigabe-Workflow-UI
  - D1 – PDF-Verarbeitung (abgeschlossen, gemerged)
  - D2 – Freigabe-Workflow-UI (abgeschlossen, gemerged)
  - D3 – Ablehnung/Rückweg (abgeschlossen, gemerged)
  - **D4 – Mailversand (dieses Dokument)**
- Phase E – Härtung & Deployment (inkl. Rate-Limiting)

## Architektur & Übersicht

Ein neues Modul `src/services/notify.js` ist die einzige Stelle im gesamten Projekt, die `mailer.sendMail` aufruft: `sendNotification(db, mailer, { to, subject, text, typ, jobId })`. Es versucht den Versand und schreibt — bei Erfolg wie bei Fehlschlag — genau eine Zeile in eine neue Tabelle `mail_log` (vollständiger Inhalt: Empfänger, Betreff, Text, Typ, Job-Bezug, Status, Fehlermeldung, Zeitpunkt). `sendNotification` wirft niemals — jede Aufrufstelle im Rest der App (Routen, Cron) feuert sie ab und macht ungeachtet des Ausgangs weiter, sodass ein ausgefallener SMTP-Server niemals eine Kontierungs-/Freigabe-/Ablehnungs-Transaktion blockieren oder zurückrollen kann.

Fünf Aufrufstellen werden zu "Zuweisungs-Mail"-Auslösern — überall dort, wo ein Job für eine bestimmte Person handlungsrelevant wird, ohne dass es einen anderen aktuellen Entdeckungsweg gibt (deckungsgleich mit der beim D2-Brainstorming gewählten "alle stillen Übergaben"-Option, jetzt um D3s Ablehnungsfall erweitert):

1. Regel-basierte Auto-Zuweisung bei Job-Erstellung (`src/routes/n8n/jobs.js`) → Mail an `freigeber1_id`.
2. Freigabe-1-Interessenskonflikt-Eskalation (`kontierung.js`) → Mail an `stellvertreter1_id`.
3. Abschluss von Freigabe 1, Übergabe an Freigabe 2 (`kontierung.js`) → Mail an `freigeber2_id`.
4. Freigabe-2-Interessenskonflikt-Eskalation (`freigabe2.js`) → Mail an `stellvertreter2_id`.
5. Ablehnung (`freigabe2.js`s Ablehnen-Zweig) → Mail an den Job-Eigentümer (`zugewiesen_an`) — dies ist die im Lastenheft explizit genannte "Ablehnungs-Benachrichtigung".

Ein neuer Cron-ausgelöster Sweep (`POST /internal/cron/pool-erinnerungen`, gleiches `requireCronSecret`-Muster wie der bestehende `sync-personen`-Endpunkt) findet Pool-Jobs, die älter sind als `reminder_stunden`/`eskalation_stunden`, und löst Reminder-/Eskalations-Mails aus — jede genau einmal pro Job (nachverfolgt über neue Job-Spalten nach dem Muster von `fetched_by_n8n_at`), nicht bei jedem Cron-Tick erneut.

Alle Mail-Inhalte sind Deutsch, reiner Text (passend zu `mailer.js`s bestehender `sendMail({ to, subject, text })`-Signatur — keine HTML-Template-Engine wird eingeführt), und jeder Link ist der generische `/pool`-Link.

## Datenmodell

**Neue Tabelle `mail_log`** (append-only, Retry-Queue und Audit-Trail zugleich):
```sql
CREATE TABLE IF NOT EXISTS mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung')),
  job_id INTEGER REFERENCES jobs(id),
  empfaenger TEXT NOT NULL,
  betreff TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen')),
  fehler_details TEXT,
  versucht_am TEXT NOT NULL
)
```
`job_id` ist nullable, bleibt aber generisch für mögliche künftige, nicht job-bezogene Mails. Ein Retry ruft `sendNotification` erneut mit dem gespeicherten Empfänger/Betreff/Text/Typ/Job-Bezug auf und hängt eine neue Zeile an (append-only, kein Update der bestehenden Zeile — bewahrt die vollständige Retry-Historie statt den Fehlschlag zu überschreiben).

**Zwei neue `jobs`-Spalten**, nach dem Muster von `fetched_by_n8n_at`: `reminder_gesendet_at TEXT`, `eskalation_gesendet_at TEXT`. Der Cron-Sweep löst eine Reminder-Mail nur für einen Pool-Job aus, dessen `reminder_gesendet_at IS NULL` ist und dessen Alter `reminder_stunden` überschreitet, und setzt danach die Spalte — analog für Eskalation. Ein Job, der beansprucht und später wieder in den Pool zurückgelegt wird (`releaseJob`, aus D2), bekommt beide Spalten zurückgesetzt, genauso wie er bereits die Freigabe-1-Eskalationsspalten zurücksetzt, damit ein neuer Pool-Zyklus sauber beginnt.

**Verallgemeinerung der `admin_config`-Empfängerlisten**: `eskalation_fallback_email` (eine einzelne Pflicht-E-Mail, Phase B) wird durch zwei neue Mehrfach-Ziel-Schlüssel ersetzt, `reminder_empfaenger` und `eskalation_empfaenger`, je gespeichert als zeilenweise getrennte Ziele, wobei jede Zeile entweder eine literale E-Mail-Adresse oder das Token `gruppe:buchhaltung` ist (zur Sendezeit auf jede aktive Person dieser ChurchTools-Gruppe aufgelöst). Beide sind standardmässig auf `gruppe:buchhaltung` voreingestellt, damit eine frische Installation ohne Admin-Konfiguration sinnvoll funktioniert.

## Mail-Trigger-Punkte (Zuweisungs-Mail) & Inhalte

Jeder Auslöser ist ein einzelner Aufruf direkt nach dem zugehörigen DB-Schreibvorgang, im selben Routen-Handler, aber **ausserhalb** des `db.exec('BEGIN')`/`COMMIT`-Blocks (Mail ist ein Post-Commit-Seiteneffekt, niemals daran gekoppelt) — z. B. in `kontierung.js`s konfliktfreiem Zweig direkt nach `db.exec('COMMIT')` und vor `res.redirect('/pool')`:

```javascript
sendNotification(db, mailer, {
  to: freigeber2Person.email,
  subject: 'Freigabeportal: Neue Rechnung zur Freigabe 2',
  text: `Eine Rechnung wartet auf deine Freigabe 2: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${baseUrl}/pool`,
  typ: 'zuweisung',
  jobId: job.id,
});
```

Alle fünf Auslöser folgen dieser Form — Ziel-Person-E-Mail beschaffen (bereits per `getPersonById` verfügbar oder bereits im Handler geladen), kurzen deutschen Betreff + Text mit Rechnungs-Dateiname und `/pool`-Link zusammensetzen, `sendNotification` aufrufen. Die Ablehnungs-Benachrichtigung (Auslöser 5) enthält zusätzlich den Ablehnungsgrund im Text, entsprechend der Lastenheft-Anforderung. `mailer` und eine `baseUrl` (zum Aufbau des Links — dafür kommt eine neue Pflicht-Umgebungsvariable `PUBLIC_BASE_URL` hinzu, da bisher nichts in `config` die öffentliche URL des Portals selbst bereitstellt) werden in jeden betroffenen Router genauso durchgereicht wie bereits `db`/`config`.

Die Reminder-/Eskalations-Mail-Texte listen die noch unbeanspruchten Job(s) mit Dateiname und Alter auf; der Eskalations-Text macht explizit deutlich, dass dies die zweite, dringlichere Benachrichtigung ist.

## Reminder-/Eskalations-Sweep (Cron)

`POST /internal/cron/pool-erinnerungen`, geschützt durch die bestehende `requireCronSecret(config)`-Middleware (gleiches Muster wie `/internal/cron/sync-personen`), gedacht zum Aufruf durch einen externen Betriebssystem-Cron im gleichen Intervall-Rhythmus wie n8ns Polling.

```javascript
export function createPoolErinnerungenRouter({ db, config, mailer }) {
  const router = Router();
  router.post('/', requireCronSecret(config), async (req, res) => {
    const reminderStunden = Number(getConfigValue(db, 'reminder_stunden'));
    const eskalationStunden = Number(getConfigValue(db, 'eskalation_stunden'));

    const reminderJobs = listPoolJobsOlderThan(db, reminderStunden, 'reminder');
    for (const job of reminderJobs) {
      const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'reminder_empfaenger'));
      for (const email of empfaenger) {
        sendNotification(db, mailer, { to: email, subject: '...', text: '...', typ: 'reminder', jobId: job.id });
      }
      markReminderGesendet(db, job.id);
    }
    // gleiche Form für eskalationJobs / eskalation_empfaenger / markEskalationGesendet
    res.json({ status: 'erfolg', reminder: reminderJobs.length, eskalation: eskalationJobs.length });
  });
  return router;
}
```

`resolveEmpfaenger(db, config, konfigWert)` parst den zeilenweise getrennten Konfigurationswert, expandiert jede `gruppe:buchhaltung`-Zeile auf jede aktive Person dieser ChurchTools-Gruppe (über die bereits synchronisierte `personen`-Tabelle — kein Live-ChurchTools-Aufruf nötig, nutzt die nächtlichen Sync-Daten) und dedupliziert. Ein `sendNotification`-Aufruf pro aufgelöstem Empfänger (keine einzelne Mail mit allen im `To:`/`Cc:`-Feld, damit Empfänger sich gegenseitig nicht sehen).

`listPoolJobsOlderThan(db, hours, 'reminder')` ist eine neue `jobsRepo.js`-Abfrage: Status `unzugewiesen`, `eingang_am` älter als der Schwellenwert, und die zugehörige `_gesendet_at`-Spalte noch `NULL` — derselbe Job kann beide Schwellenwerte unabhängig voneinander überschreiten (Reminder feuert einmal, später Eskalation einmal), jeweils durch seine eigene Spalte geschützt.

## Admin-Bereich

**Überarbeitung von `/admin/eskalation`**: das bestehende Formular mit `reminderStunden`/`eskalationStunden`/`eskalationFallbackEmail` bekommt statt des einzelnen E-Mail-Felds zwei Textareas — "Reminder-Empfänger" und "Eskalations-Empfänger" — eine Zielangabe pro Zeile, jede Zeile validiert als entweder eine echte E-Mail-Adresse oder das exakte Token `gruppe:buchhaltung` (vorerst hartcodiert als einziges erkanntes Gruppen-Token, passend zur einzigen aktuell relevanten Gruppe der App). Pro Feld ist mindestens eine Zielangabe Pflicht. Route/View folgen dem gleichen Muster wie jedes andere Admin-Formular in diesem Projekt (`src/routes/admin/eskalation.js`, `views/admin/eskalation-form.ejs`).

**Neue Seite `/admin/mails`**: listet `mail_log`-Zeilen, neueste zuerst, je mit Zeitpunkt, Empfänger, Betreff, Typ, Status und — bei fehlgeschlagenen Zeilen — Fehlermeldung und einem "Erneut versenden"-Button (`POST /admin/mails/:id/erneut-versenden`), der `sendNotification` mit den gespeicherten Werten dieser Zeile (Empfänger/Betreff/Text/Typ/Job-Bezug) erneut aufruft und eine neue Log-Zeile anhängt. Neuer Router `src/routes/admin/mails.js`, neue View `views/admin/mails.ejs`, beide unter dem bestehenden `requireRole(config, 'portal-admin')`-Schutz zusammen mit den anderen Admin-Routern gemountet, mit neuem Eintrag in `views/admin/_nav.ejs`.

## Fehlerbehandlung

- **SMTP gar nicht konfiguriert** (fehlende Umgebungsvariablen — der aktuelle Vor-D4-Standardfall für jeden Dev-Checkout): in Erweiterung des "Mail blockiert nie den Kernablauf"-Prinzips fängt `src/app.js` den einmaligen `createMailer(config.smtp)`-Aufruf beim Start mit try/catch ab; wirft er, wird ein No-Op-Ersatz-Mailer verwendet, dessen `sendMail` stets einen klaren Fehler "SMTP nicht konfiguriert" wirft — den `sendNotification` abfängt und als `fehlgeschlagen` in `mail_log` protokolliert. Die App startet und funktioniert normal, Mail schlägt einfach immer fehl, genau wie heute, statt beim Start wegen fehlender SMTP-Zugangsdaten abzustürzen. Echte Deployments bekommen trotzdem ein deutliches, sichtbares Signal: jeder Sendeversuch erscheint fehlgeschlagen in `/admin/mails`.
- Das Admin-Empfängerlisten-Formular validiert jede Zeile als entweder echte E-Mail oder das literale Token `gruppe:buchhaltung`, 400 nach bestehendem Projektmuster sonst.
- Der Cron-Sweep-Endpunkt liefert die bestehende `requireCronSecret`-401-Form bei fehlendem/falschem Secret, analog zu `/internal/cron/sync-personen`.
- Ein Retry, der ebenfalls fehlschlägt, erzeugt einfach eine weitere `fehlgeschlagen`-Zeile — keine Sonderbehandlung in der UI, die Admin-Seite zeigt sie beim nächsten Laden einfach an.

## Tests

Wie in Phase A–D3: echte HTTP-Requests via `supertest`, echte In-Memory-SQLite-DB, keine Mocks der eigenen Business-Logik. Die externe Grenze ist hier SMTP selbst, daher wird `mailer` in jeden Router injiziert, genau wie `db`/`config` es bereits sind — Tests übergeben einen Stub `{ sendMail: async (opts) => {...} }`, der nach Bedarf erfolgreich sein oder werfen kann, sodass sowohl der Erfolgspfad (`mail_log`-Zeile `versendet`) als auch der Fehlschlag-/Retry-Pfad (`fehlgeschlagen`, dann ein echter Retry mit neuer `versendet`-Zeile) gegen den echten Routen-/Service-Code dieses Projekts getestet werden, während nodemailers eigene SMTP-Mechanik ausserhalb des Testumfangs bleibt (gleiches Prinzip wie das Nicht-Testen von pdf-libs eigener Korrektheit in D1).

Abdeckung: jeder der 5 Zuweisungs-Mail-Auslöser feuert mit korrektem Empfänger/Inhalt; der Reminder-/Eskalations-Sweep ist idempotent (ein zweiter Cron-Lauf sendet nicht erneut); `resolveEmpfaenger` expandiert `gruppe:buchhaltung` korrekt und dedupliziert; die Admin-Retry-Aktion sendet erneut und protokolliert eine neue Zeile; `releaseJob` setzt die beiden neuen `_gesendet_at`-Spalten zurück.

## Nicht Teil von Sub-Phase D4

HTML-formatierte E-Mails (nur Klartext, passend zu `mailer.js`s bestehender Signatur). Ein zweites/konfigurierbares ChurchTools-Gruppen-Token über `gruppe:buchhaltung` hinaus. Jede Änderung am Login-Flow (Mail-Links bleiben generisch zu `/pool`, kein Rückkehr-nach-Login-Mechanismus). Automatischer Retry fehlgeschlagener Sendungen (Retry ist eine explizite Admin-Aktion, kein Hintergrund-Retry-Scheduler). Rate-Limiting auf dem neuen Cron-Endpunkt (Phase E, wie bei jeder anderen Route auch).
