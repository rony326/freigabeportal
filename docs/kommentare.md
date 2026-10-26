# Kommentare an Rechnungen

Beteiligte können an einem Vorgang Rückfragen und Kommentare hinterlassen,
statt sie per Mail oder Telefon zu klären. Die Kommentare stehen auf der
Detailseite des Vorgangs, lösen eine Benachrichtigung aus und erscheinen am
Ende auf dem finalen, gestempelten PDF. Das gilt für Lieferantenrechnungen,
Spesenpositionen und Kreditkartenabrechnungen gleichermassen.

Code: `src/services/kommentare.js` (Regeln), `src/routes/kommentare.js`
(`POST /kommentare/:jobId`), `views/_kommentare.ejs` (Bereich auf der Seite),
`views/_kommentar_marke.ejs` (Marke in Listen), `src/services/pdfStamp.js`
(PDF-Abschnitt). Entwurf: `docs/superpowers/specs/2026-10-25-kommentare-design.md`.

## Wer darf Kommentare sehen und schreiben

Kommentare sehen darf, wer den Vorgang selbst sehen darf, also:

- wer nach `canViewJobPdf` (`src/services/jobAuthorization.js`, siehe
  [auth-und-rechte.md](auth-und-rechte.md#job-autorisierung-pro-rechnung))
  das PDF des Vorgangs sehen darf: Superadmin; bei Status `unzugewiesen` die
  Rolle Buchhaltung; sonst die zugewiesene Person, die einreichende Person
  (Spesen), der effektive Freigeber 2 des Kontos und jeweils deren aktive
  Vertretung, oder
- wer das additive Recht `vorgaenge_einsehen` hat (Superadmin und Manager
  haben es über ihr Rollenbündel).

Niemand sonst, auch nicht über eine @Erwähnung. Schreiben darf, wer
Kommentare sehen darf **und** der Vorgang nicht abgeschlossen ist (siehe
unten). Ohne Sichtrecht antwortet `POST /kommentare/:jobId` mit 403 und
speichert nichts; die Verweigerung steht im Zugriffs-Audit unter dem Bereich
`/kommentare`.

Ein Kommentar ist 1 bis 2000 Zeichen lang, Zeilenumbrüche bleiben erhalten.

## Auf welchen Seiten

Der Bereich „Rückfragen und Kommentare“ (Anker `#kommentare`) steht auf:

| Seite | Pfad |
|---|---|
| Kontierung | `/kontierung/:id` |
| Kreditkarten-Abgleich | `/kontierung/:id/kk-abgleich` |
| Freigabe 2 | `/freigabe2/:id` |
| Überarbeitung abgelehnter Rechnungen | `/abgelehnt/:id` |
| Spesen-Freigabe 1 | `/spesen-freigabe1/:id` |
| Admin → Vorgänge (Detail) | `/admin/vorgaenge/:id` |
| Zeitstempel-Prüfung | `/zeitstempel-pruefen?jobId=<id>` |

Die Zeitstempel-Prüfung ist die Seite, auf der auch die einreichende Person
einer Spesenposition und alle anderen Beteiligten nach Abschluss lesen.
Nach dem Absenden geht es zur Ursprungsseite zurück (`zurueck`, nur diese
Pfade sind erlaubt, alles andere führt auf `/`).

Wer einen Vorgang öffnet, gilt als „gelesen“ (`kommentar_gelesen`).

## Erwähnen mit @Name

Im Text lässt sich jemand mit `@Vorname Nachname` erwähnen (Gross-/Kleinschreibung
egal). Das Auswahlfeld „Person erwähnen“ fügt den Namen ein; ohne JavaScript
tippt man ihn von Hand. Erwähnen kann man nur Personen, die den Vorgang selbst
sehen dürfen. Sonst wird nichts gespeichert, die Seite zeigt den Text zum
erneuten Absenden und eine Meldung:

- `<Name> darf diesen Vorgang nicht sehen und kann nicht erwähnt werden.`
- `Unbekannte Person: @…` (kein oder nur ein inaktiver Treffer).

Als Erwähnungsversuch zählt nur ein `@` mit zwei folgenden Wörtern in der
Form `@Wort Wort`: das erste Wort beginnt mit einem Buchstaben, das zweite
mit einem Grossbuchstaben. Passt keine Person, kommt die Meldung „Unbekannte
Person“ (z. B. `@Hans Unbekannt`). Alles andere ist gewöhnlicher Text und
blockiert nichts: `@10 Uhr`, `@CHF 20` oder ein einzelnes `@Wort`. Ein `@`
mitten in einem Wort (E-Mail-Adresse) zählt ebenfalls nicht als Erwähnung.

## Wer bekommt eine Mail, und mit welchem Link

Der Absender selbst nie. Empfänger sind, sofern sie den Vorgang sehen dürfen:

- die aktuell zuständige Person und ihre aktive Vertretung (bei einer
  Eskalation an Admin die aktiven Mitglieder der Superadmin-Gruppe),
- die Freigeber 1 und 2 des Vorgangs und des Kontos samt Vertretung,
- die einreichende Person (Spesen),
- alle, die schon kommentiert haben,
- alle Erwähnten.

Jede Mail wird je Empfänger gerendert und enthält je nach Rolle einen anderen
Link (alle mit `#kommentare`). Jeder Link führt auf eine Seite, die genau
diese Person öffnen darf:

| Empfänger | Link |
|---|---|
| aktuell verantwortlich, mit Zugang zur Arbeitsseite | `/kontierung/:id` (bei Kreditkartenabrechnung `/kontierung/:id/kk-abgleich`), `/spesen-freigabe1/:id` (nur die zugewiesene Prüfperson bzw. bei Eskalation die Admins), `/freigabe2/:id`, `/abgelehnt/:id` (nur Rechnungen) |
| verantwortlich ohne Zugang zur Arbeitsseite: Ferienvertretung bei Spesen-Freigabe 1, abgelehnte Spesenposition (sie hat keine Arbeitsseite) | `/zeitstempel-pruefen?jobId=<id>` |
| sieht über eine eigene Rolle (z. B. einreichende Person, Freigeber 2 vor seiner Phase) | `/zeitstempel-pruefen?jobId=<id>` |
| sieht nur über `vorgaenge_einsehen`, Vorgang läuft (`unzugewiesen`, `zugewiesen`, `freigabe2`, `abgelehnt`) | `/admin/vorgaenge/:id` |
| sieht nur über `vorgaenge_einsehen`, Vorgang läuft nicht mehr (z. B. `aufgesplittet`) | Superadmin: `/zeitstempel-pruefen?jobId=<id>`; sonst (Manager) kein Link, nur der Hinweis „kein Direktlink (…)“ an Stelle von `%link%` |

Pool-Vorgänge (`unzugewiesen`) haben keine verantwortliche Person; die
Buchhaltung bekommt bei Erwähnung oder als frühere Kommentierende den Link auf
die Zeitstempel-Prüfung.

Die Mailvorlage heisst `kommentar` und ist unter **Admin → Einstellungen →
Mail-Einstellungen** (`/admin/mail-einstellungen`, nur Superadmin) bearbeitbar.
Schlüssel in `admin_config`: `mail_vorlage_kommentar_betreff` und
`mail_vorlage_kommentar_text`; Variablen: `%empfaengerName%`,
`%verfasserName%`, `%kommentarText%`, `%jobId%`, `%jobDateiname%`, `%link%`,
`%portalName%`. Ist die Vorlage leer oder unbrauchbar, greift der
eingebaute Standardtext; scheitert das Rendern trotzdem, bleibt der Kommentar
gespeichert und die Mail erscheint im Mail-Protokoll als `fehlgeschlagen`.

Der Typ `kommentar` folgt der **persönlichen Wahl** der Empfängerin bzw. des
Empfängers (`/meine-benachrichtigungen`, sonst Admin-Standard): bei „täglich“
oder „wöchentlich“ geht die Mail im Digest raus, bei „sofort“ einzeln (siehe
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md#benachrichtigungen-e-mail)).
Kommentar und Mail-Einreihung werden gemeinsam gespeichert oder gemeinsam
verworfen; die Zustellung läuft danach im Hintergrund über die Mail-Warteschlange
mit Wiederholung.

## Unveränderlich, im Audit-Log

Kommentare lassen sich weder ändern noch löschen: Datenbank-Trigger
`kommentare_no_update` und `kommentare_no_delete` brechen jeden Versuch mit
`kommentare ist unveraenderlich` ab. Jeder neue Kommentar erscheint zusätzlich
im zentralen Audit-Log (Tabelle `kommentare` in `src/db/securitySchema.js`).
`kommentar_gelesen` ist bewusst nicht im Audit-Log. Die Kommentare gehören
damit zum Nachweis des Vorgangs und werden von der Aufbewahrungsbereinigung
nicht gelöscht. Auf der Seite steht der Hinweis „Kommentare können nicht
geändert werden“. Wie überall schützen lokale Trigger nicht gegen direkte
Eingriffe eines Datenbankadministrators.

## Geschlossene Status

Bei diesen Status ist der Vorgang geschlossen: `abgeschlossen`, `abgeholt`,
`archiviert`, `geloescht` (`KOMMENTAR_GESCHLOSSEN_STATUS`), dazu ein
aufgesplitteter Elternvorgang, sobald sein Gruppen-PDF erzeugt ist
(`jobs.gruppe_pdf_pfad` gesetzt, `istKommentarGeschlossen`). Dort sieht man die
Kommentare weiter, die Seite zeigt „Abgeschlossen — keine neuen Kommentare“
statt des Formulars, und ein Absenden (z. B. nach einem Statuswechsel
zwischen Laden und Absenden) wird mit einer Meldung abgelehnt; der Text bleibt
zum Kopieren stehen. Alle übrigen Status (`unzugewiesen`, `zugewiesen`,
`freigabe2`, `abgelehnt`, `aufgesplittet` vor Erzeugung des Gruppen-PDFs)
nehmen Kommentare an.

## Marke in den Listen

In den Listen steht neben dem Vorgang eine kleine Sprechblase mit der Anzahl
der Kommentare und, falls es ungelesene fremde Kommentare gibt, das Badge
„neu“. Eigene Kommentare zählen nie als neu; das Badge verschwindet, sobald
man die Detailseite öffnet. Die Marke erscheint nur bei Vorgängen, deren
Kommentare die Person auch sehen darf. Betroffene Listen: `/pool` (die
eigenen Aufgaben und die Admin-Eskalationen), `/meine-spesen`,
`/meine-abgeschlossenen`, `/admin/vorgaenge`, `/admin/abgelehnt`, jeweils in
Tabellen- und Kachelansicht. Die Pool-Liste unzugewiesener Belege und die
Rückläufer zeigen keine Marke: keine Seite, die der Pool verlinkt, zeigt
deren Kommentare (in `/admin/vorgaenge` erscheint sie weiterhin). Das
`aria-label` lautet „3 Kommentare, davon 2 neu“, ohne neue nur „3 Kommentare“.

## Auf dem finalen PDF

Bei Freigabe 2 wird nach dem Verlauf ein Abschnitt **„Rückfragen und
Kommentare“** auf die Stempelseite gedruckt: je Kommentar eine Kopfzeile
(`TT.MM.JJJJ HH:MM — Vorname Nachname:`, Zeit in Europe/Zurich) und darunter
der Text. Ohne Kommentare gibt es den Abschnitt nicht. Reicht der Platz
nicht, läuft er auf Folgeseiten weiter („… (Fortsetzung)“); eine Kopfzeile
bleibt nie allein am Seitenende. Bei Splitgruppen steht er im Gruppen-PDF je
Teil (Untertitel `Gesamtbeleg — Job-ID …` bzw. `Position n … — Job-ID …`).

Da die Stempelschrift nur den Zeichensatz Helvetica/WinAnsi kennt, wird
**jedes Zeichen ausserhalb davon** (Emoji, kyrillische oder chinesische
Schrift, Steuerzeichen) durch `?` ersetzt, ein `?` je sichtbarem Zeichen.
Das gilt für alle Freitexte auf der Stempelseite: Kommentartexte und
Verfassernamen, Namen und Kommentare der Freigaben, den Verlauf, Titel und
Verwendungszweck. Früher hätte ein solches Zeichen die Freigabe 2
blockiert. Strukturierte Felder (Kontonummer/-bezeichnung, Zahlungsdaten,
Beträge) werden nicht ersetzt; dort gilt weiterhin der Stempelfehler. Die
Kommentare im Stempel sind Teil des Freigabe-Snapshots und damit des
zeitgestempelten Nachweises.

Nach Erzeugung des Gruppen-PDFs nimmt der aufgesplittete Elternvorgang keine
Kommentare mehr an (siehe Geschlossene Status); ein Kommentar könnte das
bereits erzeugte PDF nicht mehr erreichen.

## Neuer Kommentar während Freigabe 2

Kommt zwischen dem Öffnen der Seite und dem Bestätigen der Freigabe 2 ein
neuer Kommentar dazu, hätte die freigebende Person ihn nie gesehen. Die
Seite schreibt deshalb beim Rendern den Kommentarstand
(`<Anzahl>:<letzte id>`) ins verdeckte Feld `kommentar_stand`; der POST
vergleicht ihn vor dem Stempeln mit dem aktuellen Stand (fehlt das Feld,
gilt `0:0`). Zusätzlich vergleicht die Abschluss-Transaktion den Stand beim
Stempeln mit dem beim Speichern (Kommentar während Stempeln/TSA). Weicht einer
ab, wird nichts festgeschrieben (kein Zeitstempel, keine Datei, Status bleibt
`freigabe2`) und die Seite antwortet mit **409**: „Während der
Freigabe ist ein neuer Kommentar eingegangen. Bitte lesen und erneut
freigeben.“ Der neue Kommentar ist sichtbar; die Person liest ihn und gibt
nochmals frei. Dieselbe Prüfung gilt beim Export einer Splitgruppe (Elternjob
und alle Teile); der Nachhol-Job versucht es erneut.

## Ungespeicherte Angaben bei Kontierung und Freigabe 2

Ein Kommentar ist ein eigenes Formular mit Seitenwechsel. Auf der
Kontierungsseite, im Kreditkarten-Abgleich und bei Freigabe 2 (Begründung,
Interessenskonflikt, Bestätigungen) fragt die Seite deshalb vor dem
Absenden des Kommentars per Dialog nach, wenn im Arbeitsformular bereits
etwas geändert, aber noch nicht gespeichert wurde, sonst gingen diese Angaben
verloren.

## Tabellen

- `kommentare`: `id`, `job_id` (FK `jobs`), `person_id`, `text`
  (1–2000 Zeichen), `erwaehnt` (JSON-Array von Personen-IDs), `erstellt_am`
  (ISO, UTC); Index `kommentare_job_idx`; Update-/Delete-Trigger.
- `kommentar_gelesen`: `job_id`, `person_id`, `zuletzt_am`, Primärschlüssel
  (`job_id`, `person_id`).
- `mail_log.typ` kennt zusätzlich den Wert `kommentar`.

Siehe [datenmodell.md](datenmodell.md).
