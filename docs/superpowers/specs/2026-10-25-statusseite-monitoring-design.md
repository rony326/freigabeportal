# Statusseite und Monitoring-Endpunkt — Design

Stand: 2026-10-25. Status: Entwurf, zur Freigabe.
Teil 1 des Backlogs vor dem Launch (Statusseite → Ersteinrichtung → Testmodus → Kommentare →
Benachrichtigungen → Responsive-Durchgang).

## Absicht und Warum

Das Portal ist noch nicht produktiv. Sobald es läuft, soll kein Hintergrunddienst (Sicherung,
Mails, ChurchTools-Abgleich, Zeitstempel, Archivübergabe …) wochenlang unbemerkt ausfallen. Der
Betreiber überwacht mit **Uptime Kuma** und will dort **jeden Dienst einzeln** per JSON prüfen.
Im Portal selbst soll eine Statusseite dieselben Ampeln zeigen.

## Ziele

1. **Statusseite** `Admin → Betrieb & Nutzung → Status` mit einer Ampel pro Dienst (ok / Warnung
   / Fehler), Grund, Zeitpunkt der letzten Prüfung und Link zur passenden Admin-Seite.
2. **Monitoring-Endpunkt** für Uptime Kuma:
   - `GET /health` ohne Schlüssel: nur `{"status":"ok"}` (200) bzw. 503, wenn die Datenbank nicht
     antwortet. Keine Details.
   - `GET /health` mit gültigem Schlüssel im Header `X-Monitoring-Key`: zusätzlich Gesamtstatus
     und ein Feld pro Dienst (Format unten).
3. **Grenzwerte** pro Dienst mit Standardwerten, auf der Statusseite einstellbar.

## Nicht-Ziele

- Keine eigenen Benachrichtigungen aus dem Portal (Alarmierung macht Uptime Kuma; bestehende
  Sicherheitsalarme bleiben unverändert).
- Kein Verlauf/Diagramm der Status (Uptime Kuma hat ihn).
- Keine Prometheus-Metriken.

## Anti-Ziele

- Der Endpunkt verrät ohne Schlüssel irgendetwas über Konfiguration oder Zustand ausser
  "läuft / läuft nicht".
- Personen- oder Rechnungsdaten erscheinen im JSON.
- Eine einzelne langsame Prüfung (z. B. TSA-Erreichbarkeit) macht den Endpunkt langsam oder lässt
  Uptime Kuma in einen Timeout laufen.

## Vom Nutzer entschieden

1. Uptime Kuma überwacht **die Dienste einzeln über JSON**.
2. Dienste und Grenzwerte wie folgt (Standardwerte, einstellbar):

| Schlüssel | Dienst | Warnung | Fehler |
|---|---|---|---|
| `datenbank` | Datenbank | – | antwortet nicht (Endpunkt 503) |
| `sicherung` | Datenbank-Sicherung | letzte erfolgreiche > 26 h | > 50 h oder letzter Lauf fehlgeschlagen |
| `mailversand` | Mailversand | Fehlversuche in den letzten 24 h | eine Mail wartet > 1 h |
| `churchtools` | ChurchTools-Abgleich | letzter Erfolg > 26 h | > 50 h |
| `zeitstempel` | Zeitstempel (TSA) | Sperrliste läuft in < 7 Tagen ab, Nachholen hängt | Sperrliste abgelaufen oder TSA nicht erreichbar |
| `audit_nachweis` | Audit-Nachweis | Paket ohne Zeitstempel | älter als die Alarmschwelle |
| `archivuebergabe` | Übergabe an n8n/Paperless | Beleg seit 48 h nicht abgeholt | seit 7 Tagen nicht abgeholt |
| `speicher` | Speicherplatz | < 15 % frei | < 5 % frei |
| `jobs` | Geplante Jobs | letzter Lauf eines Jobs fehlgeschlagen | – |
| `sicherheitsalarme` | Sicherheitsalarme | – | offener Alarm |

3. JSON enthält einen **Gesamtstatus** (schlechtester Dienst), pro Dienst Grund und
   Prüfzeitpunkt, **keine** Personen- oder Rechnungsdaten.
4. Schlüssel als Header in Uptime Kuma; Statusseite für das Recht **"Betrieb & Nutzung"**
   (`betrieb_einsehen`).

