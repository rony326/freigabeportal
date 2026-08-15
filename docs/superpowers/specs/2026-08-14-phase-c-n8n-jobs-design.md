# Freigabeportal — Phase C: n8n-Schnittstelle & Job-Datenmodell

Status: approved (Phase C only)
Datum: 2026-08-14

## Kontext

Phase A (Fundament & Auth) und Phase B (Admin-Bereich) sind abgeschlossen und auf `master`
gemerged. Phase B liefert unter anderem die Konten-Verwaltung (vier Freigabe-Rollen pro Konto)
und Zuweisungsregeln (Absender/Domain → Konto), deren tatsächliche Matching-Logik explizit auf
Phase C verschoben wurde.

Phase C liefert das Job-Datenmodell und die Schnittstelle zum bestehenden internen n8n:
Job-Erstellung per API-Key-authentifiziertem Upload, automatische Zuweisung anhand der
Zuweisungsregeln, einen Pool mit atomarem Beanspruchen, kurzlebige signierte Download-Links und
das zweiphasige Abholen (inkl. aktiver Löschung nach Bestätigung).

**Bewusste Geltungsgrenze**: Phase C ist reine Daten-/API-Schicht, **keine Browser-UI**. Die
Pool-Ansicht mit Thumbnails, die Kontierung, die Freigabe2-Split-View, PDF-Stempelung und der
tatsächliche Mailversand (Zuweisungs-/Reminder-/Eskalations-Mails) folgen komplett in Phase D.
Phase C legt lediglich die JSON-Endpunkte und das Datenmodell an, auf denen Phase D aufbaut.

### Phasenplan (Kontext, aus Phase A übernommen)

- Phase A – Fundament & Auth (abgeschlossen, gemerged)
- Phase B – Admin-Bereich (abgeschlossen, gemerged)
- **Phase C – n8n-Schnittstelle & Job-Datenmodell (dieses Dokument)**
- Phase D – Freigabe-Workflow-UI (Pool-UI, Kontierung, Freigabe2, PDF-Stempelung,
  Reminder-/Eskalations-Mails, tatsächlicher Mailversand)
- Phase E – Härtung & Deployment (inkl. Rate-Limiting)

## Architektur & Geltungsbereich

- Drei Endpunkt-Gruppen mit unterschiedlichem, sauber getrenntem Auth-Mechanismus (wie in Phase A
  etabliert — nie vermischt):
  1. **n8n-Endpunkte** (`X-API-Key`-Header, bestehendes `requireApiKey` aus Phase A):
     Job-Erstellung, zweiphasiges Abholen.
  2. **Mensch-Endpunkt** (ChurchTools-Session, `requireRole(config, 'buchhaltung')` aus Phase A):
     atomares Beanspruchen aus dem Pool — reiner JSON-Endpoint (kein gerendertes HTML), den
     Phase D später von einer echten Pool-Seite aus per Fetch aufruft.
  3. **Signierte Download-Route**: kein Session-/API-Key-Auth, dafür HMAC-Signatur + Ablaufzeit
     direkt in der URL. Wird sowohl von n8n (Abholen) als auch später von Phase D's
     Freigabe-UI genutzt.
- Datei-Upload analog Phase B: `multer` (Memory-Storage), Magic-Bytes-Prüfung auf den echten
  PDF-Header (`%PDF`, erste 4 Bytes), nicht nur der vom Client behauptete Content-Type. Max.
  20 MB. Speicherort konfigurierbar über `config.jobsDir` (Default `./data/jobs`, analog zu
  `brandingDir` aus Phase B).
- Neues Signing-Secret `config.downloadSigningSecret` (env-basiert, wie `sessionSecret` etc.) für
  die HMAC-Signatur der Download-Links — komplett getrennt von `n8nApiKey`/`cronSecret`.

## Datenmodell

