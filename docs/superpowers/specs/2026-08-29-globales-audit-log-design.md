# Globales durchsuchbares Audit-Log — Design

## Kontext

`buildAuditLog(db, jobId)` (`src/services/auditLog.js`) ist heute das
einzige "Audit-Log"-Konzept im Portal, aber strikt auf einen einzelnen Job
beschränkt: es mappt `freigaben`-Zeilen (Freigabe 1/2, Ablehnung,
Eskalation, IBAN-Abweichung) eines Jobs auf Anzeige-Einträge, gerendert via
`views/_audit_log.ejs` auf den Job-Detailseiten. Es gibt keine
job-übergreifende Admin-Ansicht — ein Admin muss Jobs einzeln öffnen, um
ihre Historie zu sehen, ohne jede Such-/Filtermöglichkeit.

`job_loeschungen` (Lösch-Audit für das Soft-Delete abgelehnter Rechnungen,
`src/routes/admin/abgelehnt.js`) hat einen funktionierenden Repo
(`listJobLoeschungen`, `src/db/jobLoeschungenRepo.js`), wird aber von
keiner einzigen Route aufgerufen — die einzige bereits in aggregierbarer,
job-unabhängiger Form gespeicherte Audit-Datenquelle hat schlicht keine
UI.

Ziel dieses Designs: eine neue Admin-Seite `/admin/audit-log`, die
`freigaben` (über alle Jobs) und `job_loeschungen` zu einer gemeinsamen,
durchsuchbaren, paginierten Liste zusammenführt.

## Datenquellen & Normalisierung

Zwei Quelltabellen, zu einer gemeinsamen Zeilenform normalisiert:

| Feld | aus `freigaben` | aus `job_loeschungen` |
|---|---|---|
| `zeitpunkt` | `freigaben.zeitpunkt` | `job_loeschungen.zeitpunkt` |
| `quelle` | `'freigabe'` (Literal) | `'loeschung'` (Literal) |
| `ereignisTyp` | `freigaben.rolle` | `'loeschung'` (Literal) |
| `personId` | `freigaben.person_id` | `job_loeschungen.geloescht_von` |
| `jobId` | `freigaben.job_id` | `job_loeschungen.job_id` |
| `dateiname` | `jobs.dateiname` (Join) | `job_loeschungen.dateiname` |
| `kontoBezeichnung` | `konten.bezeichnung` (Join über `jobs.konto_id`) | `konten.bezeichnung` (Join über `jobs.konto_id`) |
| `kommentar` | `freigaben.kommentar` | `job_loeschungen.begruendung` |
| `jobStatus` | `jobs.status` | `jobs.status` |

`job_loeschungen.job_id` ist bewusst kein FK (siehe Kommentar in
`schema.sql`), aber `loeschenJob` (`src/db/jobsRepo.js:361`) ist ein
Soft-Delete (`status = 'geloescht'`) — die `jobs`-Zeile existiert also
praktisch immer noch. Der Join auf `jobs`/`konten` erfolgt für beide Seiten
der UNION als `LEFT JOIN`, damit ein hypothetischer fehlender Job (z. B.
manueller DB-Eingriff) die Zeile nicht aus dem Ergebnis verschwinden lässt,
sondern nur mit leeren Job-Kontext-Feldern erscheint.

`ereignisTyp`-Labels erweitern die bestehende `EREIGNIS_LABEL`-Map in
`src/services/auditLog.js` (dort schon exportiert) um `loeschung: 'Job gelöscht'`
— eine Map, ein Ort für alle Ereignis-Label im System.

## Service (`src/services/globalAuditLog.js`, neu)

```javascript
export function queryGlobalAuditLog(db, { personId, kontoId, von, bis, ereignisTyp, suchbegriff } = {}, { seite = 1, proSeite = 50 } = {}) {
  // baut eine SQL UNION ALL-Query aus den zwei normalisierten SELECTs
  // (siehe Tabelle oben), wendet dieselben WHERE-Filter auf beide
  // UNION-Seiten an, sortiert nach zeitpunkt DESC, paginiert per
  // LIMIT/OFFSET. Gibt { eintraege, gesamtAnzahl, seite, proSeite } zurück.
}
```