## Entscheidungen des Entwurfs (meine Calls)

1. **JSON-Format** (stabil, Uptime-Kuma-tauglich):
   ```json
   {
     "status": "warnung",
     "geprueft_am": "2026-10-25T08:00:00.000Z",
     "version": "<package.json version>",
     "dienste": {
       "sicherung": { "status": "ok", "grund": "Letzte Sicherung vor 3 h", "seit": "2026-10-25T05:00:00.000Z" },
       "mailversand": { "status": "warnung", "grund": "2 Fehlversuche in 24 h", "seit": "…" }
     }
   }
   ```
   Status-Werte genau `ok`, `warnung`, `fehler`; ein nicht konfigurierter Dienst (z. B. TSA nicht
   eingerichtet, Modul aus) meldet `ok` mit Grund "nicht eingerichtet" und Feld
   `"aktiv": false`, damit Uptime Kuma nicht dauernd rot ist. Uptime-Kuma-Beispiel in der Doku:
   JSON Query `dienste.sicherung.status`, erwarteter Wert `ok`.
2. **HTTP-Status** des Endpunkts mit Schlüssel: 200 solange die Datenbank antwortet (auch bei
   Warnung/Fehler einzelner Dienste — sonst würden alle Kuma-Monitore gleichzeitig rot); 503 nur
   bei Datenbankfehler. Ohne/mit falschem Schlüssel: Kurzantwort wie ohne Schlüssel (kein 401,
   damit der Endpunkt nicht als Schlüssel-Orakel dient).
3. **Schlüssel**: Config `monitoring_secret` (zufällig, 32 Byte hex), auf der Statusseite
   erzeugbar/erneuerbar und einmalig sichtbar; Vergleich in konstanter Zeit; leer = Details aus.
   Erneuern wird im Audit-Log festgehalten (Wert geschwärzt).
4. **Langsame Prüfungen**: TSA-Erreichbarkeit wird nicht bei jedem Aufruf geprüft, sondern höchstens
   alle 15 Minuten mit einem eigenen Versuch (Ergebnis zwischengespeichert); alle anderen Prüfungen
   lesen nur Datenbank und Dateisystem. Antwortzeit-Ziel < 500 ms.
5. **Datenquellen** (bestehend): `cron_log` (Sicherung, Jobs), `sync_log` (ChurchTools),
   `mail_log` (Warteschlange, Fehlversuche), TSA-Sperrlistendatei und `audit_export_zeitstempel`,
   `jobs` mit Status `abgeschlossen` ohne Abholung (Archivübergabe), `sicherheitsalarme`,
   `fs.statfs` auf dem Datenverzeichnis (Speicher).
6. **Rate-Limit**: `/health` mit dem bestehenden `publicLimiter`, aber so konfiguriert, dass ein
   Abfrageintervall von 20 s pro Dienst-Monitor (10 Monitore) nicht blockiert wird — eigener
   Limiter z. B. 120 Anfragen pro Minute pro IP.
7. **Grenzwerte** als `admin_config`-Schlüssel `status_<dienst>_<warnung|fehler>_…` mit den
   Standardwerten oben; Statusseite hat ein Formular dafür (Superadmin oder `betrieb_einsehen`).

## Einschränkungen

- Bestehende Bausteine: Recht `betrieb_einsehen`, Admin-Bereich `/admin/betrieb`, Scheduler,
  Audit-Trigger auf `admin_config` (Schlüssel-Werte über das bestehende `*secret*`/`*token*`-
  Schwärzen — Schlüsselname so wählen, dass er geschwärzt wird, z. B. `monitoring_secret`).
- Infomaniak-Hosting: kein Root, `fs.statfs` muss auf dem Datenverzeichnis funktionieren
  (Fallback "unbekannt" = ok mit Grund).

## Dem Builder überlassen

- Struktur der Prüf-Funktionen (eine pro Dienst, gemeinsames Ergebnisformat).
- Layout der Statusseite im Shell-Layout (responsive).
- Tests: jeder Dienst ok/warnung/fehler an den Grenzwerten, Endpunkt ohne/mit/falschem Schlüssel,
  keine Personendaten im JSON, Datenbankfehler → 503, TSA-Zwischenspeicher, Rate-Limit.
- Doku inkl. Uptime-Kuma-Anleitung (Monitor-Typ, Header, JSON Query je Dienst).
