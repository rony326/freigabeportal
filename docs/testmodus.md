# Testmodus

Der Testmodus ist eine **Spielwiese**: Superadmins und Manager können darin
Abläufe und Einstellungen ausprobieren, ohne dass etwas Echtes passiert. Es
gehen keine Mails raus, es werden keine echten Rechnungen oder Konten
verändert, und es gibt keine Verbindung zu ChurchTools, n8n, Paperless oder
Bexio. Der Testmodus eignet sich zum Beispiel, um einen neuen Freigabeweg
durchzuspielen, Mail-Vorlagen zu prüfen oder neue Mitarbeitende einzuführen.

## Wer darf den Testmodus nutzen

Nur aktive Personen mit der Rolle `superadmin` oder `manager`. Alle anderen
bekommen auf `/admin/testmodus` eine Fehlermeldung (403). Verliert eine Person
die Rolle, während der Testmodus läuft, wird er automatisch beendet. Die Person
sieht einen Hinweis, und im echten Audit-Log steht ein Eintrag
`ausgeschaltet` (Anlass `rolle_verloren`). Das Gleiche passiert, wenn die
Spielwiese nicht mehr verfügbar ist (Anlass `spielwiese_fehler`).

## Ein- und ausschalten

Die Seite heisst **Testmodus** (`/admin/testmodus`) und steht in der Admin-Navigation
unter Betrieb.

- **Einschalten:** Knopf „Testmodus einschalten“. Beim ersten Mal wird die
  Spielwiese aufgebaut, danach landet man im Pool, als Beispielperson Dora
  Beispiel (Admin). Auch ein Manager handelt dort als Dora, also als
  Superadmin der Spielwiese, und sieht damit Kopien von Einstellungen, die
  im echten Portal nur Superadmins sehen (ohne Geheimnisse, siehe unten). Gelingt der Aufbau nicht, bleibt der Testmodus aus und die
  Seite zeigt eine Fehlermeldung (503). Der echte Betrieb ist nie betroffen.
- **Im Testmodus:** Ein gelbes Band oben auf jeder Seite der Spielwiese zeigt
  „Testmodus — nichts hier ist echt“. Im Band wählt man die Beispielperson,
  öffnet das Test-Postfach, löst die Jobs aus oder beendet den Testmodus.
  Die Seiten, die immer zur echten App gehören (siehe „Was immer in der echten
  App bleibt“, zum Beispiel `/admin/testmodus` oder `/admin/betrieb/status`),
  haben kein Band. Sie zeigen stattdessen den Hinweis „Testmodus ist an – diese
  Seite gehört zum echten Betrieb; Änderungen hier wirken echt.“
- **Ausschalten:** „Testmodus beenden“ im Band oder auf der Seite
  `/admin/testmodus`. Auch beim Abmelden wird der Testmodus beendet.

Ein-/Ausschalten, Personenwechsel und Zurücksetzen werden im **echten**
Audit-Log festgehalten (Objekt `testmodus`, Aktionen `eingeschaltet`,
`ausgeschaltet`, `person_gewechselt`, `zurueckgesetzt`). Was man in der
Spielwiese tut, landet dort nur im Audit-Log der Spielwiese.

## Beispielperson wählen

Das Auswahlfeld im Band wechselt die Person (`POST /admin/testmodus/person`).
So spielt man einen Ablauf als verschiedene Beteiligte durch, zum Beispiel
Kontierung als Anna und Freigabe 2 als Ben. Es gibt nur diese fünf Personen:

| ID | Name | Rolle im Spiel | Gruppen |
|---|---|---|---|
| `test-1` | Anna Beispiel | Freigeberin 1 | `test-buchhaltung` |
| `test-2` | Ben Beispiel | Freigeber 2 | `test-buchhaltung` |
| `test-3` | Carla Beispiel | reicht Spesen ein | `test-buchhaltung` |
| `test-4` | Dora Beispiel | Admin (Standard beim Einschalten) | `test-admin`, `test-buchhaltung` |
| `test-5` | Emil Beispiel | Stellvertretung | `test-buchhaltung` |

Die Mailadressen lauten `vorname@beispiel.invalid` und sind nirgends gültig.

## Beispieldaten

Beim Aufbau (und nach jedem Zurücksetzen) legt das System Folgendes an:

- **Konto 3000 „Jugend“:** Freigeber 1 Anna, Stellvertretung Emil,
  Freigeber 2 Ben, Stellvertretung 2 Carla.
- **Konto 6000 „Verwaltung“:** Freigeber 1 Anna, Stellvertretung Emil,
  Freigeber 2 Dora, Stellvertretung 2 Ben.
