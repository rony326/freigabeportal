# Paperless-ngx: Archivvertrag und n8n-Umstellung

Stand: 2026-09-27. Die Portal-Endpunkte sind implementiert; der externe
n8n-Workflow muss vom Betreiber umgestellt und gegen dessen Paperless-Version
abgenommen werden. Es wurden keine produktiven Workflows oder Zugangsdaten veraendert.

## Vertrauensgrenze

Das Portal vertraut der Aussage des mit `N8N_API_KEY` authentifizierten
Workflows. Es kontaktiert Paperless nicht selbst. Eine Quittung ist deshalb
kein unabhaengiger Beweis der dauerhaften Archivhaltung. n8n muss den Task-Erfolg
und die aus Paperless zurueckgelesenen Originalbytes pruefen; ein blosser
Upload-HTTP-200 oder das Zuruecksenden des erwarteten Hashwerts reicht nicht aus.
Paperless-Zugriffsrechte, Backups und Aufbewahrung bleiben Betriebsverantwortung.
Der Vertrag gilt fuer eine Paperless-Instanz je Portal und eine Dokument-ID je Export.
Versionen innerhalb derselben Paperless-Dokument-ID werden derzeit nicht unterstuetzt.

## Portal-Endpunkte

Alle folgenden Requests brauchen `X-API-Key: <N8N_API_KEY>`, ueber HTTPS.
`BACKUP_API_KEY` ist hiervon getrennt. Keine Keys in URLs oder Workflow-Logs schreiben.

1. `GET /api/n8n/jobs/abholbereit` liefert wie bisher fertige Jobs und neu
   `export_nachweis_url`. Der neue Ablauf braucht keinen Legacy-Abhol-ACK.
2. `GET /api/n8n/jobs/{id}/exportnachweis` schreibt einmalig einen Exportnachweis
   fest und liefert ihn bei Wiederholung unveraendert. Felder: `version: 2`,
   `export_id` (UUID), `job_id`, `sha256` (64 kleine Hexzeichen), `erstellt_am`,
   `archiv: paperless-ngx`, `nachweis_status`, `metadaten`, `zahlung`, `positionen` und `download_pfad`,
   bei Altfaellen zusaetzlich `altfall`, `archiv_ohne_zahlung` und `unbelegte_jobdaten`.
   Bereits festgeschriebene Manifeste der Version 1 bleiben unveraendert.
   Belege ohne ausreichenden Freigabe-/Zahlungsnachweis liefern 409, solange sie
   nicht uebergeben und nicht unter Admin → Altfaelle entschieden sind.
   Die Version bezeichnet das Manifestformat. Derzeit gibt es genau einen Export je Job;
   nachtraeglich andere Bytes werden nicht still als neue Version akzeptiert.
3. `GET {download_pfad}` liefert genau die zum Nachweis gehoerenden PDF-Bytes.
   Kein Rueckfall auf die Ursprungsrechnung, wenn eine Gruppen-PDF fehlt.
   Fehlende/geaenderte Dateien liefern 409. Der SHA-256 ist auch in n8n zu pruefen.
4. Nach erfolgreicher Archivpruefung:

```http
POST /api/n8n/jobs/123/archivierung-bestaetigen
Content-Type: application/json
X-API-Key: <Credential>
```

```json
{
  "export_id": "d5a49fb7-d764-4b94-8b4b-8e5fb45e212c",
  "sha256": "<64 kleine Hexzeichen des aus Paperless geladenen Originals>",
  "dokument_id": 456,
  "task_id": "b2ba769c-455f-4d97-9fb6-986eac19a334"
}
```

`dokument_id` muss eine positive, sichere JSON-Ganzzahl sein, `task_id` eine UUID.
Antwort: 200 mit `status: archiv_bestaetigt` und der gespeicherten `quittung`.
Eine identische Wiederholung gibt dieselbe Quittung zurueck, auch nach lokaler Bereinigung.
Andere Quittungswerte, falsche Hashes, fremde Export-IDs oder eine bereits anders
zugeordnete Dokument-ID liefern 409; ungueltige Eingaben 400, fehlende Authentisierung 401.
Bei technischen Fehlern gibt es keinen erfolgreichen Teilabschluss: Abholstatus und
Quittung werden in derselben DB-Transaktion gespeichert. Die Requests loeschen keine Dateien.

## n8n-Schritte

1. Export-ID, Manifest und Prozessfortschritt dauerhaft unter der Export-ID speichern.
   Bei Wiederholung vorhandenen Fortschritt fortsetzen, nicht blind erneut hochladen.
