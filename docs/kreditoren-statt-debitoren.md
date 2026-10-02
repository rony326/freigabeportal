# Fachliche Korrektur: Kreditoren statt Debitoren

Stand: 2026-09-29. Separates Aenderungspaket. Keine Aenderung an Zahlungsfreigaben,
Betraegen, Kontierung, Kontonummern oder Buchungslogik.

## Befund

Rechnungssteller eingehender Rechnungen (Eingangsrechnungen) sind Kreditoren. Das Portal
fuehrte sie als "Debitoren": Tabellen `debitoren` und `debitor_ibans`, Spalten
`jobs.debitor_id`, `zuweisungsregeln.debitor_id`, `debitor_ibans.debitor_id`, das Recht
`debitoren_verwalten`, die Admin-Seite `/admin/debitoren`, Formularfelder `debitorId` und der
Mail-Platzhalter `%debitorName%`.

Alle Vorkommen in `src/`, `views/` und `test/` wurden einzeln geprueft. Sie bezeichnen
ausnahmslos Lieferanten/Rechnungssteller bzw. beim Kreditkartenabgleich den Kartenherausgeber
(ebenfalls Glaeubiger). Ein tatsaechlicher Debitorenfall (Forderung gegen Dritte) existiert im
implementierten Code nicht. Die Raumvermietungs-Spezifikation unter `docs/superpowers/` beschreibt
kuenftige Ausgangsrechnungen an Mieter; dort sind Debitoren fachlich korrekt, das Dokument bleibt
unveraendert. Historische Specs und datierte Audit-Berichte werden nicht umgeschrieben.

Abgrenzung: `kreditoren.id` ist eine interne ID, keine Kreditorennummer der Buchhaltung (ein
solches Feld existiert nicht und wurde nicht erfunden). `kreditoren.konto_id` ist das
Standard-Konto aus `konten` (Kontonummer/Bezeichnung mit Freigabeverantwortlichen); eine
Kostenstelle wird nicht separat gefuehrt. Diese Bedeutungen sind unveraendert.

## Neue Bezeichnungen

| Bisher | Jetzt |
| --- | --- |
| Tabelle `debitoren`, `debitor_ibans` | `kreditoren`, `kreditor_ibans` |
| Spalte `debitor_id` (jobs, zuweisungsregeln, IBANs) | `kreditor_id` |
| Recht `debitoren_verwalten` | `kreditoren_verwalten` |
| `/admin/debitoren` | `/admin/kreditoren` |
| Formularfeld `debitorId` | `kreditorId` |
| Mail-Platzhalter `%debitorName%` | `%kreditorName%` |
| Repos `debitorenRepo`, `debitorIbanRepo` | `kreditorenRepo`, `kreditorIbanRepo` |

## Migration (`src/db/kreditorenMigration.js`)

- Laeuft beim Oeffnen der Datenbank vor `schema.sql`, in einer `BEGIN IMMEDIATE`-Transaktion.
- Reine Umbenennung (`ALTER TABLE ... RENAME`, `RENAME COLUMN`): keine Zeilenkopie, IDs und
  Fremdschluessel bleiben erhalten; SQLite passt Fremdschluessel-Verweise mit an.
- Fingerprint aller Zuordnungen (Kreditor-Stammdaten, IBAN->Kreditor, Regel->Kreditor,
  Job->Kreditor) vor und nach der Umbenennung; bei Abweichung Rollback und Startabbruch.
- Alte Audit-Trigger `audit_debitoren_*`/`audit_debitor_ibans_*` werden entfernt;
  `migrateSecuritySchema` legt sie unter den neuen Namen neu an (keine Doppelereignisse).
- Ein Audit-Ereignis `schema_migration/umbenannt` dokumentiert Umfang und Fingerprint.
- Das Recht wird beim Neuaufbau von `person_berechtigungen` abgebildet (nicht verworfen) und
  als `person_berechtigungen/recht_umbenannt` mit den betroffenen Personen-IDs protokolliert.
- Wiederholbar: bereits migrierte Objekte werden uebersprungen, ein zweiter Start aendert nichts.
- Existieren alter und neuer Name gleichzeitig (z.B. nach einem Downgrade, bei dem alter Code
  leere `debitoren`-Tabellen neu angelegt hat), bricht der Start ab, ohne Daten zu veraendern.

## Historische Daten und Integritaet

Nicht umgeschrieben werden: Audit-Ereignisse (vorher/nachher enthalten weiterhin `debitor_id`
bzw. Objekt `debitoren`), Freigabe-Snapshots (`jobs.freigabe_snapshot`), Exportnachweise und
deren Hashes. Lesen erfolgt ueber `src/services/kreditorFelder.js`:

- `kreditorIdAusDatensatz` liest `kreditor_id` oder das alte `debitor_id` und lehnt
  widerspruechliche Werte ab.
