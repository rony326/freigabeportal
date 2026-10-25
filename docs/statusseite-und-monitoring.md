# Statusseite und Monitoring

Das Portal zeigt den Zustand seiner Dienste auf einer Statusseite im Admin-Bereich
und stellt dieselben Daten als JSON für externe Überwachung (z. B. Uptime Kuma)
bereit. Entwurf: [superpowers/specs/2026-10-25-statusseite-monitoring-design.md](superpowers/specs/2026-10-25-statusseite-monitoring-design.md).

## Statusseite

`/admin/betrieb/status` (Reiter „Status“ unter Betrieb & Nutzung), Recht
`betrieb_einsehen`. Die Seite zeigt den Gesamtstatus und je Dienst eine Ampel
mit kurzer Begründung, ein Formular für die Grenzwerte und die Verwaltung des
Überwachungsschlüssels.

Statuswerte: `ok`, `warnung`, `fehler`. Der Gesamtstatus ist der schlechteste
Einzelstatus. Ein nicht eingerichteter Dienst meldet
`{ "status": "ok", "aktiv": false, "grund": "nicht eingerichtet" }`: Er soll
keinen Alarm auslösen, nur weil ein optionales Modul nicht genutzt wird.
Dasselbe gilt für `speicher`, wenn der freie Platz nicht ermittelt werden kann
(`nicht prüfbar`).

## Dienste und Grenzwerte

Schlüssel und Standardwerte stehen in `src/services/statusPruefungen.js`
(`DEFAULTS`). Auf der Statusseite änderbar sind nur die `status_*`-Grenzwerte;
`zeitstempel_warnung_ab_stunden` und `audit_zeitstempel_alarm_tage` werden unter
Admin → Zeitstempel eingestellt.

| Schlüssel | Prüft | Warnung | Fehler |
|---|---|---|---|
| `datenbank` | Abfrage `SELECT 1` | — | nicht erreichbar |
| `sicherung` | letzte erfolgreiche Datenbank-Sicherung | älter als `status_sicherung_warnung_stunden` (26 h) | älter als `status_sicherung_fehler_stunden` (50 h), noch nie erfolgreich oder letzte Sicherung fehlgeschlagen |
| `mailversand` | Mail-Warteschlange | Fehlversuche in den letzten 24 h (fest) | Mails warten länger als `status_mail_wartezeit_fehler_minuten` (60 min) |
| `churchtools` | letzter erfolgreicher Personen-Abgleich | älter als `status_churchtools_warnung_stunden` (26 h) oder letzter Lauf fehlgeschlagen | älter als `status_churchtools_fehler_stunden` (50 h) oder noch nie erfolgreich |
| `zeitstempel` | TSA-Erreichbarkeit, Sperrliste (CRL), Belege ohne Zeitstempel | Sperrliste läuft in weniger als `status_zeitstempel_crl_warnung_tage` (7 Tage) ab oder ist nicht lesbar; Belege überfällig (`zeitstempel_warnung_ab_stunden`) | Zeitstempeldienst nicht erreichbar oder Sperrliste abgelaufen |
| `audit_nachweis` | Audit-Pakete ohne Zeitstempel | Pakete ohne Zeitstempel | älter als `audit_zeitstempel_alarm_tage` (3 Tage) |
| `archivuebergabe` | abgeschlossene Belege, die noch nicht ins Archiv übergeben sind | älter als `status_archiv_warnung_stunden` (48 h) | älter als `status_archiv_fehler_tage` (7 Tage) |
| `speicher` | freier Speicherplatz der Datenbank-Partition | weniger als `status_speicher_warnung_prozent` (15 %) frei | weniger als `status_speicher_fehler_prozent` (5 %) frei |
| `jobs` | letzter Lauf jedes geplanten Jobs | mindestens ein Job zuletzt fehlgeschlagen | — |
| `sicherheitsalarme` | offene Sicherheitsalarme | — | mindestens ein offener Alarm |

`audit_nachweis` ist nur aktiv, wenn das Modul Audit-Nachweis eingeschaltet ist,
`zeitstempel` nur mit konfigurierter TSA-URL; sonst `aktiv: false`.