2. PDF vom `download_pfad` laden und ihren SHA-256 mit dem Manifest vergleichen.
3. Multipart-Upload an `/api/documents/post_document/`, Datei im Feld `document`.
   Die Antwort enthaelt eine Task-UUID, noch keinen abgeschlossenen Archivnachweis.
   Task-ID dauerhaft speichern und `/api/tasks/?task_id={uuid}` bis zum Erfolg
   mit Dokument-ID abfragen. [Offizielle Paperless-API](https://github.com/paperless-ngx/paperless-ngx/blob/main/docs/api.md#posting-documents).
4. `/api/documents/{id}/download/?original=true` herunterladen, nicht die
   OCR-/Archivvariante. SHA-256 der tatsaechlichen Antwortbytes berechnen und vergleichen.
   Der Parameter ist im [Paperless-Quellcode](https://github.com/paperless-ngx/paperless-ngx/blob/main/src/documents/views.py)
   dokumentiert. Gegen das API-Schema der installierten Version pruefen.
5. Erst bei Uebereinstimmung die obige Quittung senden. Bei Timeout denselben
   Body erneut senden. Bei 409 anhalten und den Konflikt klaeren; keine Export-ID
   oder Dokument-ID automatisch austauschen.
6. Bei einem bereits vorhandenen Paperless-Dokument nicht allein auf eine
   Duplikatmeldung vertrauen: Zuordnung und Originalbytes separat pruefen.

Alle Manifest-Metadaten stammen aus dem Freigabe- bzw. Gruppen-Snapshot oder einer
Altfall-Entscheidung ([Details](export-und-zahlungsintegritaet.md)). Ein bereits
uebergebener Beleg ohne Snapshot wird als `historisch_unvollstaendig` mit
`archiv_ohne_zahlung: true` archiviert; seine aktuellen Werte stehen nur getrennt unter
`unbelegte_jobdaten`. Die Archivquittung macht daraus keinen vollstaendigen Freigabenachweis.
Bei Gruppen beschreibt der Hash die kombinierte PDF; `positionen` enthaelt
die eingefrorenen Freigabemetadaten der nicht geloeschten Teiljobs mit deren Dateihash.

## Aufbewahrung und Altfaelle

- Der alte `abholung-bestaetigen`-Endpunkt markiert nur den Transport und
  behaelt PDF und Thumbnail. Bestehende Workflows koennen weiterlaufen,
  erzeugen aber ohne Umstellung keine loeschberechtigte Archivquittung.
- `GET /api/n8n/jobs/archivierung-ausstehend` zeigt bereits abgeholte/archivierte
  Einzeljobs und abgeholte Gruppen ohne Quittung, maximal 100 Eintraege aufsteigend.
  Fortsetzung: `?nach_id={letzte_id}`. Leere Seite beendet den Durchlauf.
  Bereits lokal geloeschte Altbelege werden nicht nachtraeglich als bestaetigt erfunden;
  ihre Wiederbeschaffung und Zuordnung erfordern einen separaten Abnahmeprozess.
- Der Bereinigungsjob wartet sieben volle Tage ab Quittung. Das ist eine technische
  Mindestfrist, keine Aussage zur gesetzlichen Aufbewahrungsdauer im Zielarchiv.
  Vor dem Loeschen wird der Dateihash erneut geprueft; geaenderte Dateien bleiben liegen.
- Gruppenquittungen gelten auch fuer Teiljobs. Teil-PDFs ohne eigenen finalen Hash
  bleiben vorsorglich erhalten. Ursprungs-/verwaiste Finalisierungsdateien werden
  durch dieses Paket nicht pauschal geloescht.
- Ein ausgestellter Exportnachweis sperrt stillschweigende Zeitstempel-Nachholung
  auf derselben Einzeljob-Datei. Aenderungen der TSA-Pflicht nach Exportausstellung
  koennen einen offenen Export blockieren und muessen vor Ort geklaert werden.
- Nachweise und Quittungen sind lokal gegen UPDATE/DELETE geschuetzt und auditprotokolliert.
  Ein externer unveraenderlicher Audit-Export steht noch aus.

## Betriebsabnahme

Mit einem Testbeleg pruefen: erfolgreicher Upload und Ruecklesen, verzogener Task,
fehlgeschlagener Task, Hashabweichung, Neustart von n8n nach Upload und nach Quittung,
identischer Retry, Gruppenbeleg sowie Legacy-ACK ohne Quittung. Ohne Zugang zur
konkreten Paperless-/n8n-Instanz sind diese externen Tests hier noch nicht ausgefuehrt.
