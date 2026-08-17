# Spesen-Einreichung — Design

## Kontext

Das Freigabeportal deckt bisher ausschliesslich Lieferantenrechnungen ab,
die über n8n (Scanner/E-Mail) eingehen und dann Kontierung →
Freigabe 1 → Freigabe 2 durchlaufen. Diese Spec erweitert das Portal um
eine zweite, eigenständige Domäne: **Spesen-Einreichungen**, bei denen eine
Person selbst eine Auslage samt Beleg erfasst, direkt ein Konto wählt und
die Einreichung dieselbe Vier-Augen-Freigabekette durchläuft wie eine
Rechnung — mit einem entscheidenden Unterschied: die einreichende Person
darf sich nie selbst freigeben.

Ausgangspunkt sind folgende, im Gespräch geklärte Entscheidungen:

1. Freigabe läuft über dieselben Freigeber1/Freigeber2 (+ Stellvertreter)
   des gewählten Kontos — kein eigenes Rollenkonzept für Spesen.
2. Nach Freigabe 2 laufen Spesen über dieselbe n8n-Abholung wie Rechnungen
   (`/api/n8n/jobs/abholbereit`), markiert per Typ-Feld.
3. Da die einreichende Person das Konto selbst wählt, ersetzt die
   Einreichung die Kontierung — Freigabe 1 geht aber **immer** an eine
   andere Person (Freigeber1 des Kontos, oder dessen Stellvertreter1, falls
   die einreichende Person selbst der Freigeber1 ist). Die einreichende
   Person gibt sich nie selbst frei.
4. Eine Einreichung ist eine Sammelabrechnung mit mehreren Belegen
   (Positionen); jede Position hat ihr eigenes Konto und durchläuft ihre
   eigene, unabhängige Freigabekette.
5. IBAN/Kontoinhaber für die Überweisung liegen in ChurchTools als
   Custom-Feld pro Person vor und sind über die API abrufbar.

**Leitprinzip für dieses Design:** die bestehende Freigabe-Maschinerie
(`jobs`-/`freigaben`-Tabellen, Status-Automat, Eskalationslogik,
Benachrichtigungen, Audit-Log, Download-Signierung, n8n-Abholung) wird
für Spesen-Positionen **unverändert wiederverwendet** — jede Position ist
technisch ein ganz normaler `jobs`-Datensatz. Neu ist nur, was am Anfang
(Einreichung statt Kontierung durch Dritte) und in der UI (eigene
Review-Seiten statt Bearbeitungsformular) passiert.

## Datenmodell

### `jobs`-Tabelle: Wiederverwendung statt Parallelsystem

Keine neue Typ-Spalte — die bestehende `quelle`-Spalte (aktuell
`CHECK (quelle IN ('scanner', 'lieferant'))`) wird um den Wert `'spesen'`
erweitert. `quelle` ist im bestehenden Code bereits der De-facto-Diskriminator
für "was ist das für ein Dokument" (siehe die vorhandene
`job.quelle === 'scanner' ? 'Scanner' : 'Lieferant'`-Anzeige in
`kontierung.ejs`/`freigabe2.ejs`) — eine zweite, parallele Typ-Spalte wäre
redundant. Da SQLite eine `CHECK`-Änderung nicht per einfachem `ALTER TABLE`
erlaubt, wird `schema.sql`s `CREATE TABLE IF NOT EXISTS jobs (...)` direkt
angepasst (gleiches Vorgehen wie beim späteren Hinzufügen von
`'aufgesplittet'` zum `status`-Enum — vertretbar, solange die App laut
Nutzer noch nicht produktiv ist).

Vier neue, nullable Spalten (nur für `quelle = 'spesen'` befüllt):

| Spalte | Typ | Bedeutung |
|---|---|---|
| `eingereicht_von` | `TEXT REFERENCES personen(churchtools_person_id)` | wer die Auslage hatte / wem erstattet wird |
| `auslage_datum` | `TEXT` | wann die Ausgabe stattfand (ISO-Datum) — bewusst getrennt von `eingang_am`, das den Einreichungszeitpunkt im Portal meint |
| `beschreibung` | `TEXT` | Verwendungszweck der Position |
| `spesenabrechnung_id` | `INTEGER REFERENCES spesenabrechnungen(id)` | Gruppierung zur Sammelabrechnung |

