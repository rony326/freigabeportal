# Ferienmodus (Vacation Mode) — Design

## Zweck

Personen sollen für einen Zeitraum, in dem sie abwesend sind, selbst eine
Stellvertretung angeben können. Die Stellvertretung erhält für diesen
Zeitraum **additiven** Zugriff auf alle Kontierungs-, Freigeber1- und
Freigeber2-Zuständigkeiten der abwesenden Person, zusätzlich zu deren
eigenem, unverändertem Zugriff (die abwesende Person kann jederzeit selbst
weiter handeln, falls sie doch online ist).

Dies ist ein **anderer Mechanismus** als der bereits bestehende, pro-Konto
fest hinterlegte `stellvertreter1_id`/`stellvertreter2_id`
(Interessenskonflikt-Eskalation, siehe
[rechnungs-workflow.md](../../rechnungs-workflow.md)). Beide Konzepte
bestehen unabhängig nebeneinander; Ferienmodus ändert nichts an der
Konto-Eskalationslogik.

## Umfang (bewusst additiv, kein Reassignment)

- Kontierung-Zuweisung (`jobs.zugewiesen_an`)
- Freigeber1-Rolle auf einem Konto
- Freigeber2-Rolle auf einem Konto (inkl. bereits eskalierter Fälle:
  effektiver Freigeber2)
- Pool-Weiterleitung (`POST /pool/:id/zuweisen`) als Zielperson — braucht
  keinen eigenen Mechanismus, siehe Abschnitt "Autorisierung".

Es gibt **keine** Datenbank-Reassignment (`zugewiesen_an` etc. bleiben
unverändert) — Ferienmodus ist eine reine Autorisierungs-/Sichtbarkeits-/
Benachrichtigungs-Erweiterung on top.

## Datenmodell

Drei neue, nullable Spalten auf `personen` (kein eigenes History-Tracking
nötig — additiv, ein Zeitraum reicht; ein neuer Eintrag überschreibt den
alten):

```sql
ALTER TABLE personen ADD COLUMN ferienmodus_von TEXT;               -- Datum YYYY-MM-DD
ALTER TABLE personen ADD COLUMN ferienmodus_bis TEXT;                -- Datum YYYY-MM-DD
ALTER TABLE personen ADD COLUMN ferienmodus_stellvertreter_id TEXT
  REFERENCES personen(churchtools_person_id);
```

"Aktiv" wird nie gespeichert, sondern immer berechnet: `ferienmodus_von IS
NOT NULL AND date('now') BETWEEN ferienmodus_von AND ferienmodus_bis`. Kein
Cron-Job nötig, kein Risiko eines vergessenen Ausschaltens über das
Enddatum hinaus.

Ferienmodus beenden/ändern: alle drei Felder werden überschrieben
(neuer Zeitraum) oder auf `NULL` gesetzt (beenden). Es gibt zu jedem
Zeitpunkt höchstens einen (aktuellen oder zukünftig geplanten) Zeitraum pro
Person.

Eine neue Spalte auf `freigaben` für den Audit-Vermerk:

```sql
ALTER TABLE freigaben ADD COLUMN vertretung_fuer TEXT
  REFERENCES personen(churchtools_person_id);
```

Gesetzt, wenn die handelnde Person zum Zeitpunkt der Aktion aktive
Stellvertretung von `vertretung_fuer` war — `NULL` im Normalfall.

## Zentraler Helper (`src/services/vertretung.js`)

```js
getAktivenVertreter(db, personId) -> stellvertreterId | null
istAktiveVertretungFuer(db, kandidatId, urspruenglichePersonId) -> boolean
listVertretungsKandidaten(db, personId) -> Person[]   // für die Auswahl im Self-Service-Formular
```

`listVertretungsKandidaten` nutzt eine neue, breitere Konten-Abfrage
(`listKontenForPersonAnyRole`, alle vier Rollenspalten statt nur
Freigeber1/Stellvertreter1 wie das bestehende `listKontenForPerson`) und
bildet die Vereinigung aller Rolleninhaber auf diesen Konten, abzüglich der
Person selbst, gefiltert auf `aktiv = 1`.

## Self-Service UI