```sql
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eingang_am TEXT NOT NULL,
  quelle TEXT NOT NULL CHECK (quelle IN ('scanner', 'lieferant')),
  absender TEXT,
  dateiname TEXT NOT NULL,
  pdf_pfad TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'unzugewiesen','zugewiesen','kontiert','freigabe1','freigabe2',
    'abgeschlossen','abgeholt','archiviert','abgelehnt'
  )) DEFAULT 'unzugewiesen',
  konto_id INTEGER REFERENCES konten(id),
  zugewiesen_an TEXT REFERENCES personen(churchtools_person_id),
  abgelehnt_von TEXT REFERENCES personen(churchtools_person_id),
  ablehnungsgrund TEXT,
  fetched_by_n8n_at TEXT
);

CREATE TABLE freigaben (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2')),
  zeitpunkt TEXT NOT NULL,
  ip TEXT NOT NULL,
  interessenskonflikt INTEGER NOT NULL DEFAULT 0,
  kommentar TEXT,
  eskaliert_von TEXT REFERENCES personen(churchtools_person_id)
);
```

Anmerkungen:

- `zugewiesen_an` ist im ursprünglichen Lastenheft nicht wörtlich benannt, aber notwendig: bei
  Auto-Zuweisung per Zuweisungsregel wird es auf `konto.freigeber1_id` gesetzt; beim manuellen
  Beanspruchen aus dem Pool auf die beanspruchende Person. Ohne dieses Feld liesse sich nicht
  unterscheiden, wessen persönliche Warteschlange ein Job gerade ist.
- `freigaben` ist eine eigene Tabelle statt eines JSON-Blobs im Job (das Lastenheft nennt es eine
  "Liste") — sauberer abfragbar für spätere Auswertungen. Phase C legt nur die Tabelle an; befüllt
  wird sie erst in Phase D (Kontierung/Freigabe-Schritte existieren dort noch nicht).
