# Sub-Phase E2, Batch 3 – ChurchTools-Sync-Robustheit — Design

## Kontext & Phasenplan

Dies ist der dritte Teil der Sub-Phase E2 (Security-Review-Pass), nach Batch 1
(gebündelte Einzelfixes, gemerged) und Batch 2 (PDF-Bereinigung, gemerged). Die
E2-Sicherheitsprüfung wurde als vier unabhängige Batches organisiert:

- **Batch 1 – gebündelte Einzelfixes** (gemerged)
- **Batch 2 – PDF-Bereinigung** (gemerged)
- **Batch 3 – ChurchTools-Sync-Robustheit** (dieses Dokument): SYNC-1
  (Massen-Deaktivierungs-Schutz), SYNC-2 (Sync-Sichtbarkeit für Admins),
  SYNC-3 (Stalled-Job-Erkennung + Force-Release), SYNC-8 (Eskalation bei
  doppeltem Interessenskonflikt — ursprünglich vom Nutzer während Batch 1
  formuliert: *"wenn der stellvertreter 1 auch einen interessenkonflikt hat
  soll dieser auch eskalieren"*).
- **Batch 4 – Autorisierungsmodell-Entscheidung**: ob `/kontierung`/
  `/freigabe2`/`/abgelehnt` weiterhin an Buchhaltungs-Gruppenmitgliedschaft
  gekoppelt bleiben.

Alle vier Findings dieses Batches drehen sich um dieselbe Grundfrage: was
passiert, wenn eine Person, die eine Rolle im Freigabe-Workflow trägt
(Freigeber, Stellvertreter), über den ChurchTools-Sync unbrauchbar wird
(deaktiviert, nicht mehr auflösbar) oder ihre eigene Rolle wegen eines
Interessenskonflikts nicht ausüben kann — und wie das Portal das sichtbar
macht und einen Weg nach vorne anbietet, statt den Job stillschweigend
stecken zu lassen.

## Architektur & Übersicht

Ein neuer Admin-Router `src/routes/admin/sync.js`, gemountet unter
`/admin/sync`, wird die eine Anlaufstelle für alle drei Sync-bezogenen
Findings (SYNC-1 Schwellenwerte, SYNC-2 Sync-Historie, SYNC-3
Stalled-Job-Liste + Force-Release) — ein Navigationseintrag statt drei, weil
alle drei dieselbe "ist die Sync-Ebene gesund?"-Frage eines Admins
beantworten.

SYNC-8 ist unabhängig davon: es ändert die Eskalationslogik in
`kontierung.js`/`freigabe2.js` und führt eine neue jobbezogene
Autorisierungs-Verzweigung ein, ohne eigene Admin-UI.

## SYNC-1 — Massen-Deaktivierungs-Schutz

`runPersonenSync` (`src/services/sync.js`) berechnet `toDeactivate` bereits
heute vor jedem Datenbank-Schreibzugriff. Zwei neue `admin_config`-Schlüssel,
beide über `/admin/sync` änderbar: `sync_max_deaktivierung_prozent` (Default
`'50'`) und `sync_max_deaktivierung_anzahl` (Default `'10'`) — validiert als
positive Ganzzahlen nach demselben Muster wie `eskalation.js`s
Stunden-Schwellenwerte.

Überschreitet `toDeactivate.length` **einen der beiden** Schwellenwerte
(Prozentsatz der aktuell aktiven Personen ODER absolute Anzahl), bricht der
gesamte Lauf **vor** der `BEGIN`/`COMMIT`-Transaktion ab: keine Upserts,
keine Deaktivierungen, nichts wird persistiert. `sync_log.status` erhält
einen neuen Wert `'abgebrochen'` (unterschieden von `'fehler'`, das für
echte Exceptions reserviert bleibt), `fehler_details` nennt die exakten
Zahlen und welcher Schwellenwert ausgelöst hat, z. B.:

```
Sync abgebrochen: 12 von 20 aktiven Personen (60%) würden deaktiviert — Schwelle 50%/10
```

Die Kombination ist absichtlich ODER statt UND: der Prozentsatz schützt
kleine Kongregationen (wo schon der Ausfall weniger Personen einen grossen
Anteil ausmacht), die absolute Zahl schützt grössere (wo ein Ausfall von z. B.
10 Personen bei 40%-Schwelle sonst unter dem Prozent-Radar bliebe, obwohl es
real viele betroffene Menschen sind).

## SYNC-2 — Sichtbarkeit für Admins

`GET /admin/sync` zeigt:

- die zwei SYNC-1-Schwellenwert-Felder,
- ein neues Empfänger-Feld `sync_fehler_empfaenger` (Default
  `'gruppe:admin'`, gleiches Format wie die bestehenden
  Reminder-/Eskalations-Empfänger-Felder: eine Zeile pro E-Mail-Adresse oder
  Gruppen-Token),
- eine Tabelle der letzten ca. 20 `sync_log`-Einträge (Status, Zeitstempel,
  Zähler, Fehlertext) über eine neue Funktion `listRecentSyncLogs(db,
  limit)` in `syncLogRepo.js`.

`resolveEmpfaenger` (`src/services/notify.js`) erhält ein zweites
Gruppen-Token, `'gruppe:admin'`, aufgelöst über
`config.churchtools.groupIdAdmin` (bisher kennt die Funktion nur
`'gruppe:buchhaltung'`). `mail_log.typ`s CHECK-Constraint erhält den Wert
`'sync-fehler'`.

Die Cron-Route `POST /internal/cron/sync-personen` (`cron.js`, hat bereits
Zugriff auf `mailer`/`config`/`db`) verschickt eine `sync-fehler`-E-Mail immer
dann, wenn `runPersonenSync` wirft oder das Ergebnis `'abgebrochen'` meldet —
kein Dedup/Throttling in diesem Batch. Bleibt ChurchTools über mehrere
geplante Läufe hinweg gestört, bekommen Admins bei jedem Lauf eine E-Mail;
das ist ein bewusst akzeptierter Trade-off für diesen Batch, kein Versehen —
ein künftiger Batch kann Throttling nachrüsten, falls sich das in der Praxis
als störend erweist.

## SYNC-3 — Stalled-Job-Erkennung + Force-Release

Ein Job gilt als *stalled*, wenn seine aktuell benötigte handelnde Person
unbrauchbar ist (`!aktiv` oder `ct_person_unresolved`), geprüft je nach
Status:

- `status = 'zugewiesen'` oder `'abgelehnt'` → handelnde Person ist
  `zugewiesen_an` direkt.
- `status = 'freigabe2'` → handelnde Person ist der effektive Freigeber 2
  (`getEffectiveFreigeber2Id`) — **ausser** der Job trägt bereits SYNC-8s
  Admin-Eskalations-Flag (siehe unten): ein admin-gerouteter Job gilt nie als
  stalled, da ein gleichzeitiger Ausfall der gesamten Portal-Admin-Gruppe
  ausserhalb des Scopes dieses Batches liegt.

Eine neue Funktion `listStalledJobs(db)` (`jobsRepo.js`) findet diese Jobs;
`/admin/sync` zeigt sie in einer eigenen Tabelle (wer hängt fest, seit wann,
warum — inaktiv vs. nicht auflösbar).

Die Force-Release-Aktion wirkt je nach Stadium unterschiedlich, weil ein
einheitliches "immer zurück in den Pool" echte, bereits protokollierte
Freigabearbeit stillschweigend verwerfen würde:

- **Stalled `zugewiesen` oder `abgelehnt`** → direkter Reset auf
  `unzugewiesen` (gleiche Form wie der bestehende `releaseJob`-Ablauf: löscht
  `zugewiesen_an`/`konto_id`). Auf dieser Stufe ist noch nichts
  Unumkehrbares passiert, ein voller Reset ist hier korrekt und einfach.
- **Stalled `freigabe2`** → **kein** Reset auf den Pool (das würde die
  bereits abgeschlossene, bereits im Audit-Trail protokollierte
  Freigabe-1-Genehmigung verwerfen und Kontierung + Freigabe 1 grundlos neu
  erzwingen). Stattdessen wird dasselbe `freigabe2_eskaliert_an_admin`-Flag
  gesetzt, das SYNC-8 einführt — der Job routet zur Portal-Admin-Gruppe, was
  für einen Job nach Freigabe 1 die korrekte nächste handelnde Instanz ist.

## SYNC-8 — Eskalation bei doppeltem Interessenskonflikt

Zwei neue nullable Job-Spalten, je eine pro Freigabe-Stufe:
`freigabe1_eskaliert_an_admin INTEGER NOT NULL DEFAULT 0` und
`freigabe2_eskaliert_an_admin INTEGER NOT NULL DEFAULT 0`.

**Auslöse-Bedingung** — heute blockieren `kontierung.js`/`freigabe2.js`
jeden zweiten Eskalationsversuch hart mit der Meldung *"...kann nicht
erneut eskaliert werden... wende dich an den Portal-Admin."*, unabhängig vom
Grund. Diese Blockade teilt sich künftig in zwei Fälle:

- Hat die Person, die die Blockade auslöst (der bereits eskalierte
  Stellvertreter), selbst `interessenskonflikt = 'ja'` **und** wurde für
  diese Stufe noch nicht an einen Admin eskaliert → das ist genau der
  SYNC-8-Fall: das jeweilige `*_eskaliert_an_admin`-Flag wird gesetzt, der
  Konflikt/Grund wird wie bei der ersten Eskalationsstufe protokolliert
  (eine `freigaben`-Zeile mit unveränderter `rolle`,
  `interessenskonflikt = true`, `eskaliert_von` = die ID des
  Stellvertreters), die Admin-Empfängerliste (SYNC-2s `'gruppe:admin'`-
  Routing) wird benachrichtigt — das ist eine legitime zweite Eskalation,
  kein Wiederholungsversuch.
- Jeder andere Grund für den zweiten Versuch (kein Konflikt, einfach ein
  erneuter Versuch) → bleibt mit der bestehenden Meldung blockiert. Die
  Regel bleibt "eine Eskalation, ausser diese Eskalation selbst stösst auf
  einen Interessenskonflikt" — exakt die ursprünglich formulierte
  Anforderung, ohne beliebig lange Eskalationsketten zu öffnen.

**Autorisierung** — sobald das Flag einer Stufe gesetzt ist, ist der Job für
den (nun ausgeschlossenen, konfliktbehafteten) Stellvertreter nicht mehr
handhabbar und wird stattdessen für jede aktive Person der
Portal-Admin-Gruppe handhabbar. Die Job-Lade-Logik in
`kontierung.js`/`freigabe2.js` erhält eine neue Verzweigung: aus "stimmt
`req.currentPerson.churchtools_person_id` mit `job.zugewiesen_an` / der
effektiven Freigeber-2-ID überein" wird "...ODER (das Admin-Eskalations-Flag
der Stufe ist gesetzt UND `req.currentPerson` ist Mitglied der
Portal-Admin-Gruppe)" — spiegelt den Gruppenmitgliedschafts-Check, den
`requireRole` bereits kennt, nur pro Job statt pro Route angewendet.

**Admin-Erfahrung** — ein eskalierter Job erscheint über dieselben
`/kontierung`-/`/freigabe2`-Formulare wie jeder andere Job (keine neuen
Views); der Admin sieht dieselbe Interessenskonflikt-Frage und reicht das
Formular genauso ein wie ein Stellvertreter. Admins gelten als letzte Stufe
— per Konstruktion als konfliktfrei angenommen, daher keine dritte
Eskalationsebene. Hätte ein Admin tatsächlich auch einen Konflikt, liegt das
ausserhalb des Scopes dieses Batches (passt zum kleinen-Kongregation-
Bedrohungsmodell: an dem Punkt ist es ein Besetzungsproblem, kein
Workflow-Problem).

**Route-Gate-Fix** — `/kontierung` und `/freigabe2` sind heute in `app.js`
mit `requireRole(config, 'buchhaltung')` gemountet, geprüft **bevor** jede
joblokale Logik läuft. Ein Portal-Admin, der nicht **auch**
Buchhaltungs-Gruppenmitglied ist, würde an diesem Gate abgewiesen und könnte
einen eskalierten Job nie erreichen — abhängig davon, wie die
ChurchTools-Gruppen der Kongregation tatsächlich geschnitten sind, würde das
diese ganze Funktion stillschweigend brechen. Die beiden Mounts wechseln
daher von `requireRole(config, 'buchhaltung')` zu einer neuen Variante, die
Buchhaltungs- **oder** Portal-Admin-Gruppenmitgliedschaft akzeptiert. Diese
Änderung öffnet nur die Tür — welche konkreten Jobs eine Person danach
anfassen darf, entscheidet weiterhin ausschliesslich die joblokale
Autorisierung (der bestehende exakte-ID-Vergleich, jetzt ODER-verknüpft mit
der neuen Admin-Eskalations-Verzweigung).

## Datenmodell (konsolidiert)

- `jobs.freigabe1_eskaliert_an_admin INTEGER NOT NULL DEFAULT 0`
- `jobs.freigabe2_eskaliert_an_admin INTEGER NOT NULL DEFAULT 0`
- `admin_config` neue Schlüssel: `sync_max_deaktivierung_prozent` (Default
  `'50'`), `sync_max_deaktivierung_anzahl` (Default `'10'`),
  `sync_fehler_empfaenger` (Default `'gruppe:admin'`)
- `mail_log.typ`s CHECK-Constraint erhält den Wert `'sync-fehler'`
- `sync_log.status` erhält den Wert `'abgebrochen'` (keine
  CHECK-Constraint auf dieser Spalte vorhanden — rein additiv, keine
  Schemaänderung nötig)
- Keine weiteren Schemaänderungen — gleiche Konvention wie jeder vorherige
  Batch: `schema.sql` wird direkt editiert, kein Migrationssystem (die App
  wurde noch nie deployed).

## Tests

- **Unit**: SYNC-1s Schwellenwert-Mathematik (Prozent, absolut, die
  ODER-Kombination, inklusive des Abbruchs vor jedem Datenbank-Schreiben);
  `resolveEmpfaenger`s neues `'gruppe:admin'`-Token; `listRecentSyncLogs`;
  `listStalledJobs` (alle drei Stadien-Varianten, inklusive der Prüfung,
  dass ein bereits admin-eskalierter `freigabe2`-Job korrekt von "stalled"
  ausgeschlossen ist); die neuen Force-Release-Repo-Funktionen; die
  Admin-Eskalations-Flag-Übergänge in `jobsRepo.js`.
- **Integration**: `GET`/`POST /admin/sync` (rendert Konfiguration +
  Historie + Stalled-Liste; validiert und persistiert die drei neuen
  Konfigurationswerte); `POST /internal/cron/sync-personen` bricht bei einer
  synthetischen Massen-Deaktivierung sauber ab und verschickt die
  `sync-fehler`-E-Mail, ohne dass irgendetwas persistiert wird; der
  doppelte-Konflikt-Eskalationsablauf über `/kontierung` und `/freigabe2`
  (Stellvertreter 1/2 reicht den eigenen Konflikt ein zweites Mal ein → Flag
  wird gesetzt; ein normaler zweiter Versuch ohne Konflikt bleibt weiterhin
  blockiert); der Route-Gate-Fix (ein Portal-Admin, der **nicht** in
  Buchhaltung ist, erreicht jetzt `/kontierung`/`/freigabe2` für einen
  admin-eskalierten Job, wird aber weiterhin für einen fremden Job von der
  joblokalen Prüfung abgewiesen); alle drei Force-Release-Varianten.
- **Ende-zu-Ende**: ein durchgängiges Szenario, das einen echten Job über
  echte Routen treibt: Anlage → Zuweisung → Freigabe-1-Eskalation → der
  eskalierte Stellvertreter 1 erklärt **ebenfalls** einen Konflikt → ein
  Admin übernimmt über `/kontierung` → Freigabe 2 → Abschluss. Beweist, dass
  die gesamte Kette über echte Routen funktioniert, nicht nur auf
  Unit-Ebene.

## Nicht Teil von diesem Batch

Keine dritte Eskalationsstufe über Admin hinaus. Kein Throttling/Dedup für
`sync-fehler`-E-Mails (oben als bewusster Trade-off benannt). Keine
Admin-Seiten-Abkürzung, um eine Kontos Rollen direkt aus der
Stalled-Job-Liste heraus zu bearbeiten (Admin nutzt weiterhin das
bestehende `/admin/konten`-Formular separat). Keine Änderung an den bereits
heute ungenutzten Statuswerten `'kontiert'`/`'freigabe1'` im
CHECK-Constraint (unabhängige Altlast, nicht Gegenstand dieses Batches).
Keine zeitbasierte "stalled"-Definition — die Erkennung ist rein
zustandsbasiert (handelnde Person inaktiv/nicht auflösbar), was auch
bedeutet, dass sie rückwirkend auf jeden bereits vor diesem Batch
feststeckenden Job wirkt, ohne Backfill-Schritt. Batch 4
(Autorisierungsmodell-Entscheidung) bleibt ein eigener Design-Zyklus.
