# Admin-Dashboard laufende Vorgänge + Umhängen — Design

Datum: 2026-10-19
Status: In Review

## Ziel

Admins sollen auf einer Seite **alle laufenden Vorgänge** (Rechnungen,
Gutschriften, Spesen) mit Status sehen — inklusive **wer aktuell zuständig
ist** und **wer voraussichtlich Freigabe 2 erteilt**. Mit dem passenden
Recht kann ein Admin in einen laufenden Vorgang eingreifen und ihn mit
Pflicht-Bemerkung **einer anderen Person zuweisen** — in den Phasen Pool,
Kontierung/Freigabe 1, Freigabe 2 und Abgelehnt.

Erfolgskriterien:

- Ein Admin sieht ohne Klick-Marathon, wo jeder offene Vorgang steht und
  bei wem er liegt; hängende und überfällige Vorgänge fallen auf.
- Ein Vorgang lässt sich in jeder offenen Phase an eine andere Person
  übergeben; die bisherige Person verliert den Zugriff.
- Jeder Eingriff ist begründet, im Verlauf/Audit-Log/auf der Stempelseite
  nachvollziehbar, und Beteiligte werden per Mail informiert.
- Vier-Augen-Prinzip, Interessenskonflikt-Ausschlüsse und strikte
  Freigeber1-Prüfung bleiben unverändert wirksam.

## Getroffene Entscheidungen

| Frage | Entscheidung |
|---|---|
| Phasen mit Eingriff | `unzugewiesen`, `zugewiesen`, `freigabe2`, `abgelehnt` |
| Zielpersonen | aktive Personen mit mind. einer Konto-Rolle (Freigeber1/2, Stellvertreter1/2) auf einem aktiven Konto, minus Ausschlüsse |
| Bisherige Person | verliert den Zugriff (exklusiver Wechsel), erhält Info-Mail |
| Ansatz | A: `zugewiesen_an` für Pool/Kontierung/Abgelehnt, neue Spalte `freigabe2_umgeleitet_an` für Freigabe 2; keine generische Zuständigkeitstabelle |
| Strikte Freigeber1-Prüfung | bleibt in Kraft, Admin-Eingriff hebelt sie nicht aus (nur Warnhinweis im Formular) |
| Lebensdauer F2-Umleitung | endet, sobald der Job `freigabe2` verlässt (Abschluss oder Ablehnung) |
| Rechte | Ansehen: neues Recht `vorgaenge_einsehen`; Eingreifen: bestehendes `workflow_eingreifen` |

## 1. Dashboard `/admin/vorgaenge`

Neue Kachel "Laufende Vorgänge" im Admin-Dashboard, Eintrag in der
Admin-Navigation (`src/middleware/nav.js`).

**Umfang:** alle Jobs mit Status `unzugewiesen`, `zugewiesen`,
`freigabe2`, `abgelehnt`. Nicht enthalten: `abgeschlossen`, `abgeholt`,
`archiviert`, `geloescht`, `aufgesplittet` (Elternjobs; ihre Teil-Jobs
erscheinen normal als eigene Zeilen) sowie die nie gesetzten Altwerte
`kontiert`/`freigabe1`.

**Spalten:**

| Spalte | Inhalt |
|---|---|
| Eingang / seit | `eingang_am` und Dauer im aktuellen Status (`freigabe2_seit` bei `freigabe2`, sonst bestmögliche Annäherung über den letzten `freigaben`-Eintrag bzw. `eingang_am`) |
| Art | Rechnung / Gutschrift / Spesen (`quelle`, `typ`) |
| Lieferant bzw. Einreicher, Betrag, Konto | aus dem Job |
| Status | plus Kennzeichen: Rückläufer, Admin-Eskalation (F1/F2), Interessenskonflikt-Eskalation, "umgeleitet" |
| Aktuell zuständig | siehe Tabelle unten; bei aktiver Ferienvertretung zusätzlich "vertreten durch X" |
| Voraussichtlich Freigabe 2 | nur bei `zugewiesen`/`abgelehnt`, siehe unten |
| Warnung | "hängt" nach derselben Definition wie `listStalledJobs` |

**Aktuell zuständig:**

| Status | Anzeige |
|---|---|
| `unzugewiesen` | "Pool" (bzw. "Pool – Rückläufer") |
| `zugewiesen` / `abgelehnt` | `zugewiesen_an`; bei `freigabe1_eskaliert_an_admin = 1` "Admin-Gruppe" |
| `freigabe2` | effektive Freigabe-2-Person (siehe Abschnitt 3), bei Admin-Eskalation "Admin-Gruppe" |