Bereits vorhandene Spalten werden 1:1 weiterverwendet: `konto_id`, `betrag`,
`pdf_pfad` (der Beleg), `dateiname`, `status`, `zugewiesen_an`,
`freigabe1_eskaliert_von`/`freigabe1_eskalationsgrund`,
`freigabe2_eskaliert_von`/`freigabe2_eskalationsgrund`,
`freigabe1_eskaliert_an_admin`/`freigabe2_eskaliert_an_admin`,
`abgelehnt_von`/`ablehnungsgrund`, `reminder_gesendet_at`/
`eskalation_gesendet_at`, `archiviert_am`, `thumbnail_pfad`,
`fetched_by_n8n_at`. Bei Spesen-Positionen bleiben `absender`, `lieferant`,
`rechnungsnummer`, `debitor_id`, `zahlungsziel`, `aufgesplittet_von`
schlicht `NULL` — sie sind rechnungsspezifisch und werden nirgends für
`quelle = 'spesen'` gelesen oder geschrieben.

### Neue Tabelle `spesenabrechnungen`

Reine Gruppierung für die Sammelabrechnung — kein eigener Workflow-Status,
keine eigene Freigabe. Jede Position lebt und stirbt als unabhängiger
`jobs`-Datensatz; diese Tabelle dient nur dazu, der einreichenden Person
ihre zusammengehörigen Positionen wieder anzuzeigen.

```sql
CREATE TABLE IF NOT EXISTS spesenabrechnungen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eingereicht_von TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  eingereicht_am TEXT NOT NULL,
  titel TEXT
);
```

`titel` ist optional (freier Text, z.B. "Reise Zürich 12.–14.8."), damit die
Sammelabrechnung in der eigenen Übersicht wiedererkennbar ist.

## Einreichung

Neue, eigenständige Route (keine Erweiterung von `kontierung.js` — andere
Zielgruppe, anderer Zweck): `src/routes/spesen.js`.

- `GET /spesen/neu`: Formular mit mindestens zwei dynamisch
  hinzufügbaren/entfernbaren Positionszeilen (JS-Muster identisch zur
  bestehenden Aufsplitten-Seite, `views/kontierung-aufsplitten.ejs` —
  gleiche Zeilen-Klonen/Entfernen-Logik, nur dass hier von Null aufgebaut
  statt ein bestehender Betrag aufgeteilt wird). Pro Zeile:
  Konto-Dropdown (`listKontenForPerson`? — nein, hier keine
  Rollen-Einschränkung: **jedes aktive Konto** ist wählbar, da jede
  Person Spesen auf jedes Konto einreichen können soll, nicht nur auf
  Konten, auf denen sie selbst eine Freigeber-Rolle hat — anders als bei
  der Kontierung, wo die Kontoliste auf die Rollen der kontierenden Person
  eingeschränkt ist), Betrag, Auslage-Datum, Beschreibung, Beleg-Datei
  (PDF/Bild). Formularfelder als Arrays (`posKontoId[]`, `posBetrag[]`,
  `posAuslageDatum[]`, `posBeschreibung[]`, `posBeleg[]`), analog zum
  bestehenden `teilKontoId`/`teilBetrag`-Muster; Dateifelder mit
  `upload.array(...)` (multer) statt `upload.single(...)`, Index-Zuordnung
  über Array-Position.
- `POST /spesen`: validiert jede Zeile (gültiges, aktives Konto; Betrag
  nach bestehendem `BETRAG_PATTERN`; Auslage-Datum ein gültiges,
  nicht-zukünftiges Datum; Beschreibung Pflichtfeld; Beleg Pflichtfeld,
  gleiche PDF/Bild-Signaturprüfung wie beim n8n-Upload). Bei Erfolg, in
  einer Transaktion:
  1. `spesenabrechnungen`-Zeile anlegen.
  2. Pro Position eine `jobs`-Zeile: `quelle: 'spesen'`,
     `status: 'zugewiesen'`, `eingereicht_von` = aktuelle Person,
     `zugewiesen_an` = `konto.freigeber1_id` — **ausser** die aktuelle
     Person ist selbst `konto.freigeber1_id`, dann
     `zugewiesen_an = konto.stellvertreter1_id` und
     `freigabe1_eskaliert_von`/`freigabe1_eskalationsgrund` werden
     analog zur bestehenden Konflikt-Eskalation gesetzt (Grund:
     "Selbsteinreichung durch Freigeber1"), damit Audit-Log und
     Benachrichtigungsmail den Grund transparent machen.
  3. Beleg-Datei wird wie beim n8n-Upload ins `jobsDir` kopiert
     (`pdf_pfad`), Thumbnail wird best-effort gerendert
     (`renderFirstPageThumbnail`, gleiche Fehlerbehandlung wie in
     `n8n/jobs.js` — ein fehlgeschlagenes Thumbnail blockiert die
     Einreichung nicht).
  4. Benachrichtigungsmail an den zuständigen Freigeber1 (bzw.
     Stellvertreter1), analog zur bestehenden Zuweisungsmail.
