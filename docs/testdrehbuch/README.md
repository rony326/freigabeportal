# Testdrehbuch, Go-Live-Checkliste und Testbelege

Quellen für drei Dokumente zum Abnahmetest. Erzeugte Dateien (PDF, HTML, Testbelege) liegen nicht im Repo, die Skripte bauen sie jederzeit neu.

| Ordner | Inhalt |
|---|---|
| `runbook/build.py` | Testdrehbuch: Szenarien (Blöcke, Schritte, erwartetes Ergebnis). Füllt `template.html` (Vorbereitung, Belegliste, Ablauf, Aufräumen) zu `runbook.html`. |
| `runbook/golive.py` | Go-Live-Checkliste: Abschnitte und Punkte, ergibt `golive.html`. |
| `runbook/style.css` | Gemeinsamer Druckstil für beide Dokumente. |
| `runbook/print.mjs`, `print-golive.mjs` | HTML → A4-PDF mit Playwright (Fusszeile je Dokument). |
| `belege/gen.mjs` | Erzeugt alle Testbelege nach `belege/out/` (Rechnungen mit QR, Rapporte, Kreditkarte, Spesen, Sonderfälle, Budget-Dateien). |
| `belege/pruefe.mjs`, `pruefe-budget.mjs` | Prüfen die erzeugten Belege mit den Funktionen des Portals (PDF-Eingang, QR, IBAN, Kreditkarten-Abgleich, Budget-Import). |

## Neu bauen

Voraussetzung: `npm install` im Repo-Hauptordner (liefert Playwright, mupdf, pdf-lib, adm-zip).

```bash
# Testbelege
cd docs/testdrehbuch/belege
npm ci            # einmalig, installiert qrcode
npm run erzeugen
npm run pruefen   # alle Belege müssen wie im Drehbuch beschrieben reagieren

# Dokumente
cd ../runbook
python3 build.py && python3 golive.py
node print.mjs "$PWD/runbook.html" "$PWD/Test-Runbook-Freigabeportal.pdf"
node print-golive.mjs "$PWD/golive.html" "$PWD/Go-Live-Checkliste-Freigabeportal.pdf"
```

## Pflege

- Ändert sich Bedienung, Rechte oder ein Modul, Szenarien in `build.py` und die Vorbereitung in `template.html` nachführen; das Datum «Stand» in `template.html` und `golive.py` anpassen.
- Neue Testbelege in `gen.mjs` ergänzen und in die Belegliste von `template.html` eintragen.
- Die Live-Adresse gehört nicht in diese Dateien. In den Dokumenten steht nur «die Live-Adresse» bzw. `PRUEF_ZIEL_URL`.
- `X3` (15 MB) und `SQ6` (über 20 MB) sind absichtlich gross, um die Grössenlimits zu testen. Zusammen mit den übrigen Belegen gibt das mehr als 30 MB, deshalb beim Verschicken als Zip separat packen.