**Voraussichtlich Freigabe 2** (bei `zugewiesen`/`abgelehnt`):
Freigeber 2 des ersten vorhandenen Kontos aus `konto_id` → Default-Konto
des Kreditors (`kreditoren.konto_id`) → `hinweis_konto_id`. Ist
`freigabe2_eskaliert_von` bereits gesetzt (Rework nach Konflikt), dann
Stellvertreter 2. Stammt der Wert nicht aus `konto_id`, wird er als
"Prognose" gekennzeichnet; ohne Anhaltspunkt "noch offen". Bei
`unzugewiesen` analog nach Kreditor/Hinweis-Konto, sonst "noch offen".

**Filter (GET-Parameter):** Status, Art, zuständige Person, "nur hängende
/ überfällige" (überfällig = Erinnerungsfrist aus `/admin/eskalation`
überschritten). Sortierung: älteste zuerst. Jede Zeile verlinkt auf die
bestehende Job-Detailseite (Verlauf, PDF).

Die Daten liefert eine neue Service-Funktion `listLaufendeVorgaenge(db,
filter)` in `src/services/vorgaengeUebersicht.js`, die pro Job ein
Anzeigeobjekt (inkl. aufgelöster Personennamen) erzeugt. Die
Personennamen werden einmal pro Request gesammelt geladen, nicht pro Zeile.

## 2. Umhängen

**UI:** Button "Umhängen" je Zeile (nur mit `workflow_eingreifen`) →
`GET /admin/vorgaenge/:id/umhaengen`: aktueller Stand (Status, zuständige
Person, Konto, letzte Verlaufseinträge), Dropdown erlaubter Zielpersonen,
Pflicht-Bemerkung (mind. 10 Zeichen nach Trim), Bestätigungs-Checkbox.
Hidden Fields `stand_status` und `stand_zustaendig` halten den beim Laden
gesehenen Stand fest. `POST /admin/vorgaenge/:id/umhaengen` führt aus.

**Wirkung pro Phase** (neue Repo-Funktion `adminUmhaengen(db, jobId,
{ zielId, erwartet })` in `src/db/jobsRepo.js`, je Phase ein eigenes
`UPDATE ... WHERE id = ? AND status = ? AND <zuständig wie erwartet>`):

| Phase | Wirkung |
|---|---|
| `unzugewiesen` | `status = 'zugewiesen'`, `zugewiesen_an = ziel`, `pool_rueckgesendet_*` = NULL, `reminder_gesendet_at`/`eskalation_gesendet_at` = NULL (identisch zum Ergebnis der Pool-Weiterleitung) |
| `zugewiesen` | `zugewiesen_an = ziel`, `freigabe1_eskaliert_an_admin = 0`, `reminder_gesendet_at`/`eskalation_gesendet_at` = NULL; Konto, Konflikt-Historie (`freigabe1_eskaliert_von`) und erfasste Daten bleiben |
| `freigabe2` | `freigabe2_umgeleitet_an = ziel`, `freigabe2_eskaliert_an_admin = 0`, `freigabe2_seit = now`, `freigabe2_reminder_gesendet_at`/`freigabe2_eskalation_gesendet_at` = NULL; Freigabe 1 und `freigabe2_eskaliert_von` bleiben |
| `abgelehnt` | `zugewiesen_an = ziel`, `freigabe1_eskaliert_an_admin = 0` |

Erneutes Umhängen überschreibt einfach. `freigabe2_umgeleitet_an` wird in
`abschliessenFreigabe2` und `ablehnenJob` auf NULL gesetzt, ebenso in den
Vollständig-Reset-Funktionen (`releaseJob`, `sendJobBackToGroup`,
`forceReleaseJob`).

**Erlaubte Zielpersonen** (`listUmhaengenZiele(db, job)`): aktive
Personen mit Konto-Rolle auf einem aktiven Konto (bestehende Abfrage aus
der Pool-Weiterleitung), ohne die aktuell zuständige Person, ohne:

- bei `freigabe2`: die Person des letzten `freigaben`-Eintrags mit
  `rolle = 'freigeber1'` für diesen Job (dieselbe Regel wie die
  bestehende Vier-Augen-Prüfung in `src/routes/freigabe2.js`),
  `freigabe2_eskaliert_von`, bei Spesen `eingereicht_von`
- bei `zugewiesen`/`abgelehnt`: `freigabe1_eskaliert_von`, bei Spesen
  `eingereicht_von`

