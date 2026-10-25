# Ersteinrichtung

Geführter Assistent für Superadmins unter `/admin/ersteinrichtung`. Er misst bei jedem Aufruf, welche Einrichtungsschritte
erledigt sind, und bietet Tests für ChurchTools, E-Mail und die geplanten Jobs an. Entwurf:
[superpowers/specs/2026-10-25-ersteinrichtung-design.md](superpowers/specs/2026-10-25-ersteinrichtung-design.md).
Die Go-Live-Checkliste im [README](../README.md) bleibt unverändert; der Assistent prüft vieles davon automatisch.

## Zugang

Nur `superadmin` (`requireRole(config, 'superadmin')` in `src/app.js`). Manager und Personen mit Einzelrechten erhalten `403`
und sehen weder den Navigationseintrag noch den Dashboard-Hinweis. Alle `POST`-Routen sind CSRF-geschützt.

Es werden nie Geheimnisse angezeigt oder gespeichert: Die technische Prüfung zeigt pro Zeile nur `ok`, `fehlt`, `ungültig`
oder `warnung` und nennt die betroffenen Umgebungsvariablen beim Namen, nie deren Wert. Fehlermeldungen von ChurchTools sind
feste Texte.

## Technische Grundlagen

Die Prüfung (`pruefeTechnik` in `src/services/einrichtungTests.js`) prüft nicht jede Umgebungsvariable einzeln, sondern
diese Zeilen:

| Zeile | Variablen | Ergebnis |
|---|---|---|
| Pflichteinstellungen | alle Pflichtvariablen | immer `ok`: fehlt eine, startet die App gar nicht (`src/config/env.js`) |
| Öffentliche Adresse | `PUBLIC_BASE_URL` | `ok` bei `https://`, sonst `warnung` |
| Speicherort Datenbank / Belege / Erscheinungsbild / Sicherungen | `DB_PATH`, `JOBS_DIR`, `BRANDING_DIR`, `BACKUP_DIR` | `ungültig`, wenn kein Verzeichnis oder nicht beschreibbar; `warnung`, wenn im Anwendungsverzeichnis |
| Mailserver | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | `ok`, wenn alle vier gesetzt sind, sonst `fehlt` mit den Namen der fehlenden |
| Backup-Schlüsselbund | `BACKUP_KEYRING_FILE` | `fehlt`, wenn nicht gesetzt; `ungültig`, wenn die Datei nicht lesbar ist oder `loadBackupKeyring` sie ablehnt (Rechte, Lage, Format); sonst `ok` |
| Backup-Download-Schlüssel (optional) | `BACKUP_API_KEY` | immer `ok`, Hinweis gesetzt / nicht gesetzt |
| Manager-Gruppe | `CT_GROUP_ID_MANAGER` | immer `ok` (optional) |
| Zeitstempel-Vertrauensanker | `TSA_TRUST_ANCHORS_FILE` | `ok`, wenn nicht gesetzt oder lesbar; `ungültig`, wenn nicht lesbar |

Bei Zeilen, die nicht in Ordnung sind, steht der Hinweis „Bitte beim Hoster eintragen (z. B. Infomaniak:
Site-Konfiguration → Umgebungsvariablen).“ Das Anwendungsverzeichnis ist die Wurzel des Repositorys (Elternverzeichnis von
`src`, aus `import.meta.url` bestimmt), nicht das Arbeitsverzeichnis des Prozesses.

## Schritte

14 Schritte, davon 8 Pflicht. Ein Schritt gilt als erledigt, wenn seine Messregel zutrifft (Code: `src/services/ersteinrichtung.js`).

| ID | Pflicht | Erledigt, wenn ... |
|---|---|---|
| `grundlagen` | ja | die technische Prüfung keine Zeile `fehlt` oder `ungültig` enthält |
| `rollen` | ja | mindestens eine aktive Person in der Superadmin-Gruppe ist; der Schritt nennt die Namen (ohne E-Mail) der aktiven Personen der Superadmin- und, falls eingestellt, der Manager-Gruppe und weist darauf hin, dass Rollen in ChurchTools über die Gruppenmitgliedschaft vergeben werden |
| `churchtools` | ja | der letzte beendete `sync_log`-Eintrag `erfolg` ist |
| `mail` | ja | mindestens eine `mail_log`-Zeile mit `typ = 'testmail'` und Status `versendet` existiert; der Link führt zur Zeile Mailserver der technischen Grundlagen (`#technik-mailserver`) |
| `konten` | ja | mindestens ein aktives Konto Freigeber 1 und Freigeber 2 hat |
| `zeitstempel` | ja | bewusst darauf verzichtet wurde (`einrichtung_ohne_zeitstempel = '1'`) **oder** `zeitstempel_tsa_url` gesetzt ist, die Vertrauensanker konfiguriert sind (`TSA_TRUST_ANCHORS_FILE` und `TSA_TRUST_ANCHORS_SHA256`) und die zwischengespeicherte TSA-Probe der Statusseite nicht „nicht erreichbar“ meldet (noch unbekannt zählt nicht dagegen). Sonst Hinweis „Vertrauensanker fehlen“ bzw. „Zeitstempeldienst nicht erreichbar“ |
| `sicherung` | ja | der letzte `cron_log`-Lauf `datenbank-sicherung` mit `erfolg` jünger als 7 Tage ist |
| `kontakt` | ja | `betrieb_kontakt_email` nicht leer ist |
| `branding` | nein | `seiten_titel` vom Standard „Freigabeportal“ abweicht **oder** ein Logo hinterlegt ist (`branding_logo_pfad` bzw. `branding_logo_dunkel_pfad`) |
| `kreditoren` | nein | mindestens ein Kreditor existiert |
| `module` | nein | von Hand markiert (`einrichtung_markiert_module = '1'`) |
| `mailvorlagen` | nein | von Hand markiert (`einrichtung_markiert_mailvorlagen = '1'`) |
| `monitoring` | nein | `monitoring_secret` gesetzt ist |
| `jobs` | nein | `sync-personen` mindestens einmal lief (`sync_log`) und `pool-erinnerungen` mindestens einmal beendet wurde (`cron_log`) |