Filter-Semantik:

- `personId` — exakter Treffer auf die normalisierte `personId`-Spalte
  (handelnde Person: `freigaben.person_id` bzw. `job_loeschungen.geloescht_von`).
- `kontoId` — exakter Treffer auf `jobs.konto_id`.
- `von`/`bis` — ISO-Datumsgrenzen auf `zeitpunkt` (inklusiv).
- `ereignisTyp` — exakter Treffer auf die normalisierte `ereignisTyp`-Spalte
  (also `freigeber1`, `freigeber2`, `ablehnung`, `freigabe1_eskalation`,
  `freigabe2_eskalation`, `iban_abweichung`, oder `loeschung`).
- `suchbegriff` — `LIKE '%...%'` (case-insensitive über SQLite `LIKE`s
  Standardverhalten für ASCII) über `kommentar` (normalisiert, s.o.) UND
  `dateiname`, als OR verknüpft.

Alle Filter sind optional und additiv (AND-verknüpft untereinander). Die
Query wird komplett in SQL gebaut (kein Laden aller Zeilen nach JS) — das
ist der entscheidende Unterschied zum bestehenden `buildAuditLog`, das für
eine einzelne, garantiert kleine Zeilenmenge gebaut wurde und für eine
globale, wachsende Tabelle nicht geeignet wäre. Pro Seite: 50 Einträge,
serverseitig hart begrenzt (kein `proSeite`-Parameter vom Client
übernommen).

`personName`/`formatZeitpunkt`-Hilfsfunktionen aus `src/services/auditLog.js`
werden dort exportiert und von `globalAuditLog.js` wiederverwendet (keine
Duplikation der Zeitzonen-/Namens-Logik).

## Berechtigung

Neues additiv vergebbares Recht `audit_log_einsehen`, analog zu
`mails_einsehen`/`sync_einsehen`:

- `src/middleware/permissions.js`: Eintrag in `GRANTABLE_BERECHTIGUNGEN`
  und `BERECHTIGUNG_LABELS` (`'Globales Audit-Log einsehen'`). Dadurch
  erscheint das Recht automatisch im bestehenden Checkbox-Formular auf
  `/admin/personen` (`GRANTABLE_BERECHTIGUNGEN`/`BERECHTIGUNG_LABELS`
  werden dort bereits generisch iteriert, keine Änderung an
  `personen.js`/`personen-liste.ejs` nötig).
- Migration in `src/db/index.js`: SQLite kann `CHECK`-Constraints nicht per
  `ALTER TABLE` erweitern (siehe `migrateFreigabenTable` als Vorbild). Eine
  neue `migratePersonBerechtigungenTable(db)` baut `person_berechtigungen`
  nach demselben Rename→Create→Copy→Drop-Muster neu auf, mit `'audit_log_einsehen'`
  zusätzlich in der `CHECK (berechtigung IN (...))`-Liste. Wird in
  `openDatabase` neben den bestehenden Migrationsaufrufen registriert.
- `src/middleware/nav.js`: neuer `adminNav.auditLog: hasPermission('audit_log_einsehen')`.
- `src/app.js`: `app.use('/admin/audit-log', requirePermission(db, config, 'audit_log_einsehen'), createAuditLogRouter({ db }))`.
- `views/admin/_nav.ejs`: neuer `<li>` hinter `abgelehnt`, gewickelt in
  `<% if (adminNav.auditLog) { %>`.

Superadmin/Manager haben automatisch Zugriff (bestehendes Verhalten von
`personHasPermission`), zusätzlich einzeln vergebbar.

## Route (`src/routes/admin/auditLog.js`, neu)