- Die Audit-Ansicht zeigt fuer alte Objektnamen den Hinweis "historisch: debitoren".

Neue Snapshots enthalten `kreditor_id`. Snapshot- und Formular-Fingerprints aendern sich dadurch
fuer vor dem Deployment geoeffnete Formulare: Betroffene erhalten die bestehende
"Vorgang wurde geaendert"-Meldung und muessen die Seite neu laden. Es entsteht keine
Freigabe mit veralteten Daten.

## Kompatibilitaet und Uebergang

- `/admin/debitoren...` leitet weiter (GET/HEAD 301, sonst 308 mit erhaltenem Body). Die
  Weiterleitung gewaehrt nichts; Anmeldung, Rechte und CSRF werden am Ziel geprueft.
- Formularfelder: `kreditorId` ist massgeblich; `debitorId` wird uebergangsweise in Kontierung,
  Kreditkartenabgleich und Kreditoren-Verwaltung akzeptiert. Beide gleichzeitig mit
  unterschiedlichen Werten ergeben HTTP 400 ohne Aenderung.
- Mail-Vorlagen: `%kreditorName%` und `%debitorName%` werden mit demselben Wert befuellt.
  Gespeicherte, angepasste Vorlagen bleiben unveraendert und funktionieren weiter.
- Das Recht `debitoren_verwalten` wird nach der Migration nicht mehr gespeichert (DB-CHECK).
  Ein vor dem Deployment geladenes Personen-Formular, das den alten Namen sendet, wird auf
  `kreditoren_verwalten` abgebildet, damit das Recht nicht still entzogen wird.
- Uebergangsende: Der Alias `debitorId`/`%debitorName%` und die Weiterleitung koennen entfernt
  werden, sobald keine alten Formulare/Vorlagen mehr im Umlauf sind (Vorschlag: naechstes
  Release nach Pruefung der Mail-Vorlagen).

## n8n und externe Schnittstellen

Die n8n-Vertraege (`/api/n8n/jobs`, Export-/Archivmanifest, Backup) enthalten kein Debitor- oder
Kreditor-Feld; der Rechnungssteller wird dort als `lieferant` (Name) uebertragen. Eine Aenderung
des n8n-Workflows ist **nicht erforderlich**. Bereits ausgelieferte Exportmanifeste behalten ihr
Format und ihre Hashes.

## Deployment-Schritte

1. Vor dem Deployment ein verschluesseltes Backup erstellen und dessen SHA-256 notieren
   (Admin -> Datenbank-Backup oder geplanter Lauf); `npm run backup:verify` pruefen.
2. Deployment in einem ruhigen Zeitfenster (offene Kontierungs-/Freigabeformulare muessen danach
   neu geladen werden).
3. Anwendung starten. Im Log darf kein Fehler "Kreditoren-Migration" erscheinen. Im Audit-Log
   pruefen: je ein Ereignis `schema_migration/umbenannt` und ggf. `recht_umbenannt`.
4. Stichprobe: Admin -> Kreditoren zeigt alle bisherigen Eintraege, Regeln und IBANs; eine
   bekannte Rechnung zeigt denselben Lieferanten; Personen mit bisherigem Recht sehen die Seite.
5. Angepasste Mail-Vorlagen optional auf `%kreditorName%` umstellen (nicht zwingend).
6. Rueckweg: Alter Code laeuft nicht auf der migrierten Datenbank (er wuerde leere
   `debitoren`-Tabellen anlegen; der naechste Start des neuen Codes bricht dann bewusst ab).
   Ein Rollback erfolgt deshalb nur ueber den Offline-Restore des Backups aus Schritt 1
   (`npm run backup:restore`), unter Verlust der seitherigen Aenderungen. Keine manuelle
   Rueckbenennung.

## Tests

- `test/unit/kreditorenMigration.test.js`: Bestands-DB mit alten Namen, Migration, Neustart,
  Erhalt aller Zuordnungen, unveraenderte Jobzeile (ausser Spaltenname), byte-identische
  Snapshots/Exportnachweise/Audit-Historie, Rechte-Abbildung, keine Doppel-Audit-Ereignisse,
  Abbruch bei gleichzeitig alten und neuen Tabellen, Adapter.
- `test/integration/admin/kreditorenKompatibilitaet.test.js`: Anlage/Anzeige unter
  "Kreditoren", Weiterleitung alter Pfade ohne Rechteumgehung, alte Formularfelder,
  Ablehnung widerspruechlicher Werte, neues Recht.
- `test/integration/kontierung.test.js`: altes Feld `debitorId` und Konfliktfall bei der
  Kontierung ohne Aenderung an Job/Freigaben.
- `test/unit/db.test.js`: bestehender Legacy-Test (Tabelle `debitoren`, Spalte `debitor_id`,
  Jobs-Neuaufbau) laeuft ueber die neue Migration.