- **Kreditoren:** Muster Druck AG (Konto 3000), Beispiel Büro GmbH (Konto 6000).
- **Rechnungen** (einfache Beispiel-PDFs mit dem Aufdruck „Beispielrechnung -
  kein echtes Dokument“): eine im Pool (120.00), eine bei Anna zugewiesen
  (86.50), eine zur Freigabe 2 bei Ben (450.00), eine abgelehnte (99.90) und
  eine abgeschlossene (300.00).
- **Spesen:** eine Position von Carla (23.40, „Beispiel-Spesen“), zugewiesen an Anna.

Alle Einstellungen der echten App (Eskalationszeiten, Mail-Vorlagen, Module,
Erscheinungsbild und so weiter) werden beim Aufbau **kopiert**. Nicht kopiert
werden Geheimnisse (alles mit `secret`, `token`, `pass` oder `key` im Namen),
die Zeitstempel-Zugangsdaten, der Überwachungsschlüssel und die
Ersteinrichtungs-Daten. Der Hinweis „Ersteinrichtung offen“ auf der
Admin-Startseite erscheint in der Spielwiese nie, denn deren Pflichtschritte
(Zeitstempel, Sync, Sicherung) sind dort gesperrt.

Kopiert werden auch Empfänger-Einstellungen wie `sicherheitsalarm_empfaenger`
oder `audit_revision_empfaenger`. Darum können im Test-Postfach **echte
Mailadressen** als Empfänger stehen. Versendet wird trotzdem nichts.

## Test-Postfach und Jobs

Da keine Mails versendet werden, landen sie im **Test-Postfach**
(`/testmodus/postfach`, Link im Band). Es zeigt die Mails der Spielwiese,
neueste zuerst (maximal 200).

Der Knopf „Jobs auslösen“ im Band (`POST /testmodus/jobs`) führt vier
Hintergrund-Jobs gegen die Spielwiese aus: Pool-Erinnerungen,
Freigabe-2-Erinnerungen, Mail-Sammelversand und Mailzustellung. So sieht man,
wann welche Erinnerung welche Mail erzeugt. Sync, Backup, Zeitstempel und n8n
gehören nicht dazu.

Links in den Mails des Test-Postfachs (zum Beispiel `/kontierung/<id>`) zeigen
auf Belege der Spielwiese. Sie ergeben nur Sinn, solange der Testmodus an ist.
Nach dem Ausschalten öffnet derselbe Link den echten Beleg mit dieser Nummer,
sofern es ihn gibt (mit den normalen Zugriffsprüfungen der echten App).

Schlägt ein Job fehl, steht die Fehlermeldung im Ergebnis über dem Postfach und
im Server-Log.

## Zurücksetzen

Auf `/admin/testmodus` baut „Spielwiese zurücksetzen“ die Spielwiese neu auf:
alle Änderungen gehen verloren, die Beispieldaten und die Einstellungen der
echten App werden frisch kopiert. Ist der Testmodus gerade eingeschaltet, muss
das Zurücksetzen bestätigt werden.

**Alle Admins teilen eine Spielwiese.** Wer zurücksetzt, setzt sie für alle
zurück. Eine Anfrage, die genau in diesem Moment läuft, kann mit einem Fehler
enden. Wenn mehrere Personen gleichzeitig testen, vorher kurz absprechen.

## Was abgeschottet ist

| Bereich | Verhalten im Testmodus |
|---|---|
| Mail | Es gibt keinen SMTP-Versand. Mails werden nur gesammelt und im Test-Postfach angezeigt. |
| ChurchTools | Kein Login, kein Sync, kein Verbindungstest (er meldet „Im Testmodus deaktiviert“). Für Spesen-Freigaben liefert die Spielwiese Beispiel-Zahlungsdaten (IBAN `CH9300762011623852957`, Kontoinhaber „Beispielperson“). |
| n8n, Cron | `/api/n8n/*` und `/internal/*` laufen immer in der echten App (siehe unten). Die Test-Instanz hat dafür keine Schlüssel. |
| Paperless, Bexio | Es findet keine Übergabe statt. |
| Zeitstempel (TSA) | Zugangsdaten sind in der Spielwiese immer leer (Datenbank-Trigger). Die Seite `/admin/zeitstempel` lässt sich ansehen, aber nicht speichern (Formular gesperrt, `POST /admin/zeitstempel` gibt 403). Es gibt keine Anfragen an eine TSA. Freigegebene Belege bekommen auf der Stempelseite des PDFs die Marke „TESTMODUS – keine echte Freigabe · Zeitstempel: im Testmodus übersprungen“. Dieselbe Marke steht auf der Prüfseite des Belegs (`/zeitstempel-pruefen?jobId=…`) und auf der Prüfbescheinigung. In den Listen steht beim Zeitstempel „im Testmodus übersprungen“. |
| Backup | Die Seite `/admin/backup` ist gesperrt (403). Der Datenbank-Sicherungsjob wird übersprungen, ohne Schlüsselbund. |
| Geheimnisse | Die Spielwiese leitet ein eigenes Sitzungs-/CSRF-Geheimnis und ein eigenes Download-Geheimnis ab. CSRF-Tokens und signierte Download-Links der Spielwiese gelten nie in der echten App und umgekehrt. Das CSRF-Cookie heisst `csrf-token-testmodus`. |
| Nutzung, Audit | Anfragen im Testmodus erscheinen nicht in den Nutzungsdaten oder im Audit-Log der echten App. |