- Alle neun Status-Werte aus dem Lastenheft sind bereits im `CHECK`-Constraint definiert, auch
  die, die Phase C selbst nie setzt (`kontiert`, `freigabe1`, `freigabe2`, `archiviert` — das sind
  Phase D/spätere Schritte) — vermeidet eine spätere Schema-Migration nur für neue Enum-Werte.
  Phase C setzt ausschliesslich: `unzugewiesen`, `zugewiesen` (bei Erstellung/Beanspruchen),
  `abgeschlossen` (nur in Tests direkt gesetzt, um das Abholen zu testen — kein Code-Pfad in
  Phase C erreicht diesen Status organisch, das folgt erst mit Phase D's Freigabe-Workflow), und
  `abgeholt` (beim Bestätigen).

## Zuweisungsregel-Matching (bei Job-Erstellung)

Aus Phase B explizit auf Phase C verschoben: `absender_muster` (Phase B, Tabelle
`zuweisungsregeln`) ist entweder eine volle E-Mail-Adresse oder eine Domain. Matching-Reihenfolge,
case-insensitiv:

1. **Exakte E-Mail-Adresse**: `absender_muster` entspricht `absender` wörtlich.
2. **Domain-Endung**: der Domain-Teil von `absender` (nach `@`) ist entweder identisch mit
   `absender_muster`, oder endet auf `"." + absender_muster` — `lieferant.ch` matcht damit sowohl
   `rechnungen@lieferant.ch` als auch `rechnungen@sub.lieferant.ch`, aber nicht
   `rechnungen@notlieferant.ch`. Ein `absender_muster`, das ein `@` enthält, wird ausschliesslich
   für die exakte Adress-Prüfung (Regel 1) herangezogen, nie für die Domain-Prüfung.

Der erste Treffer in dieser Reihenfolge gewinnt (exakte Adresse vor Domain). Bei Treffer werden
`konto_id` und `zugewiesen_an = konto.freigeber1_id` sofort gesetzt, Status → `zugewiesen`. Ohne
Treffer bleibt der Status `unzugewiesen`, der Job landet im Pool.

## Endpunkte

### n8n (API-Key, `requireApiKey`)

- **`POST /api/n8n/jobs`** — Multipart-Body: PDF-Datei (Feld `pdf`) + `quelle`
  (`scanner`|`lieferant`), `absender` (optional, E-Mail-Adresse), `dateiname`, optional
  `eingang_am` (Default: aktueller Zeitpunkt UTC). Legt den Job an, wendet das
  Zuweisungsregel-Matching an, liefert `{ id, status }`. Ungültiger PDF-Header oder >20 MB → 400,
  kein Job wird angelegt.
- **`GET /api/n8n/jobs/abholbereit`** — listet Jobs mit `status = 'abgeschlossen'` und (kein
  aktiver Claim ODER Claim älter als 15 Minuten). Nebenwirkung (Phase 1 des zweiphasigen
  Abholens): setzt `fetched_by_n8n_at = jetzt` für jeden zurückgegebenen Job, atomar pro Zeile
  (`UPDATE ... WHERE status='abgeschlossen' AND (fetched_by_n8n_at IS NULL OR fetched_by_n8n_at <
  ?)`). Antwort enthält je Job Metadaten plus eine signierte Download-URL (15 Minuten gültig,
  passend zur Claim-Frist).
- **`POST /api/n8n/jobs/:id/abholung-bestaetigen`** — Phase 2. Nur erfolgreich, wenn der Job noch
  `status = 'abgeschlossen'` ist (unabhängig davon, ob der Claim inzwischen "abgelaufen" wäre —
  ein verspätetes, aber letztlich erfolgreiches Bestätigen eines eigentlich schon
  timeout-freigegebenen Claims wird noch akzeptiert, solange kein anderer n8n-Lauf den Job
  zwischenzeitlich bereits erfolgreich bestätigt hat). Setzt `status = 'abgeholt'`, löscht die
  PDF-Datei von der Platte. `pdf_pfad` bleibt als historischer Pfad-String in der DB stehen
  (Audit-Spur), die Datei selbst existiert danach nicht mehr, ein erneuter Download ist nicht
  mehr möglich. Job bereits `abgeholt` oder nie `abgeschlossen` gewesen → 409.

### Mensch (ChurchTools-Session, `requireRole(config, 'buchhaltung')`)

- **`POST /api/pool/:id/beanspruchen`** — atomare Operation:
  `UPDATE jobs SET status='zugewiesen', zugewiesen_an=? WHERE id=? AND status='unzugewiesen'`. 0
  betroffene Zeilen → 409 (schon von jemand anderem beansprucht, oder der Job ist gar nicht mehr
  im Pool). Erfolgreich → 200 mit dem aktualisierten Job.
- **`GET /api/pool`** — listet offene (`status='unzugewiesen'`) Jobs als JSON. Basis für Phase D's
  Pool-Seite; liefert in Phase C noch keine Thumbnails (die entstehen erst in Phase D).

### Signierte Downloads (kein Session-/API-Key-Header, Signatur in der URL selbst)

- **`GET /downloads/:jobId?expires=<unix-timestamp>&signature=<hex>`** — `signature` ist
  HMAC-SHA256 über den String `${jobId}.${expires}` mit `config.downloadSigningSecret` als Key,
  hex-kodiert. Serverseitige Prüfung: Signatur muss exakt übereinstimmen (konstante Zeit-Vergleich
  über `crypto.timingSafeEqual`) UND `expires` darf nicht in der Vergangenheit liegen. Bei
  Ungültigkeit (falsche Signatur ODER abgelaufen) → 403 mit generischer deutscher Meldung, die
  nicht verrät, welcher der beiden Gründe zutrifft (verhindert Signatur-Orakel). Erfolgreich →
  liefert die PDF-Datei mit `Content-Type: application/pdf`.
- Eine kleine Hilfsfunktion `buildSignedDownloadUrl(config, jobId, gueltigkeitsSekunden)` erzeugt
  diese URLs; wird von `GET /api/n8n/jobs/abholbereit` verwendet und ist so gebaut, dass Phase D's
  Freigabe-UI sie später ebenfalls direkt wiederverwenden kann.

## Fehlerbehandlung

- Ungültiger/fehlender API-Key → 401 (bestehendes Verhalten aus Phase A, unverändert).
- PDF-Upload mit falschem Magic-Bytes-Header (kein echtes PDF) oder über 20 MB → 400, deutsche
  Fehlermeldung im JSON-Body, kein Job wird angelegt, keine Datei bleibt auf der Platte zurück.
- Beanspruchen-Konflikt (Race Condition zwischen zwei gleichzeitigen Klicks) → 409, nie ein 500.
- Abholung-Bestätigen auf einen nicht (mehr) passenden Job (falscher Status) → 409; n8n muss das
  als "beim nächsten Poll erneut abholen" interpretieren, nicht als Fehler eskalieren.
- Signierte URL abgelaufen oder manipuliert → 403, generische Meldung (siehe oben).
- Referenzierte `konto_id` durch ein Zuweisungsregel-Match, die inzwischen nicht mehr existiert
  (Race Condition: Konto wurde zwischen Regel-Anlage und Job-Erstellung gelöscht/deaktiviert —
  kann laut Phase B nicht durch Löschung passieren, aber durch Deaktivierung) → Matching wird bei
  deaktivierten Konten übersprungen (nur aktive Konten sind matchbar), Job landet stattdessen im
  Pool statt einen Fehler zu werfen.

## Tests

Wie in Phase A/B: echte HTTP-Requests via `supertest`, echte In-Memory-SQLite-DB, echte
PDF-Bytes (Magic-Bytes-Fixture, z.B. `%PDF-1.4` + minimaler gültiger Rumpf) für Uploads, keine
Mocks der eigenen Business-Logik. Schwerpunkte:

- Zuweisungsregel-Matching: exakte E-Mail-Treffer, Domain-Treffer (inkl. Subdomain-Fall wie
  `sub.lieferant.ch` gegen Muster `lieferant.ch`, und der Negativfall `notlieferant.ch`, der trotz
  gemeinsamer Endung NICHT matchen darf), exakte Adresse gewinnt vor Domain wenn beide passen
  würden, kein Treffer → Pool, deaktiviertes Konto wird übersprungen.
- Job-Erstellung: gültiger PDF-Upload legt Job mit korrekten Feldern an; ungültiger Header oder
  Übergrösse wird abgelehnt, keine Datei bleibt zurück.
- Atomares Beanspruchen: zwei simulierte gleichzeitige Beanspruchen-Versuche auf denselben Job —
  genau einer gewinnt (200), der andere bekommt 409.
- Zweiphasiges Abholen: `abholbereit` markiert Claim korrekt und liefert eine gültige signierte
  URL; ein Claim jünger als 15 Minuten wird bei einem zweiten `abholbereit`-Aufruf nicht erneut
  zurückgegeben; ein Claim älter als 15 Minuten wird erneut angeboten; `abholung-bestaetigen`
  setzt `abgeholt` und löscht die Datei; ein zweiter Bestätigen-Versuch auf denselben Job → 409.
- Signierte Downloads: gültige Signatur + nicht abgelaufen → 200 mit PDF-Bytes; abgelaufen → 403;
  manipulierte Signatur → 403; beide Fehlerfälle liefern identische, nicht unterscheidbare
  Fehlermeldungen.
- Zugriffsschutz: `/api/n8n/*` ohne/mit falschem API-Key → 401; `/api/pool/*` ohne
  Buchhaltung-Gruppenzugehörigkeit → 401/403, exakt wie in Phase B etabliert (jede
  Route-Methode-Kombination einzeln getestet, keine Stichprobe).

## Nicht Teil von Phase C

Pool-UI mit Thumbnail-Rendering, Kontierung, Freigabe2-Split-View, PDF-Stempelung/Flattening,
Ablehnung/Rückweg-Workflow, tatsächlicher Versand von Zuweisungs-/Reminder-/Eskalations-Mails
(nur das Datenmodell und die API-Endpunkte, auf denen das aufbaut, entstehen hier) — all das ist
Phase D. Rate-Limiting auf den neuen öffentlichen Endpunkten (`/api/n8n/*`, `/downloads/*`) ist
Phase E.