Die Erreichbarkeit der TSA wird höchstens alle 15 Minuten im Hintergrund
getestet; das Ergebnis liegt im Speicher. `/healthz` löst selbst keinen
TSA-Versuch aus und bleibt dadurch schnell.

Beim Speichern prüft die Seite die Grenzwerte: ganze Zahlen grösser als 0.
Warnung darf nicht über Fehler liegen (Sicherung, ChurchTools). Bei der
Archivübergabe muss Fehler-Tage × 24 mindestens der Warn-Stunden-Grenze
entsprechen. Beim Speicher darf der Fehler-Prozentwert nicht über dem
Warn-Prozentwert liegen (gleich ist erlaubt), höchstens 100.

## `GET /healthz`

Ohne Schlüssel (oder mit falschem Schlüssel) kurze Antwort:

```json
{ "status": "ok" }
```

Mit gültigem Header `X-Monitoring-Key: <schluessel>` das volle JSON:

```json
{
  "status": "warnung",
  "geprueft_am": "2026-10-25T08:00:00.000Z",
  "version": "1.0.0",
  "dienste": {
    "datenbank": { "status": "ok", "grund": "erreichbar" },
    "sicherung": { "status": "warnung", "grund": "letzter Erfolg vor mehr als 26 Stunden", "seit": "2026-10-23T02:00:00.000Z" },
    "zeitstempel": { "status": "ok", "aktiv": false, "grund": "nicht eingerichtet" }
  }
}
```

(Gekürzt; die Antwort enthält alle zehn Dienste.) Das Feld `grund` ist deutsch
und kurz und enthält keine Personen-, Rechnungs- oder Konfigurationswerte.

HTTP-Status: 200; 503 nur, wenn die Datenbank nicht erreichbar ist (ohne
Schlüssel `{"status":"fehler"}`). Eine `warnung` oder ein `fehler` eines anderen
Dienstes bleibt also 200 und wird über den JSON-Inhalt erkannt. Der Endpunkt hat
einen eigenen Limiter von 120 Anfragen pro Minute und IP.

## Überwachungsschlüssel

Konfigurationswert `monitoring_secret` (64 Hex-Zeichen). Leer = Details aus.
Auf der Statusseite lässt sich der Schlüssel erzeugen (bzw. erneuern) und
entfernen. Ein neuer Schlüssel wird **nur einmal** angezeigt; danach ist er
nicht mehr abrufbar. Der Vergleich erfolgt zeitkonstant (`timingSafeEqual`).
Im Audit-Log erscheint der Wert als `[redacted]`. Nach dem Erneuern muss der
Schlüssel in Uptime Kuma nachgetragen werden.

## Uptime Kuma einrichten

Je ein Monitor pro Dienst, den man überwachen will, plus ein Gesamt-Monitor.

1. Auf der Statusseite einen Schlüssel erzeugen und kopieren.
2. In Uptime Kuma „Add New Monitor“ wählen:
   - **Monitor Type:** `HTTP(s) - Json Query`
   - **URL:** `https://<domain>/healthz`
   - **Headers** (als JSON): `{"X-Monitoring-Key": "<schluessel>"}`
   - **Json Query:** `dienste.sicherung.status` (je Dienst der Schlüssel aus
     der Tabelle oben, z. B. `dienste.mailversand.status`)
   - **Expected Value:** `ok`
   - **Heartbeat Interval:** 60 Sekunden (empfohlen)
3. Zusätzlich einen Gesamt-Monitor mit Json Query `status` und erwartetem Wert
   `ok` anlegen.
4. Benachrichtigungen (Mail, Telegram, ...) in Uptime Kuma zuordnen.

Ein Monitor wird bei `warnung` und `fehler` rot, weil nur `ok` erwartet wird.
Dienste mit `aktiv: false` melden bewusst `ok`; so bleiben Monitore für nicht
genutzte Module grün, und bei späterer Aktivierung genügt die Konfiguration im
Portal, ohne Uptime Kuma anzupassen. Ein Monitor ohne Json Query oder ohne
Header prüft nur die Erreichbarkeit des Portals (Kurzantwort).

Die Statusseite zeigt nach dem Erzeugen des Schlüssels ein fertiges Beispiel mit
der konfigurierten Basis-URL.