## Was immer in der echten App bleibt

Auch bei eingeschaltetem Testmodus gehen diese Pfade nie an die Spielwiese
(`ECHTE_PFADE` in `src/middleware/testmodusWeiche.js`):

- `/auth` (Login, Logout)
- `/healthz`
- `/admin/testmodus` (die Steuerseite selbst)
- `/admin/betrieb/status` (Statusseite)
- `/audit-pruefen` (öffentliche Prüfung echter Revisionspakete)
- `/api/n8n` (Maschinen-Schnittstelle)
- `/internal` (Cron)

Statische Dateien (`/css`, `/js`, `/vendor`) werden vor der Weiche ausgeliefert.
`/branding` geht an die Spielwiese: das Logo stammt aus deren Kopie.
`/api/pool` gehört ebenfalls zur Spielwiese, damit „Beanspruchen“ nur dort wirkt.
`/zeitstempel-pruefen` gehört bewusst zur Spielwiese (mit Band): die Seite prüft
Belege per Job-ID, und die Links dorthin kommen von Seiten der Spielwiese.

Fehler, die aus der Test-Instanz entweichen, bleiben dort: die Weiche antwortet
selbst mit 500 (oder 404), ohne die echten Routen oder den echten Fehler-Handler
(`betrieb_fehler`) zu erreichen.

## Wo die Dateien liegen

Alles liegt neben den echten Daten, mit dem Zusatz `testmodus`
(Ableitung in `src/services/testmodus/spielwiese.js`, `testmodusPfade`):

| Inhalt | Pfad |
|---|---|
| Datenbank | `<dbPath>.testmodus.db` (plus `-wal`, `-shm`) |
| Beispiel-PDFs und Vorschaubilder | `<jobsDir>-testmodus` |
| Kopie der Logos | `<brandingDir>-testmodus` |
| Backup-Ordner der Spielwiese (bleibt leer) | `<dbPath>.testmodus-backups` |

Die Pfade werden vorher absolut gemacht und ohne Schrägstrich am Ende
geschrieben: `JOBS_DIR=/data/jobs/` ergibt `/data/jobs-testmodus`, nie ein
Verzeichnis in den echten Belegen. Läge ein abgeleiteter Pfad trotzdem in einem
echten Verzeichnis, lässt sich der Testmodus nicht einschalten.

Mit `:memory:` als Datenbank lässt sich der Testmodus nicht einschalten.
Solange niemand den Testmodus einschaltet, legt die echte App keine dieser
Dateien an.

**Die Spielwiese ist nicht Teil der Sicherung.** Die Datenbank-Sicherung
(`/admin/backup`) sichert nur die echte Datenbank. Die Spielwiese darf
jederzeit gelöscht werden und wird beim nächsten Einschalten oder Zurücksetzen
neu erzeugt.

**Die Spielwiese überdauert Neustarts und Updates.** Beim nächsten Einschalten
wird die vorhandene Spielwiese wieder geöffnet, bis jemand sie zurücksetzt.
Neue Standardwerte aus einem Update werden dabei ergänzt; bestehende Werte der
Spielwiese bleiben. Wer nach einem Update den frischesten Stand der echten
Einstellungen will, setzt die Spielwiese zurück.

## Bewährte Einstellungen übernehmen

Änderungen im Testmodus gelten **nur in der Spielwiese**. Was sich bewährt hat,
muss man danach von Hand im echten Portal einstellen. Es gibt keinen
automatischen Rückweg. Umgekehrt: Änderungen im echten Portal sieht die
Spielwiese erst nach einem Zurücksetzen.

## Technik

Die Weiche und die Test-Instanz sind in [architektur.md](architektur.md#testmodus-weiche-und-test-instanz)
beschrieben. Entwurf: [`superpowers/specs/2026-10-25-testmodus-design.md`](superpowers/specs/2026-10-25-testmodus-design.md).
