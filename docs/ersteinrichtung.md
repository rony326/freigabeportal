# Ersteinrichtung

Geführter Assistent für Superadmins unter `/admin/ersteinrichtung`. Er misst bei jedem Aufruf, welche Einrichtungsschritte
erledigt sind, und bietet Tests für ChurchTools, E-Mail und die geplanten Jobs an. Entwurf:
[superpowers/specs/2026-10-25-ersteinrichtung-design.md](superpowers/specs/2026-10-25-ersteinrichtung-design.md).
Die Go-Live-Checkliste im [README](../README.md) bleibt unverändert; der Assistent prüft vieles davon automatisch.

## Zugang

Nur `superadmin` (`requireRole(config, 'superadmin')` in `src/app.js`). Manager und Personen mit Einzelrechten erhalten `403`
und sehen weder den Navigationseintrag noch den Dashboard-Hinweis. Alle `POST`-Routen sind CSRF-geschützt.

Es werden nie Geheimnisse angezeigt oder gespeichert: Umgebungsvariablen erscheinen nur als `ok`, `fehlt`, `ungültig` oder
`warnung` (ohne Wert), Fehlermeldungen von ChurchTools sind feste Texte.

## Schritte

14 Schritte, davon 8 Pflicht. Ein Schritt gilt als erledigt, wenn seine Messregel zutrifft (Code: `src/services/ersteinrichtung.js`).

| ID | Pflicht | Erledigt, wenn ... |
|---|---|---|
| `grundlagen` | ja | die technische Prüfung keine Zeile `fehlt` oder `ungültig` enthält |
| `rollen` | ja | mindestens eine aktive Person in der Superadmin-Gruppe ist |
| `churchtools` | ja | der letzte beendete `sync_log`-Eintrag `erfolg` ist |
| `mail` | ja | mindestens eine `mail_log`-Zeile mit `typ = 'testmail'` und Status `versendet` existiert |
| `konten` | ja | mindestens ein aktives Konto Freigeber 1 und Freigeber 2 hat |
| `zeitstempel` | ja | `zeitstempel_tsa_url` gesetzt ist **oder** bewusst darauf verzichtet wurde (`einrichtung_ohne_zeitstempel = '1'`) |
| `sicherung` | ja | der letzte `cron_log`-Lauf `datenbank-sicherung` mit `erfolg` jünger als 7 Tage ist |
| `kontakt` | ja | `betrieb_kontakt_email` nicht leer ist |
| `branding` | nein | `seiten_titel` gesetzt ist |
| `kreditoren` | nein | mindestens ein Kreditor existiert |
| `module` | nein | von Hand markiert (`einrichtung_markiert_module = '1'`) |
| `mailvorlagen` | nein | von Hand markiert (`einrichtung_markiert_mailvorlagen = '1'`) |
| `monitoring` | nein | `monitoring_secret` gesetzt ist |
| `jobs` | nein | `sync-personen` mindestens einmal lief (`sync_log`) und `pool-erinnerungen` mindestens einmal beendet wurde (`cron_log`) |

`mail-zustellung` wird beim Auslösen mitgestartet, zählt aber nicht als Nachweis für `jobs`: Der Job protokolliert nur Läufe
mit fälligen Mails.

## Routen

Alle unter `/admin/ersteinrichtung`:

| Route | Wirkung |
|---|---|
| `GET /` | Seite mit allen Schritten, Fortschritt und letzten Testergebnissen; die technische Prüfung läuft bei jedem Aufruf neu (nur schnelle Dateisystem-Prüfungen, kein ChurchTools-Aufruf) |
| `POST /technik` | technische Prüfung erneut ausführen (nur Audit-Eintrag `test_technik`) |
| `POST /churchtools-test` | prüft die ChurchTools-Verbindung und zeigt die gefundenen Gruppen (`test_churchtools`) |
| `POST /testmail` | schickt eine Testmail an die eigene Adresse der angemeldeten Person (`test_testmail`) |
| `POST /jobs` | löst `sync-personen`, `pool-erinnerungen` und `mail-zustellung` einmal aus, dieselben Funktionen wie unter `/admin/geplante-jobs` (`test_jobs`) |
| `POST /markieren` | setzt oder löscht `einrichtung_markiert_<id>`; nur für `module` und `mailvorlagen`, sonst `400` |
| `POST /ohne-zeitstempel` | setzt oder löscht den bewussten Verzicht `einrichtung_ohne_zeitstempel` |
| `POST /spaeter` | blendet den Dashboard-Hinweis für diese Person 7 Tage aus, Weiterleitung zu `/admin` |

Jede Testaktion schreibt einen Audit-Eintrag (Objekt `ersteinrichtung`) ohne Geheimnisse; Konfigurationsänderungen
(`markieren`, `ohne-zeitstempel`, `spaeter`) erscheinen wie üblich als `admin_config`-Audit. Nach jeder Aktion wird der
Status-Cache geleert.

### Letzte Testergebnisse

Die Ergebnisse von ChurchTools-Test, Testmail und Job-Lauf liegen nur im Speicher der App-Instanz und gehen beim Neustart
verloren. Sie sind pro Person getrennt (Schlüssel `churchtools_person_id`): Jede Superadmin-Person sieht ihre eigenen letzten
Ergebnisse, jeweils mit „von Vorname Nachname, Zeit“ (Zeit in Europe/Zurich). Dauerhafte Nachweise sind der Audit-Eintrag
und, wo vorhanden, `mail_log`, `sync_log` und `cron_log`.

## Testmail

Neuer Mail-Typ `testmail` (`mail_log.typ`, Migration in `src/db/index.js`): feste Vorlage, geht immer sofort
(`IMMER_SOFORT_TYPEN` in `src/services/notify.js`, nie als Sammelmail) und ist unter Mail-Einstellungen nicht editierbar.
Hat die Person keine E-Mail-Adresse, wird nichts verschickt und die Seite sagt es.

## Konfigurationsschlüssel

| Schlüssel | Bedeutung |
|---|---|
| `einrichtung_ohne_zeitstempel` | `1` = bewusster Verzicht auf Zeitstempel; macht `zeitstempel` erledigt |
| `einrichtung_markiert_<id>` | `1` = von Hand als erledigt markiert (`module`, `mailvorlagen`) |
| `einrichtung_spaeter_bis_<personId>` | ISO-Zeitpunkt, bis zu dem der Dashboard-Hinweis für diese Person ausgeblendet ist |

## Dashboard-Hinweis und Statusdienst

Auf `/admin` (nur Superadmin) steht „Ersteinrichtung: X von Y Pflichtschritten erledigt“ mit Link zum Assistenten, solange
Pflichtschritte offen sind. „Später“ blendet ihn 7 Tage aus, nur für die jeweilige Person.

Der 11. Statusdienst `einrichtung` ([statusseite-und-monitoring.md](statusseite-und-monitoring.md)) meldet `warnung` mit der
Anzahl offener Pflichtschritte, sobald alle erledigt sind `ok`. Er ist nie `fehler`.

**Hinweis für externe Überwachung:** Solange Pflichtschritte offen sind, ist der Gesamtstatus `warnung`. Ein Monitor auf
`status` (Gesamt-Monitor) bleibt deshalb bis zum Abschluss der Einrichtung gelb bzw. schlägt an. Wer das nicht möchte,
überwacht stattdessen die einzelnen Dienste (`dienste.<schluessel>.status`) und lässt `einrichtung` weg.