```javascript
router.get('/', (req, res) => {
  const filter = {
    personId: req.query.person || null,
    kontoId: req.query.konto ? Number(req.query.konto) : null,
    von: req.query.von || null,
    bis: req.query.bis || null,
    ereignisTyp: req.query.typ || null,
    suchbegriff: req.query.q || null,
  };
  const seite = Math.max(1, Number(req.query.seite) || 1);
  const { eintraege, gesamtAnzahl, proSeite } = queryGlobalAuditLog(db, filter, { seite });
  res.render('admin/audit-log', {
    eintraege, gesamtAnzahl, seite, proSeite,
    filter,
    personen: listAllPersons(db), // für Dropdown — auch inaktive, für Historie
    konten: listKonten(db, { includeInactive: true }), // für Dropdown — auch inaktive, für Historie
    ereignisLabels: EREIGNIS_LABEL,   // inkl. 'loeschung'
  });
});
```

Filterformular ist ein GET-Formular (Query-Params) — Ergebnis-URLs bleiben
teilbar/lesezeichenfähig, konsistent mit dem restlichen Admin-Bereich
(kein bestehendes Muster für POST-basierte Filter im Portal).

## View (`views/admin/audit-log.ejs`, neu)

Folgt dem bestehenden Admin-Listen-Look (Bootstrap-Tabelle,
`admin/_nav.ejs`-Include). Aufbau:

1. Filterformular (Person-Dropdown, Konto-Dropdown, Von/Bis-Datumsfelder,
   Ereignis-Typ-Dropdown inkl. "Alle", Freitext-Suchfeld, "Filtern"-Button)
   — aktuelle Filterwerte aus `filter` vorbelegt.
2. Tabelle: Zeitpunkt, Ereignis (Label aus `ereignisLabels`), Person,
   Job (Dateiname + Job-ID als reiner Text — kein Link, da je nach
   Status/Löschzustand unterschiedliche Detailseiten zuständig wären und
   das für eine reine Audit-Übersicht nicht nötig ist), Konto,
   Kommentar/Begründung.
3. Seiten-Navigation (Zurück/Weiter, Seite X von Y, berechnet aus
   `gesamtAnzahl`/`proSeite`) — alle Links tragen die aktuellen
   Filter-Query-Params weiter.
4. Leerer Zustand: Hinweistext, falls `eintraege.length === 0`.

## Tests

- **Unit** (`globalAuditLog.test.js`, neu): `queryGlobalAuditLog` gegen
  eine Test-DB mit gemischten `freigaben`- und `job_loeschungen`-Zeilen
  über mehrere Jobs — ungefiltert liefert beide Quellen zeitlich sortiert;
  jeder Filter einzeln (Person, Konto, Zeitraum, Ereignis-Typ, Freitext)
  grenzt korrekt ein; kombinierte Filter sind AND-verknüpft; Pagination
  (`gesamtAnzahl` korrekt, zweite Seite liefert die nächsten 50, letzte
  Seite liefert Rest ohne Fehler bei leerem Ergebnis).
- **Unit**: Migration `migratePersonBerechtigungenTable` — ein Insert mit
  `'audit_log_einsehen'` schlägt vor der Migration fehl (CHECK) und
  gelingt danach; bestehende Zeilen bleiben nach der Migration erhalten.
- **Integration** (`auditLog.test.js`, neu): `GET /admin/audit-log`
  liefert 401 ohne Login, 403 für eine Person ohne das Recht, 200 für
  Superadmin/Manager und für eine Person mit ausschliesslich
  `audit_log_einsehen`. Ein gesetzter Filter (z. B. `?typ=loeschung`)
  reduziert die angezeigten Zeilen entsprechend.

## Nicht Teil von diesem Design

- **Kein CSV-Export.** Kann bei Bedarf später ergänzt werden (YAGNI) —
  aktuell reicht die durchsuchbare/filterbare Ansicht im Portal.
- **Keine weiteren Datenquellen.** `mail_log`, `sync_log`, `cron_log`,
  `backup_wiederherstellungen` sind andere Konzepte (Zustellung,
  Sync-Läufe, geplante Jobs, DB-Wiederherstellung) und bleiben auf ihren
  bestehenden, eigenen Admin-Seiten — dieses Design fasst ausschliesslich
  den Freigabe-/Lösch-Audit-Trail zusammen.
- **Keine Änderung an `buildAuditLog`/`_audit_log.ejs`.** Die bestehende
  Pro-Job-Ansicht auf den Job-Detailseiten bleibt unverändert bestehen,
  unabhängig von der neuen globalen Ansicht.
