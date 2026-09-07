# Mail-Vorlagen und Batching — Design

**Status:** Entwurf, zur Prüfung
**Datum:** 2026-09-07

## Ziel

Zwei bisher fest im Code verdrahtete Eigenschaften des Mailversands werden
admin-konfigurierbar:

1. **Anpassbare Mail-Texte** — jeder der 7 bestehenden `mail_log.typ`-Werte
   bekommt eine eigene, im Admin-Bereich editierbare Vorlage mit
   Variablen-Platzhaltern, statt eines im jeweiligen Route-Code
   hartkodierten String-Literals.
2. **Konfigurierbarer Versand-Zeitpunkt** — ein globaler Schalter erlaubt,
   zwischen "sofort bei jedem Ereignis" (heutiges Verhalten) und "einmal
   täglich als gesammelte Zusammenfassungs-Mail pro Empfänger" zu wählen.

## Ist-Zustand (zur Einordnung)

- Aller Mailversand läuft über `sendNotification(db, mailer, { to, subject,
  text, typ, jobId })` (`src/services/notify.js`), das protokolliert
  (`mail_log`) und Fehler abfängt, statt den Aufrufer zu blockieren.
- `subject`/`text` werden an ~26 Call-Sites über den ganzen Code verteilt
  (`kontierung.js`, `freigabe2.js`, `spesenFreigabe1.js`, `spesen.js`,
  `poolPage.js`, `n8n/jobs.js`, `cronJobs.js`) individuell als
  Template-Literal gebaut — keine gemeinsame Vorlage, keine Variablen.
- `mail_log.typ` ist ein `CHECK`-begrenztes Feld mit 7 Werten (`zuweisung`,
  `reminder`, `eskalation`, `ablehnung`, `sync-fehler`, `iban-warnung`,
  `rechnungsnummer-warnung`) — dies ist bereits die Kategorisierung, auf
  der die Vorlagen aufbauen.
- Es gibt kein Warteschlangen-Konzept: jede Mail wird beim Auslöse-Ereignis
  sofort verschickt oder protokolliert-fehlgeschlagen.
- Ein etabliertes Scheduler-Muster existiert bereits
  (`src/services/scheduler.js` + `src/services/cronJobs.js` +
  `/admin/geplante-jobs` + `/internal/cron/*`) für alle bisherigen
  6 Hintergrund-Jobs — der neue Digest-Job folgt exakt diesem Muster.

## 1. Datenmodell

### `mail_log.status` — neuer Wert `geplant`

CHECK-Constraint erweitert von `('versendet', 'fehlgeschlagen')` auf
`('versendet', 'fehlgeschlagen', 'geplant')`, via das etablierte
Tabellen-Rebuild-Migrationsmuster (siehe `migrateFreigabenTable` in
`src/db/index.js` als Vorlage). `geplant` bedeutet: Betreff/Text sind
bereits fertig gerendert und in der Zeile gespeichert, aber noch nicht
verschickt — die Zeile wartet auf den nächsten Digest-Lauf.

### `cron_log.job` — neuer Wert `mail-digest`

Gleiches Muster, analog zu den bestehenden 6 Job-Namen.

### Neue `admin_config`-Schlüssel

Acht Vorlagen (7 Ereignis-Typen + 1 Digest-Wrapper), je zwei Felder:

```
mail_vorlage_zuweisung_betreff / mail_vorlage_zuweisung_text
mail_vorlage_reminder_betreff / mail_vorlage_reminder_text
mail_vorlage_eskalation_betreff / mail_vorlage_eskalation_text
mail_vorlage_ablehnung_betreff / mail_vorlage_ablehnung_text
mail_vorlage_sync_fehler_betreff / mail_vorlage_sync_fehler_text
mail_vorlage_iban_warnung_betreff / mail_vorlage_iban_warnung_text
mail_vorlage_rechnungsnummer_warnung_betreff / mail_vorlage_rechnungsnummer_warnung_text
mail_vorlage_digest_betreff / mail_vorlage_digest_text
```

Plus Batching-Konfiguration:

```
mail_batching_aktiv           ('0' / '1', Default '0' — heutiges Verhalten unverändert)
mail_batching_stunde          (Default '7')
mail_batching_minute          (Default '0')
```