`mail-zustellung` wird beim Auslösen mitgestartet, zählt aber nicht als Nachweis für `jobs`: Der Job protokolliert nur Läufe
mit fälligen Mails. Das Ergebnis zeigt deutsche Namen (Personen-Abgleich, Erinnerungen, Mailzustellung) und Status
(„erfolgreich“, „fehlgeschlagen“, „nichts zu tun“).

## Abschluss und Go-Live-Prüfung

Sobald `einrichtungsStand` zum ersten Mal keine offenen Pflichtschritte misst (auf der Seite, auf dem Dashboard oder im
Statusdienst), wird `einrichtung_abgeschlossen_am` (ISO-Zeitpunkt) einmalig gesetzt und nie zurückgesetzt. Danach:

- erscheint der Dashboard-Hinweis nicht mehr,
- meldet der Statusdienst `einrichtung` dauerhaft `ok`, `aktiv: false`, Grund „Einrichtung abgeschlossen am TT.MM.JJJJ“,
- zeigt der Assistent oben „Einrichtung abgeschlossen am …“, die Schritte aber weiterhin mit ihrem aktuellen Stand.

Sind alle Pflichtschritte aktuell erledigt, zeigt der Assistent unten den Abschnitt **Go-Live-Prüfung**: Statusseite ohne
`fehler`, Testmail zugestellt, aktuelle Sicherung (jünger als 7 Tage) vorhanden, dazu ein Link auf die Go-Live-Checkliste im
README (auf GitHub, wenn die Repository-Adresse bekannt ist).

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
Hat die Person keine E-Mail-Adresse, wird nichts verschickt und die Seite sagt es. Scheitert der Versand oder wird er
wiederholt, verweist die Meldung auf die Zeile Mailserver („siehe Technische Grundlagen → Mailserver“).

## Konfigurationsschlüssel

| Schlüssel | Bedeutung |
|---|---|
| `einrichtung_ohne_zeitstempel` | `1` = bewusster Verzicht auf Zeitstempel; macht `zeitstempel` erledigt |
| `einrichtung_markiert_<id>` | `1` = von Hand als erledigt markiert (`module`, `mailvorlagen`) |
| `einrichtung_spaeter_bis_<personId>` | ISO-Zeitpunkt, bis zu dem der Dashboard-Hinweis für diese Person ausgeblendet ist |
| `einrichtung_abgeschlossen_am` | ISO-Zeitpunkt des ersten Abschlusses aller Pflichtschritte; einmalig gesetzt |

## Dashboard-Hinweis und Statusdienst

Auf `/admin` (nur Superadmin) steht „Ersteinrichtung: X von Y Pflichtschritten erledigt“ mit Link zum Assistenten, solange
Pflichtschritte offen sind und die Einrichtung noch nie abgeschlossen war. „Später“ blendet ihn 7 Tage aus, nur für die
jeweilige Person.

Der 11. Statusdienst `einrichtung` ([statusseite-und-monitoring.md](statusseite-und-monitoring.md)) meldet `warnung` mit der
Anzahl offener Pflichtschritte; nach dem ersten Abschluss dauerhaft `ok` mit `aktiv: false`. Er ist nie `fehler`.

**Hinweis für externe Überwachung:** Solange Pflichtschritte offen sind, ist der Gesamtstatus `warnung`. Ein Monitor auf
`status` (Gesamt-Monitor) bleibt deshalb bis zum Abschluss der Einrichtung gelb bzw. schlägt an. Wer das nicht möchte,
überwacht stattdessen die einzelnen Dienste (`dienste.<schluessel>.status`) und lässt `einrichtung` weg.