- **Freigabe 1 wird bei der Einreichung nie automatisch erteilt** — anders
  als bei der Kontierung einer Rechnung (wo Kontieren und Freigabe 1
  im selben Schritt passieren, ausser bei erklärtem Interessenskonflikt),
  ist bei Spesen jede Position nach der Einreichung im Status `zugewiesen`
  und wartet aktiv auf die Freigabe-1-Prüfung einer anderen Person.

## Freigabe 1 (neu, review-only)

Da bei der Einreichung bereits alle Daten (Konto, Betrag, Beschreibung,
Beleg) erfasst wurden, gibt es für die prüfende Person nichts mehr
einzutragen — die Seite ist strukturell näher an der bestehenden
Freigabe-2-Seite (reine Anzeige + Freigeben/Ablehnen + Konfliktflag) als
an der Kontierungs-Seite (Bearbeitungsformular). Neue Route
`src/routes/spesenFreigabe1.js`, gemountet auf `/spesen-freigabe1`:

- `GET /spesen-freigabe1/:id`: zeigt Beleg-Vorschau (gleiches PDF.js-Muster
  wie überall sonst), Konto, Betrag, Auslage-Datum, Beschreibung,
  Eingereicht von. Autorisierung analog zu `kontierung.js`s
  `loadAuthorizedJob` (Job muss `status = 'zugewiesen'` sein,
  `zugewiesen_an` muss der aktuellen Person entsprechen, mit dem gleichen
  Admin-Eskalations-Sonderfall wie bei Rechnungen).
- `POST /spesen-freigabe1/:id`: Aktionen `freigeben`/`ablehnen`, plus
  derselbe "Interessenskonflikt"-Radio-Button + Begründung wie bei der
  Kontierung. Zwei unterschiedliche Konfliktquellen sind hier zu
  unterscheiden, nicht zu verwechseln:
  - **Einreicher = Freigeber1 des Kontos**: bereits bei der Einreichung
    automatisch aufgelöst (siehe oben, Zuweisung direkt an
    Stellvertreter1) — dafür braucht die prüfende Person auf dieser Seite
    nichts mehr zu tun.
  - **Jeder andere persönliche Konflikt der prüfenden Person** (z.B.
    verwandtschaftliches oder finanzielles Verhältnis zur einreichenden
    Person, unabhängig davon, ob sie selbst Freigeber1 ist) — dafür bleibt
    der Konflikt-Radio-Button nötig, mit identischer Eskalationslogik wie
    bei der Kontierung (`eskalierenFreigabe1` → Stellvertreter1;
    `eskalierenFreigabe1AnAdmin`, falls auch der Stellvertreter1 die
    einreichende Person selbst ist oder das Konto bereits einmal
    eskaliert wurde — gleiche SYNC-8-Logik wie bei Rechnungen).
  - `freigeben` (kein Konflikt): ruft dieselben Repo-Funktionen wie die
    Kontierung im Nicht-Konflikt-Fall (`createFreigabe` mit
    `rolle: 'freigeber1'`, `abschliessenFreigabe1`) — Ergebnis: Status
    wechselt zu `freigabe2`, `zugewiesen_an` wird auf den effektiven
    Freigeber2 gesetzt (gleiche Logik wie bei Rechnungen,
    `getEffectiveFreigeber2Id`).
  - `ablehnen`: ruft `ablehnenJob` — identisch zur bestehenden
    Ablehnung bei der Kontierung.

## Freigabe 2 — bestehende Seite wiederverwendet