Alle Defaults werden in `DEFAULTS` (`src/db/adminConfigRepo.js`) mit dem
heutigen Wortlaut vorbelegt (siehe Abschnitt 2) — ein Upgrade ohne
Admin-Eingriff ändert den versendeten Mail-Inhalt inhaltlich nicht
wesentlich (einzige unvermeidbare Änderung: die Betreffzeile wird pro Typ
vereinheitlicht, siehe unten).

## 2. Vorlagensystem

**Platzhalter-Syntax:** `%variable%` — einfacher String-Replace, kein
HTML-Escaping nötig (Mails bleiben Plain-Text wie heute).

**Neues Modul `src/services/mailTemplates.js`:**

```js
export function renderTemplate(vorlage, variablen)   // %key% -> variablen[key], sonst unverändert stehen lassen
export function getVorlage(db, typ)                  // liest betreff+text aus admin_config für den gegebenen typ
```

`%portalName%` wird jeder Ereignis-Vorlage automatisch hinzugefügt
(aus `admin_config['seiten_titel']`) — alle übrigen Variablen liefert der
jeweilige Aufrufer.

### Variablen pro Typ

| Typ | Variablen (zusätzlich zu `%portalName%`) |
|---|---|
| zuweisung | `%empfaengerName%`, `%jobDateiname%`, `%grund%`, `%link%` |
| reminder | `%jobDateiname%`, `%stunden%`, `%link%` |
| eskalation | `%jobDateiname%`, `%stunden%`, `%link%` |
| ablehnung | `%empfaengerName%`, `%jobDateiname%`, `%grund%`, `%link%` |
| sync-fehler | `%fehlerDetails%`, `%zeitpunkt%` |
| iban-warnung | `%jobDateiname%`, `%erwarteteIban%`, `%tatsaechlicheIban%`, `%link%` |
| rechnungsnummer-warnung | `%jobDateiname%`, `%rechnungsnummer%`, `%debitorName%`, `%link%` |
| digest | `%empfaengerName%`, `%anzahl%`, `%eintraege%`, `%link%` |

