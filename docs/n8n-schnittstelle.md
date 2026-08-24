# n8n-Schnittstelle

Das Portal selbst empfängt keine E-Mails und spricht kein IMAP — ein
externer n8n-Workflow übernimmt Mail-Eingang und Ablage und kommuniziert
mit dem Portal ausschliesslich über eine kleine REST-API unter
`/api/n8n/jobs` (`src/routes/n8n/jobs.js`), abgesichert per
`X-API-Key`-Header (`requireApiKey`, zeitkonstanter Vergleich gegen
`N8N_API_KEY`).

> Nativer Mail-Empfang/-Versand direkt im Portal (ohne n8n) ist als
> Design-Spec vorbereitet, aber noch nicht implementiert — n8n bleibt bis
> dahin der einzige Weg, wie Rechnungen ins Portal gelangen.

## Rechnungseingang

```mermaid
sequenceDiagram
    participant n8n
    participant P as Freigabeportal

    n8n->>P: POST /api/n8n/jobs (X-API-Key, multipart: pdf, quelle, absender, dateiname)
    P->>P: Magic-Byte-Check (%PDF), SHA-256-Hash berechnen
    alt Hash bereits bekannt (Retry/Duplikat)
        P-->>n8n: 200 { id, status, duplikat: true }
    else neue Datei
        P->>P: PDF unter JOBS_DIR speichern
        P->>P: createJob() — Zuweisungsregel prüfen, ggf. auto-zuweisen
        P->>P: Thumbnail rendern (best effort)
        P->>P: QR-Bill scannen (best effort)
        opt Job wurde auto-zugewiesen
            P->>P: Zuweisungs-Mail an Freigeber 1
        end
        P-->>n8n: 201 { id, status }
    end
```

**Vertrag** (`POST /api/n8n/jobs`, `multipart/form-data`):

| Feld | Pflicht | Beschreibung |
|---|---|---|
| `pdf` | ja | die Rechnung, max. 20 MB, muss mit `%PDF` beginnen |
| `quelle` | ja | `"scanner"` oder `"lieferant"` |
| `dateiname` | ja | Anzeigename |
| `absender` | nein | `From:`-Header der eingehenden Mail (roh, mit oder ohne Display-Name) — Basis für die automatische Zuweisungsregel |
| `eingang_am` | nein | ISO-Datum; Default: jetzt |

Antworten: `201` mit `{id, status}` bei neuer Rechnung, `200` mit
`{id, status, duplikat: true}` bei bytegleichem Wiederholungs-Upload
(SHA-256-Hash-Vergleich — macht die Schnittstelle idempotent gegenüber
n8n-Retries oder mehrfach ausgelösten IMAP-Triggern), `400` bei
Validierungsfehlern.

## Abholung fertiger Rechnungen

```mermaid
sequenceDiagram
    participant n8n
    participant P as Freigabeportal

    loop Polling
        n8n->>P: GET /api/n8n/jobs/abholbereit
        P-->>n8n: [{id, Kontierungs- & Konto-Metadaten, QR-Bill-Felder, download_url (15 Min gültig, signiert)}]
        n8n->>P: GET {download_url} (unauthentifiziert, nur Signatur)
        P-->>n8n: PDF-Stream
        n8n->>P: POST /api/n8n/jobs/:id/abholung-bestaetigen
        P->>P: Status → abgeholt, PDF + Thumbnail vom Server löschen
        P-->>n8n: 200 { id, status }
    end
```

- `GET /api/n8n/jobs/abholbereit` liefert alle Jobs mit Status
  `abgeschlossen`, deren letzter Abholversuch (`fetched_by_n8n_at`) länger
  als 15 Minuten her ist oder noch nie stattfand — jeder Abruf markiert
  sie sofort neu als "gerade abgeholt", sodass ein paralleler zweiter
  Poll-Zyklus dieselben Jobs nicht doppelt liefert.
- **Ist ein RFC3161-Zeitstempeldienst konfiguriert** (`zeitstempel_tsa_url`
  gesetzt), bleibt ein Job so lange **unsichtbar** für diese Route, bis
  sein Zeitstempel tatsächlich gesetzt ist (`zeitstempel_gesetzt_am IS NOT
  NULL`) — siehe
  [zeitstempel-und-pruefbescheinigung.md](zeitstempel-und-pruefbescheinigung.md).
  Dieselbe Bedingung gilt für `abholung-bestaetigen`.
- Antwort-Felder je Job:

  | Feld | Beschreibung |
  |---|---|
  | `id`, `eingang_am`, `quelle`, `absender`, `dateiname` | wie beim Rechnungseingang übergeben |
  | `lieferant`, `rechnungsnummer`, `betrag`, `zahlungsziel` | bei der Kontierung erfasste Rechnungsdaten |
  | `konto_id` | ID des zugeordneten Kontos, `null` falls noch keines gesetzt |
  | `konto_kontonummer`, `konto_bezeichnung` | Kontonummer und Bezeichnung des Kontos, `null` falls `konto_id` leer ist |
  | `qr_iban`, `qr_referenz`, `qr_betrag`, `qr_waehrung`, `qr_creditor_name` | aus einer erkannten Swiss-QR-Bill übernommen, sonst `null` |
  | `qr_erkannt_am` | Zeitpunkt der QR-Erkennung, `null` falls keine QR-Bill erkannt wurde |
  | `download_url` | signierte, 15 Minuten gültige Download-URL |

- Der `download_url` ist eine HMAC-signierte, 15 Minuten gültige URL auf
  `GET /downloads/:jobId` — **keine** Session nötig, siehe
  [architektur.md](architektur.md#sicherheitsmechanismen-auszug).
- `abholung-bestaetigen` ist die einzige Stelle, an der die
  Rechnungs-PDF/Thumbnail-Datei physisch vom Portal-Server gelöscht wird
  — ab hier liegt die Datei nur noch bei n8n bzw. im Zielsystem der
  Kirchgemeinde.

## Backup-Abholung

`GET /api/n8n/backup/latest` (`X-API-Key`, dieselbe Absicherung wie
`/api/n8n/jobs`) liefert das jeweils neueste, unter `BACKUP_DIR`
liegende Backup-Archiv aus (`404` falls noch keines existiert). Kein
eigener Trigger-Mechanismus — die Datei wird vom internen Scheduler
ohnehin produziert (siehe
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md)),
n8n holt sich nur ab, was bereits da ist. Ein n8n-Workflow ausserhalb
dieses Repos ist dafür verantwortlich, die Datei extern abzulegen
(WebDAV, Cloud-Speicher etc.) — eine native WebDAV-Anbindung im Portal
selbst wurde bewusst nicht gebaut, siehe
[2026-08-24-datenbank-backup-design.md](superpowers/specs/2026-08-24-datenbank-backup-design.md#nicht-teil-von-diesem-design).

**Achtung:** das Archiv enthält Geheimnisse im Klartext (u. a. das
RFC3161-TSA-Passwort) — der Workflow, der diese Route abruft, muss die
Datei entsprechend sicher handhaben.
