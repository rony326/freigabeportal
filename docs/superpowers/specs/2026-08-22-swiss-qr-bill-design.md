# Swiss-QR-Bill Auto-Erkennung & IBAN-Abgleich — Design

## Kontext

Rechnungen kommen heute ausschliesslich über `POST /n8n/jobs`
(`src/routes/n8n/jobs.js`) ins Portal. Direkt nach dem Anlegen des Jobs
wird bereits ein Thumbnail der ersten Seite gerendert
(`renderFirstPageThumbnail`, `src/services/thumbnail.js`, via `mupdf`).
Ein Mensch füllt anschliessend auf der Kontierungs-Seite
(`GET/POST /kontierung/:id`, `views/kontierung.ejs`) Betrag,
Rechnungsnummer, Zahlungsziel und Lieferant/Konto manuell aus.

Ein zweiter, unabhängig laufender Mechanismus existiert bereits für die
automatische Lieferanten-Zuordnung: `zuweisungsregeln` matched den
Absender einer E-Mail (`absender_muster`) auf einen `debitor_id` und
setzt darüber beim Ingest automatisch `debitor_id`, `konto_id`, Status
und `zugewiesen_an` (`findMatchingZuweisungsregel` /
`createJob` in `src/db/jobsRepo.js`).

Diese Spec fügt zwei neue, aber eng verwandte Fähigkeiten hinzu:

1. **Auto-Vorbelegung** aus dem Swiss-QR-Code der Rechnung (Betrag,
   Zahlungsreferenz, Kreditor-IBAN, Kreditor-Name) — reine
   Ausfüllhilfe, kein automatisches Routing.
2. **IBAN-Abgleich als Betrugserkennung**: pro Lieferant lassen sich
   eine oder mehrere erwartete IBANs manuell hinterlegen. Weicht die im
   QR-Code gefundene Kreditor-IBAN davon ab, wird gewarnt und eine
   Mail verschickt — ein klassisches Muster bei
   Rechnungsbetrug ist eine sonst unauffällige Rechnung eines bekannten
   Lieferanten mit geänderter Bankverbindung.

**Leitprinzip:** QR-Daten dürfen in Phase 1 nirgends automatisch Status,
Routing oder Freigabe beeinflussen. Sie sind entweder ein Vorschlag, den
ein Mensch bestätigt, oder ein zusätzliches Kontrollsignal obendrauf —
niemals eine neue Vertrauensquelle. Die bestehende
`zuweisungsregeln`-Logik bleibt unverändert die einzige Instanz, die
beim Ingest automatisch zuweist.

## Datenmodell

### Neue Tabelle `debitor_ibans`

Analog zu `zuweisungsregeln`: eine IBAN gehört genau einem Lieferanten
(`iban` ist global `UNIQUE`), ein Lieferant kann mehrere IBANs haben
(z. B. verschiedene Bankverbindungen/Währungskonten).

```sql
CREATE TABLE IF NOT EXISTS debitor_ibans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  debitor_id INTEGER NOT NULL REFERENCES debitoren(id),
  iban TEXT NOT NULL UNIQUE,
  quelle TEXT NOT NULL CHECK (quelle IN ('manuell', 'bestaetigt')) DEFAULT 'manuell',
  erstellt_am TEXT NOT NULL
);
```

`quelle = 'manuell'`: von einem Admin über die Lieferanten-Verwaltung
eingetragen. `quelle = 'bestaetigt'`: über das Opt-in beim Kontieren
gelernt (siehe unten). Beide Quellen verhalten sich für den Abgleich
identisch — der Unterschied ist nur eine Anzeige-Badge im Admin-UI.