`src/routes/freigabe2.js`/`views/freigabe2.ejs` sind bereits eine reine
Review-Ansicht (Felder werden nur angezeigt, nicht bearbeitet) und ihre
Autorisierung hängt nur an `konto_id`/`status = 'freigabe2'` — funktioniert
für Spesen-Positionen unverändert. Einzige Änderung: die angezeigten
Detail-Felder in `freigabe2.ejs` werden per `job.quelle === 'spesen'`
umgeschaltet (Verwendungszweck/Auslage-Datum/Eingereicht-von statt
Lieferant/Rechnungsnummer/Zahlungsziel). Rechnungen und Spesen erscheinen
dadurch bereits automatisch gemeinsam in der bestehenden "Meine
Freigaben"-Sektion — voraussichtlich ohne Änderung an
`listFreigabe2JobsForPerson`, da diese Query nicht nach `quelle`
filtert (im Implementierungsschritt zu verifizieren).

## PDF-Stempelung wird von n8n unabhängig (betrifft Rechnungen UND Spesen)

**Bestandsaufnahme, wichtig für den Rest dieses Abschnitts:** Das Portal
stempelt die Freigabe-Historie bereits heute selbst ins PDF —
`src/services/pdfStamp.js`s `stampAndFinalize` wird in `freigabe2.js` beim
Abschluss der Freigabe 2 aufgerufen, zeichnet Freigeber1-/Freigeber2-Block
und ein vollständiges Verlauf-Protokoll (`pdf-lib`) und ersetzt
`job.pdf_pfad` durch die gestempelte Fassung, bevor n8n sie abholt. Das ist
also kein neuer Baustein. Was aktuell noch von n8n kommt: die **leere
Visum-Seite selbst** — n8n merged sie vor dem Upload in die Rechnung, und
`stampAndFinalize` sucht diese vorbereitete Seite anhand der Einstellung
"Position der Visum-Seite" (`visum_seite_position`, erste/letzte) und
beschriftet sie.

**Änderung:** `stampAndFinalize` hängt die Visum-Seite künftig **selbst als
neue, leere Seite** an, statt eine von n8n vorbereitete Seite zu suchen.
Damit entfällt die Abhängigkeit von n8ns PDF-Merge-Schritt vollständig —
n8n liefert nur noch das reine, unveränderte Rechnungs- bzw. Beleg-PDF.
Gilt einheitlich für Rechnungen und Spesen (für Spesen ergibt sich das
sogar automatisch: der von der einreichenden Person hochgeladene Beleg
hatte ohnehin nie eine vorbereitete Visum-Seite — mit der neuen,
selbstständigen Erzeugung ist das kein Sonderfall mehr, sondern der
Normalfall für beide Domänen).

Konkrete Auswirkungen:

- `stampAndFinalize(pdfBuffer, stampData, visumSeitePosition)` verliert den
  `visumSeitePosition`-Parameter; statt `pages[0]`/`pages[pages.length - 1]`
  zu wählen, ruft sie `doc.addPage(...)` (gleiche Seitengrösse wie die
  letzte bestehende Seite) und zeichnet auf die neue Seite.
- Die Admin-Einstellung "Position der Visum-Seite"
  (`admin_config`-Schlüssel `visum_seite_position`,
  `src/routes/admin/pdf-einstellungen.js` +
  `views/admin/pdf-einstellungen-form.ejs`) entfällt ersatzlos — es gibt
  keine zu lokalisierende vorbereitete Seite mehr.
- `src/services/thumbnail.js`s `renderFirstPageThumbnail` verliert
  ebenfalls den `visumSeitePosition`-Parameter und rendert immer Seite 0
  (die Original-Rechnung bzw. der Beleg selbst) — ohne vorbereitete
  Visum-Seite im Original gibt es keine "falsche" Seite mehr, die die
  Thumbnail-Logik umgehen müsste. `src/routes/n8n/jobs.js`s
  `POST /` und die neue Spesen-Einreichung (`src/routes/spesen.js`) rufen
  den vereinfachten Aufruf gleich auf.
- **Koordination mit n8n (ausserhalb dieses Repos):** n8ns bestehender
  PDF-Merge-Workflow-Schritt (Visum-Seite anhängen vor dem Upload) muss
  entfernt werden, sonst hätte eine Rechnung nach dieser Änderung zwei
  Visum-Seiten (die alte, leere von n8n plus die neue, beschriftete vom
  Portal). Das ist eine n8n-seitige Änderung, kein Code in diesem Repo,
  aber ein notwendiger, koordinierter Umstellungsschritt.