`%grund%` bei `zuweisung` beschreibt, *warum* diese Person die Mail
bekommt (z.B. "Dir wurde eine neue Rechnung zugewiesen." vs. "Du hast
Freigabe 2 zu erteilen." vs. "Interessenskonflikt: die Rechnung wurde an
den Portal-Admin eskaliert.") — der Aufrufer füllt diesen Text weiterhin
pro Auslöser individuell, die Vorlage selbst bleibt eine einzige. Bei
`ablehnung` ist `%grund%` der vom Ablehner eingegebene Ablehnungsgrund.

`%eintraege%` bei `digest` ist die Liste der gesammelten `betreff`-Zeilen
der wartenden Ereignisse dieses Empfängers, als einfache Aufzählung
(ein Eintrag pro Zeile, mit führendem `- `).

### Default-Vorlagen (in `DEFAULTS` vorbelegt)

```
zuweisung:
  Betreff: "Freigabeportal: Neue Rechnung zur Bearbeitung"
  Text: "Hallo %empfaengerName%,\n\n%grund%\n\nBeleg: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%"

reminder:
  Betreff: "Freigabeportal: Erinnerung – unbeanspruchte Rechnung im Pool"
  Text: "Diese Rechnung ist seit mehr als %stunden% Stunden unbeansprucht im Pool: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%"

eskalation:
  Betreff: "Freigabeportal: Eskalation – Rechnung seit langem unbeansprucht"
  Text: "Diese Rechnung ist seit mehr als %stunden% Stunden unbeansprucht im Pool und wurde eskaliert: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%"

ablehnung:
  Betreff: "Freigabeportal: Rechnung abgelehnt"
  Text: "Hallo %empfaengerName%,\n\n%grund%\n\nBeleg: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%"

sync-fehler:
  Betreff: "Freigabeportal: Fehler beim Personen-Sync"
  Text: "Beim automatischen Personen-Sync ist ein Fehler aufgetreten (%zeitpunkt%):\n\n%fehlerDetails%\n\nFreundliche Grüsse\n%portalName%"

iban-warnung:
  Betreff: "Freigabeportal: IBAN-Abweichung erkannt"
  Text: "Bei folgender Rechnung weicht die erkannte IBAN vom hinterlegten Lieferanten ab: %jobDateiname%\n\nErwartet: %erwarteteIban%\nErkannt: %tatsaechlicheIban%\n\nBitte im Freigabeportal prüfen: %link%\n\nFreundliche Grüsse\n%portalName%"

rechnungsnummer-warnung:
  Betreff: "Freigabeportal: Mögliche Doppelrechnung erkannt"
  Text: "Für Debitor %debitorName% wurde die Rechnungsnummer %rechnungsnummer% bereits einmal erfasst: %jobDateiname%\n\nBitte im Freigabeportal prüfen: %link%\n\nFreundliche Grüsse\n%portalName%"

digest:
  Betreff: "Freigabeportal: Tägliche Zusammenfassung (%anzahl% Ereignisse)"
  Text: "Hallo %empfaengerName%,\n\nfolgende Ereignisse warten auf dich:\n\n%eintraege%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%"
```

## 3. `sendNotification`-Refactor

**Neue Signatur:**

```js
sendNotification(db, mailer, { to, typ, jobId, variablen })
```

statt bisher `{ to, subject, text, typ, jobId }`. `variablen` ist ein
einfaches Objekt mit den in Abschnitt 2 gelisteten, typspezifischen
Werten (z.B. `{ empfaengerName, jobDateiname, grund, link }` für
`zuweisung`).

Intern:
1. `getVorlage(db, typ)` lädt Betreff/Text-Vorlage.
2. `renderTemplate(vorlage, { ...variablen, portalName })` erzeugt den
   fertigen Betreff/Text.
3. **Batching-Entscheidung:**
   - `admin_config['mail_batching_aktiv'] === '0'` **oder**
     `typ` ist `'sync-fehler'` oder `'iban-warnung'` (immer sofort,
     unabhängig vom Schalter — betriebs-/sicherheitskritisch) →
     wie heute: `mailer.sendMail(...)`, `mail_log`-Zeile mit
     `status = 'versendet'`/`'fehlgeschlagen'`.
   - sonst → **keine** SMTP-Zustellung; nur eine `mail_log`-Zeile mit
     `status = 'geplant'`, gerendertem `betreff`/`text`, `versucht_am` =
     jetzt (Zeitpunkt des Einreihens).

Das ist transparent für alle Aufrufer — keine Call-Site muss wissen, ob
gerade gebatcht wird.

**Umfang der Anpassung:** Alle ~26 bestehenden `sendNotification`-Aufrufe
werden von "eigenen `subject`/`text`-String bauen" auf "passende
`variablen` übergeben" umgestellt. Das ist der grösste Teil der
Implementierung — mechanisch, aber über sechs Dateien verteilt
(`kontierung.js`, `freigabe2.js`, `spesenFreigabe1.js`, `spesen.js`,
`poolPage.js`, `routes/n8n/jobs.js`, `services/cronJobs.js`). Wo eine
Call-Site heute mehrere Empfänger einzeln anschreibt (z.B.
IBAN-Warnung an Ersteller + Freigeber1 + Freigeber2), bleibt das
unverändert — ein `sendNotification`-Aufruf pro Empfänger, mit
`empfaengerName` jeweils passend gesetzt.

**"An Gruppe zurücksenden"** (`sendJobBackToGroup`) verschickt heute keine
Mail und bleibt unverändert ausserhalb dieses Designs.

## 4. Digest-Cronjob

Neuer `runMailDigestJob(db, config, mailer)` in `src/services/cronJobs.js`,
nach dem etablierten Muster der 6 bestehenden Jobs verdrahtet:
`scheduler.js` (via `scheduleDaily`, Getter für
`mail_batching_stunde`/`_minute`), `POST /internal/cron/mail-digest`
(`X-Cron-Secret`), manueller "Jetzt ausführen"-Button + Lauf-Historie auf
`/admin/geplante-jobs`, eigener `cron_log`-Eintrag.

Ablauf:
1. `SELECT * FROM mail_log WHERE status = 'geplant' ORDER BY versucht_am`,
   gruppiert nach `empfaenger`.
2. Pro Gruppe: Digest-Vorlage rendern (`%anzahl%` = Anzahl Zeilen,
   `%eintraege%` = Liste der `betreff`-Werte, `%link%` = Portal-Startseite),
   eine Mail an diesen Empfänger senden.
3. Erfolg → alle beteiligten `mail_log`-Zeilen auf `status = 'versendet'`,
   `versucht_am` = jetzt. Fehlschlag → alle auf `status = 'fehlgeschlagen'`
   mit demselben `fehler_details`.
4. Kein automatischer Retry (konsistent mit dem heutigen Verhalten bei
   Einzel-Mails) — fehlgeschlagene Zeilen bleiben in `/admin/mails`
   sichtbar, Admin nutzt "erneut versenden" pro Zeile.

**"Erneut versenden"** (bestehende Funktion in `/admin/mails`) sendet
immer sofort und umgeht die Warteschlange — eine bewusste Einzelaktion,
unabhängig vom globalen Batching-Schalter.

Wenn `mail_batching_aktiv` aktiv ist und danach wieder deaktiviert wird,
während noch `geplant`-Zeilen offen sind: der nächste Digest-Lauf
verschickt sie trotzdem noch als Digest (der Job prüft nur `status =
'geplant'`, nicht den aktuellen Schalterstand) — kein verlorenes Ereignis.

## 5. Admin-UI

Neue Seite `/admin/mail-einstellungen`, **nur `superadmin`** (kein
vergebbares Einzelrecht, wie Backup/Zeitstempel/Erscheinungsbild/
Eskalationszeiten):

- 8× Paar aus Betreff-Input und Text-Textarea, mit der jeweils gültigen
  Variablenliste (aus Abschnitt 2) als Hinweistext daneben.
- Batching-Checkbox ("Mails gesammelt statt sofort versenden") +
  Uhrzeit-Feld (Stunde/Minute) für den täglichen Versand.
- Speichern via `POST /admin/mail-einstellungen`, gleiches Formular-Muster
  wie `/admin/eskalation`/`/admin/erscheinungsbild`.

## 6. Migration / Kompatibilität

- Bestehende Installationen erhalten beim nächsten Start automatisch alle
  neuen `admin_config`-Defaults (`seedDefaults`, `ON CONFLICT DO NOTHING`)
  — Batching bleibt aus, Vorlagen entsprechen inhaltlich dem bisherigen
  Text.
- Einzige sichtbare Änderung ohne Admin-Eingriff: vereinheitlichte
  Betreffzeilen pro Typ (siehe Abschnitt 2) statt der bisher leicht
  variierenden Betreffe je Call-Site.
- `mail_log`-Bestandsdaten (bereits `versendet`/`fehlgeschlagen`) sind von
  der CHECK-Erweiterung nicht betroffen.

## 7. Testing-Ansatz

- Unit: `renderTemplate` (Platzhalter ersetzt, unbekannte Platzhalter
  bleiben stehen, mehrfaches Vorkommen derselben Variable).
- Integration: `sendNotification` mit Batching aus (sofortiger Versand,
  Vorlage korrekt gerendert) und mit Batching an (Zeile `geplant`, kein
  SMTP-Call) — inkl. der `sync-fehler`/`iban-warnung`-Ausnahme bei aktivem
  Batching.
- Integration: `runMailDigestJob` (mehrere `geplant`-Zeilen verschiedener
  Empfänger → korrekt gruppierte Digest-Mails; SMTP-Fehler → alle Zeilen
  der betroffenen Gruppe `fehlgeschlagen`).
- Integration: `/admin/mail-einstellungen` (Zugriffsschutz `superadmin`,
  Formular speichert alle 18 Felder korrekt, inkl. CSRF-Sweep-Eintrag).
- Regression: bestehende Tests an allen ~26 Call-Sites, die heute exakte
  `subject`/`text`-Strings assertieren, müssen auf die neuen
  Default-Vorlagen-Texte angepasst werden.

## Offene Annahmen für die Plan-Phase

- Wo genau `empfaengerName` an jeder Call-Site herkommt (Person-Objekt vs.
  nur E-Mail-Adresse bei gruppen-aufgelösten Empfängern) wird pro
  Call-Site beim Schreiben des Implementierungsplans anhand des
  tatsächlichen Codes geprüft, nicht pauschal in diesem Dokument
  festgelegt.
