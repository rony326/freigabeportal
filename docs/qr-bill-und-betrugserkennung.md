# Swiss-QR-Bill-Erkennung und IBAN-Abgleich

Zwei zusammenhängende, aber unabhängige Mechanismen: automatisches
Auslesen der Zahlungsdaten aus einem Swiss-QR-Bill-Code (Komfort) und ein
Abgleich der darin enthaltenen Zahlungsempfänger-IBAN gegen die für den
gewählten Lieferanten hinterlegten IBANs (Betrugserkennung — z. B. gegen
gefälschte Rechnungen mit manipulierter Kontoverbindung).

## Erkennung beim Rechnungseingang

```mermaid
flowchart TD
    A["PDF-Upload via n8n<br/>(POST /api/n8n/jobs)"] --> B["scanQrBill(pdfBuffer)<br/>src/services/qrBillScan.js"]
    B --> C["Seite 1 als Bild rendern<br/>(mupdf, bis zu 1200px breit,<br/>gedeckelt auf 8 Megapixel)"]
    C --> D{"QR-Code<br/>gefunden? (jsQR)"}
    D -- nein --> E{"mehrseitiges PDF?"}
    E -- ja --> F["letzte Seite versuchen"]
    F --> D
    E -- nein --> G["kein QR-Code<br/>— keine Vorbefüllung"]
    D -- ja --> H["parseQrBillPayload()<br/>Swiss-QR-Bill-Zeilenformat (SPC)"]
    H --> I["IBAN, Betrag, Währung,<br/>Referenz, Zahlungsempfänger-Name<br/>am Job gespeichert (qr_*-Spalten)"]
```

Der Parser erwartet exakt das SIX/SPC-Zeilenformat (Header `"SPC"`,
mindestens 31 Zeilen); IBAN wird normalisiert (Leerzeichen entfernt,
Grossbuchstaben) — reale QR-Bill-Generatoren fügen teils
Gruppierungs-Leerzeichen ein, die sonst zu falschen
IBAN-Mismatch-Meldungen führen würden.

## Vorbefüllung und Abgleich bei der Kontierung

Auf der Kontierungs-Seite werden die gescannten QR-Daten als
Formular-Vorschlag angezeigt (Betrag, ggf. vorgeschlagener Lieferant
anhand der IBAN). Erst beim tatsächlichen **Speichern** der Kontierung
(mit einem gewählten Lieferanten) läuft der eigentliche
Sicherheits-Abgleich:

```mermaid
flowchart TD
    A["Kontierung wird gespeichert,<br/>QR-IBAN vorhanden, Lieferant gewählt"] --> B{"Lieferant hat<br/>hinterlegte IBAN(s)?"}
    B -- nein --> C{"'IBAN merken'-Checkbox<br/>angehakt UND IBAN gültig?"}
    C -- ja --> D["IBAN wird als 'bestaetigt'<br/>für diesen Lieferanten übernommen"]
    C -- nein --> E["kein Abgleich möglich —<br/>keine Warnung"]
    B -- ja --> F{"QR-IBAN in der<br/>Liste der hinterlegten IBANs?"}
    F -- ja --> G["Match — keine Aktion"]
    F -- nein --> H["MISMATCH:<br/>freigaben-Eintrag 'iban_abweichung'<br/>+ Warn-Mail an Freigeber 1+2,<br/>konfigurierte Empfänger, den Bearbeiter selbst"]
```

Die Warn-Mail blockiert die Kontierung **nicht** — sie ist ein Hinweis,
kein Stopp: die Person kann die Rechnung trotzdem freigeben, aber
Freigeber 1, Freigeber 2 und ggf. weitere konfigurierte Empfänger
(**Admin → Eskalationszeiten**, Feld "IBAN-Abweichungs-Empfänger") werden
zusätzlich informiert und können gezielt nachfragen.

## Bekannte Lücke: Aufsplitten umgeht den Abgleich

Der oben beschriebene IBAN-Abgleich läuft **ausschliesslich** im normalen
Kontierungs-Formular (`POST /kontierung/:id`). Die Aufsplitten-Route
(`POST /kontierung/:id/aufsplitten`, siehe
[rechnungs-workflow.md](rechnungs-workflow.md#5-aufsplitten-status-zugewiesen--aufgesplittet))
ruft `pruefeIbanAbgleich` nicht auf — eine über Aufsplitten kontierte
Teilrechnung wird aktuell nie gegen die hinterlegte Lieferanten-IBAN
geprüft, selbst wenn der ursprüngliche Job einen QR-Code mit abweichender
IBAN enthielt. Dies ist eine bekannte, noch offene Lücke im
Betrugserkennungs-Konzept.

## Verwaltung der hinterlegten IBANs

**Admin → Debitoren** (Recht `debitoren_verwalten`) verwaltet pro
Lieferant beliebig viele IBANs (`debitor_ibans`, eindeutig über die
gesamte Tabelle — eine IBAN kann nur einem Lieferanten zugeordnet sein).
Validierung einer Schweizer IBAN: `^CH\d{2}[0-9A-Z]{17}$`
(`src/services/ibanUtils.js`) — dieselbe Prüfung wird an allen drei
Stellen verwendet (QR-Parser, Admin-Formular, "IBAN merken"), damit keine
der drei aus der Reihe fällt und dadurch falsche Warnungen erzeugt.