- **Bestehende, bereits hochgeladene, aber noch nicht final freigegebene
  Jobs** zum Umstellungszeitpunkt haben ggf. noch eine alte, unbeschriftete
  n8n-Visum-Seite im PDF, die nach der Umstellung nicht mehr gefunden/
  beschriftet, sondern von der neuen Seite einfach ergänzt würde (zwei
  Visum-Seiten, eine leer). Da die App laut Nutzer noch nicht produktiv
  ist, wird das nicht als Migrationsproblem behandelt — im
  Implementierungsschritt kurz gegenprüfen, ob zum Umstellungszeitpunkt
  überhaupt offene Jobs existieren.

## n8n-Abholung & Überweisungsdaten

`GET /api/n8n/jobs/abholbereit` (`src/routes/n8n/jobs.js`) liefert
Spesen-Positionen im selben Payload mit, `listAbholbereitJobs` filtert
weiterhin nur nach Status — keine Änderung an der Query nötig. Der
Response-Mapper wird um `quelle`, `eingereicht_von`, `auslage_datum`,
`beschreibung` ergänzt.

**IBAN/Kontoinhaber werden nicht im Portal gespeichert.** Für jede
`quelle = 'spesen'`-Position im Abholbereit-Response wird zum
Antwortzeitpunkt live `fetchPersonById(config.churchtools,
syncServiceToken, job.eingereicht_von)` aufgerufen (bestehende Funktion,
gleicher Login-Token-Mechanismus wie beim nächtlichen Sync) und das
IBAN-Custom-Feld aus der Antwort extrahiert. Begründung: konsistent mit
dem im Lastenheft bereits verankerten Grundsatz, sensible Finanzdaten nicht
länger als nötig im Portal zu halten (siehe die bestehende aktive
Löschung nach Abholung). Schlägt der Abruf fehl (Person nicht auflösbar,
Feld leer), wird die Position trotzdem geliefert, aber mit
`iban: null`/einer Fehlermarkierung — damit ein einzelner ChurchTools-Ausfall
nicht die gesamte Abholung blockiert; n8n entscheidet selbst, wie mit einer
fehlenden IBAN umzugehen ist (z.B. Job überspringen und erneut versuchen).

## Navigation & Einstiegspunkte

- **Menü-Dropdown** (`_header.ejs`): neuer Eintrag "Spesen einreichen" →
  `/spesen/neu`. Anders als "Aufgaben"/"Admin" nicht auf
  Buchhaltung/Portal-Admin beschränkt, sondern für jede eingeloggte
  Person sichtbar (`requireLogin()`-Niveau, wie `/kontierung` etc.).
- **`/pool`-Dashboard** (`views/pool.ejs`, `src/routes/poolPage.js`), zwei
  neue Sektionen, mit dem bestehenden `_job_table.ejs`-Partial:
  - "Meine offenen Spesen-Freigaben": Positionen mit
    `status = 'zugewiesen'`, `quelle = 'spesen'` und
    `zugewiesen_an` = aktuelle Person (neue Repo-Funktion
    `listSpesenFreigabe1JobsForPerson`), `linkPrefix: '/spesen-freigabe1'`,
    `aktionLabel: 'Prüfen'`.
  - "Meine Spesen": alle `quelle = 'spesen'`-Jobs mit
    `eingereicht_von` = aktuelle Person, über alle Stati hinweg (neue
    Repo-Funktion `listSpesenForEinreicher`) — reine
    Statusübersicht ohne Aktionslink, damit die einreichende Person den
    Fortschritt ihrer eigenen Auslagen verfolgen kann.
  - Die bestehenden Sektionen "Pool", "Meine offenen Kontierungen" und
    "Meine abgelehnten Jobs" schliessen `quelle = 'spesen'` explizit aus
    (`WHERE quelle != 'spesen'` ergänzt in den zugrunde liegenden
    Queries) — sie sind für den Kontierungs-Workflow gebaut, der bei
    Spesen nicht existiert. "Meine Freigaben" (Freigabe 2) bleibt bewusst
    typübergreifend (siehe oben).

## Bewusst nicht Teil dieser Spec (YAGNI)

- **Kein Spesen-Pool.** Es gibt keine unzugewiesene Phase — das Konto wird
  bei der Einreichung direkt gewählt, es gibt nichts, das jemand aus
  einem Pool beanspruchen müsste.