Neue Route `GET/POST /ferienmodus`, für jede eingeloggte Person erreichbar.
Neuer Eintrag im "Menü"-Dropdown (`views/_header.ejs`, neben "Meine
Spesen"/"Meine abgeschlossenen Rechnungen").

- **Anzeige**: aktueller Status — kein Ferienmodus / geplant ab X / aktiv
  bis X — inkl. gewähltem Stellvertreter.
- **Formular**: Von-Datum, Bis-Datum, Stellvertreter-Dropdown
  (`listVertretungsKandidaten`). "Ferienmodus beenden"-Button löscht alle
  drei Felder.
- **Validierung**: Bis ≥ Von, Stellvertreter muss aus der Kandidatenliste
  stammen (serverseitig erneut geprüft, nicht nur im Dropdown), Stellvertreter
  ≠ man selbst.

## Autorisierung & Sichtbarkeit

Jede bestehende Einzel-Job-Zuständigkeitsprüfung `X === currentPerson.id`
wird additiv erweitert zu `X === currentPerson.id ||
istAktiveVertretungFuer(db, currentPerson.id, X)`:

- `loadAuthorizedJob` (`src/routes/kontierung.js`) — Zugriff auf
  `GET/POST /kontierung/:id`
- `loadAuthorized` (`src/routes/freigabe2.js`) — Zugriff auf
  `GET/POST /freigabe2/:id`
- `canViewJobPdf` (`src/services/jobAuthorization.js`) — PDF-Vorschau,
  Thumbnail, Zeitstempel-Verifikation
- `istEchterFreigeber1`-Check (strikte Freigeber1-Prüfung,
  `src/routes/kontierung.js`, nur relevant wenn der Modul-Schalter aktiv
  ist)

**Vier-Augen-Prinzip bleibt unverändert**: der Zusatz-Check in
`freigabe2.js`, der verhindert, dass dieselbe Person Freigabe 1 und
Freigabe 2 desselben Jobs erteilt, vergleicht weiterhin die tatsächlich
handelnde `person_id` — unabhängig davon, ob sie gerade in einer
Vertretungsrolle handelt.

**Dashboard-Sichtbarkeit** (`src/db/jobsRepo.js`): `listZugewiesenJobsForPerson`
und `listFreigabe2JobsForPerson` werden um eine zusätzliche
`OR`-Bedingung erweitert, die Jobs einschliesst, deren zuständige Person
gerade von der aufrufenden Person vertreten wird:

```sql
zugewiesen_an = ?
OR zugewiesen_an IN (
  SELECT churchtools_person_id FROM personen
  WHERE ferienmodus_stellvertreter_id = ?
    AND ferienmodus_von IS NOT NULL
    AND date('now') BETWEEN ferienmodus_von AND ferienmodus_bis
)
```

(analog für `konten.freigeber2_id`/`stellvertreter2_id` in
`listFreigabe2JobsForPerson`). Ohne diese Erweiterung wäre eine vertretene
Aufgabe zwar per direktem Link erreichbar, aber nicht im eigenen
`/pool`-Dashboard sichtbar.

**Pool-Weiterleitung** (`POST /pool/:id/zuweisen`) braucht keine eigene
Änderung: sie weist weiterhin der Originalperson zu
(`zielPersonen = listPersonenMitFreigeberRolle(db)`, unverändert); ist
diese Person danach im Ferienmodus, greifen die oben erweiterten
Kontierung-Checks automatisch auch für ihren Stellvertreter.

## Benachrichtigungen

Neuer Helper in `src/services/notify.js` (oder `vertretung.js`):

```js
async function sendNotificationMitVertretung(db, mailer, { person, typ, jobId, variablen }) {
  await sendNotification(db, mailer, { to: person.email, typ, jobId,
    variablen: { ...variablen, empfaengerName: `${person.vorname} ${person.nachname}` } });
  const vertreterId = getAktivenVertreter(db, person.churchtools_person_id);
  if (!vertreterId) return;
  const vertreter = getPersonById(db, vertreterId);
  if (!vertreter) return;
  await sendNotification(db, mailer, { to: vertreter.email, typ, jobId,
    variablen: { ...variablen, empfaengerName: `${vertreter.vorname} ${vertreter.nachname}`,
      grund: `(Als Stellvertreter für ${person.vorname} ${person.nachname} im Ferienmodus) ${variablen.grund}` } });
}
```

Ersetzt bestehende direkte `sendNotification(db, mailer, { to: x.email,
... })`-Aufrufe überall dort, wo `x` eine im Ferienmodus-Umfang
abgedeckte Zuständigkeit ist:

- initiale Zuweisungs-Mail bei automatischer Zuweisungsregel
  (`src/routes/n8n/jobs.js`)
- Kontierung-Zuweisungs-Mail bei Pool-Weiterleitung (`poolPage.js`)
- Freigabe-2-fällig-Mail (`kontierung.js`, nach erfolgreicher Kontierung)
- Ablehnungs-Mail an die zum Ablehnungszeitpunkt zuständige Person
  (`freigabe2.js`)

Mails im Zusammenhang mit der **bestehenden** Konto-Interessenskonflikt-
Eskalation (an `stellvertreter1_id`/`stellvertreter2_id`) bleiben
unverändert — eigener, unabhängiger Mechanismus, kein Ferienmodus-Bezug.

## Audit-Vermerk

An jeder `createFreigabe(...)`-Stelle, die zu einer der oben erweiterten
Autorisierungs-Prüfungen gehört (`freigeber1`, `freigeber2`, `ablehnung`),
wird zusätzlich `vertretungFuer` übergeben, wenn
`istAktiveVertretungFuer(db, actingPersonId, urspruenglichZustaendigeId)`
zutrifft — sonst `null` wie bisher.

`src/services/auditLog.js` (`buildAuditLog`) liest die neue Spalte mit aus
und hängt bei Bedarf einen Zusatz an den gerenderten Eintrag an, z. B.:

> Max Muster (als Stellvertreter für Anna Beispiel) — Freigabe 1 erteilt

## Admin-Übersicht

`Admin → Personen` (`views/admin/personen-liste.ejs`,
`src/routes/admin/personen.js`): rein informative Zeile/Badge pro Person
mit gesetztem `ferienmodus_von`, z. B. "Ferienmodus: 10.–24.09.2026,
Stellvertreter: Max Muster". Kein Bearbeiten von der Admin-Seite aus —
Selbstbedienung bleibt exklusiv, wie in der Klärung entschieden.

## Explizit ausserhalb des Umfangs

- Keine Admin-Verwaltung von Ferienmodus für andere Personen (nur
  Selbstbedienung).
- Keine Änderung an der bestehenden Konto-Interessenskonflikt-Eskalation
  (`stellvertreter1_id`/`stellvertreter2_id`).
- Keine Sperrung der abwesenden Person selbst (additiv, kein Reassignment).
- Kein Verketten von Vertretungen (Stellvertreter A, der selbst im
  Ferienmodus mit Stellvertreter B ist, vertritt nicht transitiv auch die
  Person, die A vertritt) — ein Auflösungsschritt reicht für den
  angefragten Umfang.
- Keine Mail-Erweiterung für die Konto-Interessenskonflikt-Eskalationsmails
  oder für Spesen-Freigabe1-Mails (nicht Teil des angefragten Umfangs;
  kann bei Bedarf in einem Folge-Schritt ergänzt werden).

## Betroffene Dateien (Übersicht für die Implementierungsplanung)

- `src/db/schema.sql` — neue Spalten
- `src/db/personenRepo.js` — Lese-/Schreibfunktionen für die drei
  Ferienmodus-Felder
- `src/db/kontenRepo.js` — `listKontenForPersonAnyRole`,
  `listVertretungsKandidaten`
- `src/db/freigabenRepo.js` — `vertretungFuer`-Feld bei `createFreigabe`
- `src/services/vertretung.js` — neuer zentraler Helper
- `src/services/notify.js` — `sendNotificationMitVertretung`
- `src/services/jobAuthorization.js` — `canViewJobPdf`-Erweiterung
- `src/services/auditLog.js` — Rendering des Vertretungs-Vermerks
- `src/routes/kontierung.js`, `src/routes/freigabe2.js`,
  `src/routes/poolPage.js`, `src/routes/n8n/jobs.js` — Autorisierungs- und
  Mail-Anpassungen
- `src/db/jobsRepo.js` — `listZugewiesenJobsForPerson`,
  `listFreigabe2JobsForPerson`
- neue Route `src/routes/ferienmodus.js` + View `views/ferienmodus.ejs`
- `views/_header.ejs` — Menü-Eintrag
- `src/routes/admin/personen.js`, `views/admin/personen-liste.ejs` —
  Anzeige
- `docs/rechnungs-workflow.md`, `docs/auth-und-rechte.md`,
  `docs/datenmodell.md` — Dokumentation nachziehen (Projekt-Konvention,
  siehe [Umfassende Doku](../../README.md))