Der Admin darf sich selbst wählen, sofern ihn keine Ausschlussregel
trifft. Die bestehende harte Vier-Augen-Prüfung in `/freigabe2/:id` bleibt
zusätzlich als zweite Verteidigungslinie bestehen.

**Strikte Freigeber1-Prüfung:** unverändert. Ist
`kontierung_strikte_freigeber1_pruefung` aktiv, ein Konto am Job gesetzt
und die Zielperson nicht dessen Freigeber 1 (bzw. Stellvertreter 1 bei
laufender Eskalation), zeigt das Formular den Hinweis "Wird bei der
Kontierung an den echten Freigeber 1 weitergeleitet." Kein Bypass.

**Protokoll:** `freigaben`-Eintrag mit `rolle = 'admin_umzuweisung'`,
`person_id` = Admin, `kommentar` = Bemerkung, neue Spalten
`vorher_zustaendig` (Person-ID oder NULL für Pool/Admin-Gruppe) und
`ziel_person_id`. Der Eintrag erscheint im Job-Verlauf
(`src/services/auditLog.js`, neue Formulierung "Admin X hat den Vorgang
von Y an Z übergeben: <Bemerkung>"), im globalen Audit-Log und auf der
Stempelseite.

**Mails:** neuer Typ `admin-umzuweisung` mit editierbarer Standardvorlage
(Variablen u. a. `%empfaenger%`, `%admin%`, `%bemerkung%`, `%link%`,
`%vorgang%`). An die Zielperson ("Ihnen wurde ein Vorgang zugewiesen")
und, falls die bisher zuständige Person eine Einzelperson war, eine
Info-Mail an sie ("Vorgang wurde an Z übergeben"). Immer sofort, nie
gebündelt (wie `sync-fehler`/`iban-warnung`). Versand über die
bestehende Mail-Outbox nach Commit der Transaktion.

**Gleichzeitige Änderungen:** Liefert das `UPDATE` 0 Zeilen (Status oder
Zuständigkeit weicht vom Formularstand ab), wird nichts geschrieben und
das Formular mit "Vorgang hat sich inzwischen geändert — bitte neu laden"
erneut angezeigt (HTTP 409).

## 3. Effektive Freigabe-2-Person — eine Quelle der Wahrheit

Neue Reihenfolge:

1. `freigabe2_eskaliert_an_admin = 1` → Admin-Gruppe
2. `freigabe2_umgeleitet_an` gesetzt → diese Person
3. `freigabe2_eskaliert_von` gesetzt → `konten.stellvertreter2_id`
4. sonst → `konten.freigeber2_id`

danach wie bisher Ferienmodus-Vertretung der ermittelten Person. Weil das
Umhängen die Admin-Eskalation zurücksetzt, ist eine später (z. B. per
`freigabe2-erinnerungen` nach Fristablauf) gesetzte Admin-Eskalation stets
die neuere Entscheidung.

Umsetzung an genau zwei Stellen, beide in `src/db/jobsRepo.js`:

- JS: `getEffectiveFreigeber2Id(job, konto)` berücksichtigt Schritt 2.
- SQL: ein exportiertes Fragment `EFFEKTIVER_FREIGEBER2_SQL` (CASE-Ausdruck
  über `jobs`/`konten`), das alle Abfragen nutzen, die heute die Logik
  inline wiederholen (Aufgabenlisten im `/pool`-Dashboard inkl.
  Vertretung, `listFreigabe2JobsForReminder`,
  `listFreigabe2JobsForEskalation`, `listStalledJobs`) sowie das neue
  Dashboard.

Ein Konsistenztest stellt sicher, dass JS- und SQL-Variante für alle
Fälle dasselbe liefern.

**Interessenskonflikt der umgeleiteten Person** bei `/freigabe2/:id`:
direkt `eskalierenFreigabe2AnAdmin` (SYNC-8-Weg), `freigabe2_umgeleitet_an`
wird NULL gesetzt. Kein Rücksprung auf Stellvertreter 2.

**Unverändert:** Kontierung, Ablehnung/Überarbeiten und Spesen-Freigabe 1
hängen bereits an `zugewiesen_an`; Konflikt-Eskalation, strikte Prüfung
und Ferienvertretung funktionieren dort ohne Änderung.

## 4. Rechte

- Neues vergebbares Recht `vorgaenge_einsehen` ("Laufende Vorgänge
  einsehen") in `GRANTABLE_BERECHTIGUNGEN`/`BERECHTIGUNG_LABELS`;
  `superadmin` und `manager` erhalten es über ihr Rollen-Bundle.
- `GET /admin/vorgaenge`: `requirePermission('vorgaenge_einsehen')`.
- `GET/POST /admin/vorgaenge/:id/umhaengen`:
  `requirePermission('workflow_eingreifen')` (manager also nicht).
- Label von `workflow_eingreifen` → "In laufende Vorgänge eingreifen".
- POST mit CSRF-Token; `csrfSweep.test.js` deckt die neue Route ab.
  Abgewiesene Zugriffe laufen über die bestehende
  Verweigerungs-Protokollierung.

## 5. Datenbank-Migrationen

Nach dem vorhandenen Muster für CHECK-Erweiterungen (`src/db/index.js`,
Marker-basierte Tabellen-Neuerstellung mit FK-Enforcement aus):

- `jobs.freigabe2_umgeleitet_an TEXT REFERENCES personen(churchtools_person_id)`
  (nullable)
- `freigaben`: Rolle `admin_umzuweisung` in den CHECK aufnehmen; Spalten
  `vorher_zustaendig TEXT`, `ziel_person_id TEXT` (nullable)
- `person_berechtigungen`: Recht `vorgaenge_einsehen` in den CHECK
- `mail_log`: Typ `admin-umzuweisung` in den CHECK; Standardvorlage in
  den Mail-Vorlagen-Defaults

## 6. Fehlerbehandlung

| Situation | Verhalten |
|---|---|
| Job nicht gefunden oder nicht in einer der vier Phasen | 404 bzw. Hinweis "nicht (mehr) umhängbar" |
| Zielperson nicht erlaubt (inkl. manipuliertes Formular) | 422, Formular mit Fehlermeldung |
| Bemerkung fehlt / zu kurz | 422, Formular mit Fehlermeldung |
| Stand hat sich geändert | 409, Formular neu mit aktuellem Stand |
| Mailversand scheitert | Umhängen bleibt gültig; Mail bleibt in der Outbox und wird per `mail-zustellung` wiederholt |

## 7. Tests

- **Repo `adminUmhaengen`:** jede der vier Phasen setzt genau die
  beschriebenen Felder; veralteter Stand → 0 Zeilen, nichts geschrieben;
  `freigabe2_umgeleitet_an` wird in Abschluss, Ablehnung und den
  Reset-Funktionen gelöscht.
- **Effektive Freigabe-2-Person:** JS und SQL-Fragment liefern dasselbe
  für Admin-Eskalation, Umleitung, Stellvertreter 2, Freigeber 2, jeweils
  mit/ohne Ferienvertretung.
- **Freigabe 2:** umgeleitete Person darf freigeben; ursprünglicher
  Freigeber 2 bekommt 403; Freigeber-1-Person ist nie wählbar und wird
  auch bei manipuliertem POST abgewiesen; Konflikt der umgeleiteten
  Person → Admin-Eskalation, Umleitung gelöscht.
- **Hintergrund-Jobs:** `freigabe2-erinnerungen` adressiert die
  umgeleitete Person; `listStalledJobs` erkennt eine deaktivierte
  umgeleitete Person.
- **Routen:** Dashboard nur mit `vorgaenge_einsehen`; manager sieht
  Dashboard, aber kein Umhängen (403); Ausschlüsse und fehlende Bemerkung
  → 422; Erfolg schreibt `freigaben`-Eintrag und reiht zwei Mails ein.
- **Prognose "Voraussichtlich Freigabe 2":** Konto, Kreditor-Default,
  Hinweis-Konto, "noch offen", Stellvertreter 2 nach Konflikt.

## 8. Dokumentation

Aktualisieren: `docs/rechnungs-workflow.md` (Status-Diagramm um
Admin-Umhängen ergänzen, neuer Abschnitt), `docs/admin-bereich.md`,
`docs/auth-und-rechte.md`, `docs/datenmodell.md`,
`docs/geplante-jobs-und-benachrichtigungen.md` (Mail-Typ, Erinnerungen
an umgeleitete Person), `docs/personen-sync.md` (Stalled-Definition).

## Nicht Teil dieses Designs

- Massen-Umhängen mehrerer Vorgänge auf einmal.
- Eingriff in abgeschlossene/archivierte Vorgänge.
- Ändern von Konto oder Kontierungsdaten durch den Admin.
- Live-Aktualisierung des Dashboards (normale Seite, neu laden genügt).