- **Kein Wiederaufnahme-Workflow für abgelehnte Spesen.** Anders als bei
  Rechnungen (`/abgelehnt/:id/ueberarbeiten` → zurück zur Kontierung) gibt
  es für Spesen keine entsprechende Bearbeitungsseite. Eine abgelehnte
  Position bleibt sichtbar (in "Meine Spesen", mit Ablehnungsgrund); für
  eine Korrektur reicht die Person neu ein. Die bestehende
  Ablehnungs-Route/-Seite (`ablehnung.js`/`abgelehnt.ejs`) wird für
  Spesen nicht aufgerufen und nicht angepasst.
- **Keine gemischten Sammelabrechnungen** mit sowohl Rechnungs- als auch
  Spesen-Positionen — eine Sammelabrechnung ist immer rein Spesen.
- **Kein Caching der IBAN-Daten** im Portal — immer Live-Abruf bei
  Abholung (siehe oben).
- **Kein Admin-UI zur Konfiguration** des ChurchTools-Custom-Feld-Namens
  für IBAN/Kontoinhaber — das ist eine installationsspezifische, technische
  Konstante (kein Business-Setting, das ein Admin im laufenden Betrieb
  ändern würde), also als neue `.env`-Variablen `CT_CUSTOM_FIELD_IBAN`/
  `CT_CUSTOM_FIELD_KONTOINHABER` vorgesehen — gleiches Muster wie die
  bestehenden `CT_GROUP_ID_BUCHHALTUNG`/`CT_GROUP_ID_ADMIN`, nicht über
  `admin_config`.

## Offene Annahme, vor Implementierung zu verifizieren

Der exakte Feldname/-schlüssel des IBAN-Custom-Felds in der
ChurchTools-Instanz ist noch nicht bekannt und muss vor der Umsetzung des
Abholung-Bausteins in der ChurchTools-API-Antwort für `/api/persons/{id}`
nachgesehen werden (z.B. über einen Test-Abruf mit dem
Sync-Service-Account).

## Betroffene/neue Dateien (Übersicht, kein Implementierungsplan)

- `src/db/schema.sql` — `quelle`-CHECK erweitert, vier neue `jobs`-Spalten,
  neue Tabelle `spesenabrechnungen`.
- `src/db/spesenabrechnungenRepo.js` (neu) — `createSpesenabrechnung`.
- `src/db/jobsRepo.js` (erweitert) — `createSpesenPosition`,
  `listSpesenFreigabe1JobsForPerson`, `listSpesenForEinreicher`; bestehende
  Pool-/Kontierungs-Queries um `quelle != 'spesen'` ergänzt.
- `src/routes/spesen.js` (neu) — Einreichung.
- `src/routes/spesenFreigabe1.js` (neu) — Freigabe-1-Review.
- `src/routes/freigabe2.js` (marginal erweitert) — kein neuer Code, ggf.
  IBAN-unabhängig unverändert.
- `views/spesen-neu.ejs` (neu), `views/spesen-freigabe1.ejs` (neu).
- `views/freigabe2.ejs` (erweitert um `quelle`-abhängige Feldanzeige).
- `views/pool.ejs`, `src/routes/poolPage.js` (neue Sektionen).
- `views/_header.ejs` (neuer Menüpunkt).
- `src/routes/n8n/jobs.js` (Abholung erweitert, IBAN-Live-Abruf, vereinfachter
  Thumbnail-Aufruf ohne `visumSeitePosition`).
- `src/services/churchtools.js` (ggf. kleine Ergänzung, um das
  IBAN-Custom-Feld aus `fetchPersonById`s Antwort zu extrahieren).
- `src/services/pdfStamp.js` (`stampAndFinalize` hängt die Visum-Seite
  selbst an, statt eine vorbereitete zu suchen — `visumSeitePosition`-
  Parameter entfällt).
- `src/services/thumbnail.js` (`renderFirstPageThumbnail` rendert immer
  Seite 0, `visumSeitePosition`-Parameter entfällt).
- `src/routes/admin/pdf-einstellungen.js` +
  `views/admin/pdf-einstellungen-form.ejs` (Feld "Position der
  Visum-Seite" entfernt).
- **Ausserhalb dieses Repos:** n8ns PDF-Merge-Workflow-Schritt (Visum-Seite
  vor Upload anhängen) muss entfernt werden — koordinierte Umstellung, kein
  Code hier.