Ein Versuch, eine bereits vergebene IBAN einem zweiten Lieferanten
zuzuordnen, scheitert am `UNIQUE`-Constraint und wird im Admin-UI mit
einer klaren Fehlermeldung ("Diese IBAN ist bereits Lieferant X
zugeordnet") abgefangen statt als 500er durchzureichen.

### Neue Spalten auf `jobs`

| Spalte | Typ | Bedeutung |
|---|---|---|
| `qr_iban` | `TEXT` | dekodierte Kreditor-IBAN/QR-IBAN aus dem QR-Code |
| `qr_referenz` | `TEXT` | dekodierte Zahlungsreferenz (QRR/SCOR/NON) |
| `qr_betrag` | `TEXT` | dekodierter Betrag |
| `qr_waehrung` | `TEXT` | `CHF` oder `EUR` |
| `qr_creditor_name` | `TEXT` | Name des Kreditors laut QR-Code (Anzeige-Hilfe, falls IBAN keinem Lieferanten zuordenbar ist) |
| `qr_erkannt_am` | `TEXT` | Zeitstempel des Decode-Versuchs; `NULL` = kein QR-Code gefunden oder Decode fehlgeschlagen |

`qr_referenz` bleibt bewusst getrennt von `rechnungsnummer`: Die
QR-Zahlungsreferenz ist technisch etwas anderes als die frei vom
Lieferanten vergebene Rechnungsnummer und würde die Bedeutung des
bestehenden Felds verwässern.

Bestehende Jobs vor Einführung dieses Features bekommen kein
rückwirkendes Backfill — ihre `qr_*`-Spalten bleiben `NULL`, sie
verhalten sich exakt wie heute.

### Erweiterte CHECK-Constraints

Gleiches Vorgehen wie bei der jüngsten Erweiterung von
`freigaben.rolle` (Commit `52ea82a`): `schema.sql` wird direkt
angepasst plus eine Migration für bestehende Datenbanken.

- `freigaben.rolle` erhält den neuen Wert `'iban_abweichung'`.
- `mail_log.typ` erhält den neuen Wert `'iban-warnung'`.

## Ingest-Pipeline

In `POST /n8n/jobs`, direkt neben dem bestehenden
`renderFirstPageThumbnail`-Aufruf, läuft ein neuer, ebenfalls
non-fataler Schritt:

1. `mupdf` rastert Seite 1 der PDF zu einem Pixmap.
2. `jsQR` (neue Dependency, pure JS, kein natives Binary) versucht,
   einen QR-Code im Pixmap zu finden.
3. Kein Treffer auf Seite 1 und die PDF hat mehr als eine Seite? Dann
   wird zusätzlich die letzte Seite versucht (deckt sowohl reine
   QR-Bill-PDFs als auch mehrseitige Rechnungen mit angehängtem
   Einzahlungsschein ab). Es wird **nicht** jede Seite gescannt.
4. Bei einem Treffer parst ein neuer, kleiner Parser
   (`src/services/qrBill.js`) den dekodierten Text nach der
   SPC-Spezifikation (Swiss Payment Standards) in die Felder oben.
5. Ergebnis (oder “nichts gefunden”) wird über eine neue Repo-Funktion
   `setQrDaten(db, jobId, {...})` auf dem `jobs`-Datensatz gespeichert.

Der gesamte Block steht in einem eigenen `try/catch` wie beim
Thumbnail: ein Decode- oder Parse-Fehler (kein QR, kaputtes Payload,
unerwartetes Format) blockiert die Job-Erstellung nie und wird nur als
Debug-Log vermerkt.

Die bestehende `zuweisungsregeln`-Logik in `createJob()` läuft
unverändert und unabhängig davon weiter.

## Kontierungs-UI-Flow

### Vorbelegung

Beim Öffnen von `GET /kontierung/:id`: falls `job.qr_erkannt_am`
gesetzt ist, werden Betrag und Referenz als Vorschlag ins Formular
übernommen (überschreibbar, wie die bestehende Vorbelegung aus
`job.betrag`/`job.rechnungsnummer`), zusammen mit einer kompakten
Info-Box ("Aus QR-Code erkannt: IBAN CH..., Betrag ..., Referenz ...").

### Lieferanten-Zuordnung: drei Fälle

Sobald `job.qr_iban` vorhanden ist, wird gegen `debitor_ibans`
nachgeschlagen:

1. **Kein Absender-Match, aber QR-IBAN kennt einen Lieferanten** → das
   Lieferanten-Dropdown wird zusätzlich vorbelegt, obwohl die
   Absender-Regel nichts fand. Reiner Zugewinn.
2. **Absender-Regel und QR-IBAN zeigen auf denselben Lieferanten** →
   kein Konflikt.
3. **Absender-Regel und QR-IBAN zeigen auf unterschiedliche
   Lieferanten** → wird nicht stillschweigend überschrieben. Die
   Kontierungs-Maske zeigt einen Hinweis ("QR-Code deutet auf
   Lieferant X hin, aktuell zugewiesen: Lieferant Y — bitte prüfen"),
   der Mensch entscheidet, welcher Lieferant gewählt wird.

### IBAN-Abgleich bei Absenden (Betrugserkennung)

Beim Absenden von `POST /kontierung/:id`: sobald ein Lieferant feststeht
(egal ob per Absender-Regel oder manuell gewählt) UND für ihn
mindestens eine IBAN in `debitor_ibans` hinterlegt ist UND
`job.qr_iban` vorhanden ist, wird verglichen.

- **Match** (QR-IBAN ist unter den hinterlegten IBANs des Lieferanten):
  stiller Erfolg, höchstens ein grüner Hinweis "IBAN stimmt mit
  hinterlegten Daten überein". Keine Mail.
- **Mismatch**: die Kontierung wird trotzdem normal abgeschlossen
  (nicht blockierend), aber:
  1. Sichtbare Warnung in der Kontierungs-Maske.
  2. Mail (`typ = 'iban-warnung'`) an: die aktuell angemeldete Person,
     die die Kontierung gerade absendet (nicht zwingend
     `job.zugewiesen_an`, falls jemand anderes einspringt) + die
     Freigeber1/Freigeber2 des betroffenen Kontos (direkt aus `konten`
     aufgelöst) **plus** eine zusätzliche, admin-konfigurierbare
     Empfängerliste über den neuen `admin_config`-Key
     `iban_abweichung_empfaenger` — gleiches Zeilenformat wie
     `sync_fehler_empfaenger`/`reminder_empfaenger`
     (E-Mail-Adressen oder `gruppe:admin`/`gruppe:buchhaltung`,
     aufgelöst über das bestehende `resolveEmpfaenger()` aus
     `src/services/notify.js`).
  3. Ein neuer `freigaben`-Eintrag mit `rolle = 'iban_abweichung'`,
     `person_id` = die kontierende Person, `ip` = ihre IP, `kommentar`
     = "QR-IBAN CH.. weicht von hinterlegter IBAN CH.. ab (Lieferant
     X)". Dieser Eintrag erscheint automatisch in der bestehenden
     Audit-Log-Timeline (`src/services/auditLog.js` /
     `views/_audit_log.ejs`, `EREIGNIS_LABEL` bekommt den neuen Key
     `iban_abweichung: 'IBAN-Abweichung festgestellt'`) — ohne dass
     dort etwas Neues gebaut werden muss.

**Hat der Lieferant noch keine hinterlegte IBAN**, ist kein Abgleich
möglich — hier greift stattdessen:

### Opt-in "IBAN merken"

Wenn `job.qr_iban` vorhanden ist und diese IBAN noch **keiner**
`debitor_ibans`-Zeile zugeordnet ist (weder dem gewählten noch einem
anderen Lieferanten), zeigt das Kontierungsformular eine vorangehakte
Checkbox "IBAN CH... künftig automatisch [Lieferant] zuordnen". Wird
sie beim Absenden nicht abgewählt, entsteht eine neue
`debitor_ibans`-Zeile mit `quelle = 'bestaetigt'`.

Ist die IBAN bereits **einem anderen** Lieferanten zugeordnet, wird die
Checkbox nicht angeboten (kein stilles Überschreiben) — das ist dann
entweder ein echter Mismatch-Fall (siehe oben, falls der aktuell
gewählte Lieferant selbst schon IBANs hat) oder eine Korrektur, die
bewusst über das Admin-UI erfolgen muss.

## Admin-UI

- `src/routes/admin/debitoren.js` + zugehörige View: pro Lieferant eine
  IBAN-Liste (hinzufügen/löschen) analog zur bestehenden
  Absender-Muster-Verwaltung, mit Badge `manuell`/`bestätigt`. Neues
  Repo `src/db/debitorIbanRepo.js` analog zu
  `src/db/zuweisungsregelnRepo.js`.
- Neues Empfänger-Feld `iban_abweichung_empfaenger` auf der bestehenden
  Einstellungen-Seite, auf der auch `reminder_empfaenger`/
  `eskalation_empfaenger` verwaltet werden
  (`src/routes/admin/eskalation.js` + zugehörige View).

## Fehlerfälle & Sicherheit

- Kein QR-Code lesbar / Decode oder Parsing schlägt fehl →
  `qr_erkannt_am` bleibt `NULL`, Job verhält sich exakt wie heute,
  kein Fehler sichtbar für den Menschen.
- Es wird nur Seite 1 und ggf. die letzte Seite gescannt — kein
  Performance-Risiko bei langen PDFs.
- Kein Backfill für Bestandsjobs.
- QR-Daten steuern in Phase 1 nirgends automatisch Status, Routing
  oder Freigabe — sie sind entweder ein bestätigungspflichtiger
  Vorschlag (Betrag/Referenz/Lieferant) oder ein zusätzliches
  Kontrollsignal (IBAN-Abgleich), das eher Betrugsversuche aufdeckt
  als neues, ungeprüftes Vertrauen ins System bringt. Eine gefälschte
  oder manipulierte PDF kann also höchstens dazu führen, dass ein
  falscher Vorschlag angezeigt wird — nie, dass automatisch Geld
  freigegeben oder ein falscher Lieferant automatisch zugewiesen wird.

## Testing

- Unit-Tests für den SPC-Parser (`src/services/qrBill.js`): gültige
  QRR-Referenz, gültige SCOR-Referenz, gültige NON-Referenz,
  kaputtes/unerwartetes Payload.
- Unit-Tests für `debitorIbanRepo` (inkl. `UNIQUE`-Konflikt) und für
  die Match/Mismatch-Vergleichslogik.
- Integrationstests für den Ingest-Pfad (`POST /n8n/jobs` befüllt die
  `qr_*`-Spalten korrekt bzw. lässt sie `NULL` bei fehlendem
  QR-Code).
- Integrationstests für `GET/POST /kontierung/:id`: Vorbelegung,
  Mismatch löst Mail + Audit-Log-Eintrag aus, Match bleibt still,
  Opt-in-Checkbox legt eine `debitor_ibans`-Zeile mit
  `quelle = 'bestaetigt'` an.
- Integrationstests für die Admin-IBAN-Verwaltung (CRUD,
  `UNIQUE`-Fehlermeldung).
- Für PDF-Fixtures mit echtem Swiss-QR-Code wird zur Testzeit ein
  Generator gebraucht (z. B. das npm-Paket `swissqrbill` nur als
  Dev-Dependency, nicht als Laufzeit-Dependency) — Implementierungsdetail
  für den Umsetzungsplan, kein Architekturentscheid.

## Out of Scope (Phase 1)

- Automatisches Routing/Auto-Zuweisung allein durch QR-IBAN-Treffer
  (bewusst auf Vorbelegung/Kontrollsignal beschränkt).
- Scannen aller Seiten einer PDF nach einem QR-Code.
- Rückwirkendes Backfill für Bestandsjobs.
- Blockierende Bestätigung bei IBAN-Abweichung (nur Warnung + Mail +
  Audit-Log, siehe oben).
- Robusterer Decoder (zxing) für schlecht gescannte Post — Umstieg nur
  bei Bedarf, der Decode-Schritt ist dafür bewusst gekapselt.
