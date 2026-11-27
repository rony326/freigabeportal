# Aufsplitten als Assistent neben dem Beleg

Datum: 2026-11-27 · Status: zur Freigabe

## Absicht

Beim Aufsplitten ist die Rechnung nicht sichtbar (Popup ohne PDF), Beträge und Positionen lassen sich so schlecht
abschreiben. Das Aufsplitten läuft künftig als Assistent auf der Kontierungsseite, mit dem Beleg daneben. Neu gibt es
ein Feld für Versandkosten, die gleichmässig auf die Teile verteilt werden.

## Ziele

- Der Beleg bleibt während des ganzen Aufsplittens sichtbar.
- Geführter Ablauf in drei Schritten, mit laufender Restbetrags-Anzeige.
- Versandkosten nicht mehr von Hand umrechnen.

## Nicht-Ziele

- Keine Änderung an Rechten, Konfliktbehandlung, IBAN-Prüfung, Prüf-Popup, Mails, Splitgruppen-Export.
- Keine Zwischenspeicherung auf dem Server, kein eigener Seitenaufruf je Schritt.
- Versandkosten werden nicht anteilig zum Betrag verteilt.
- Kein neues Datenbankfeld, keine Migration, keine Änderung an n8n-Schnittstellen.

## Ansätze

1. **Assistent im Browser, ein Absenden am Ende (gewählt).** Schritte wechseln ohne Neuladen, der Server prüft am
   Schluss. Das PDF bleibt ruhig stehen, wenig Server-Umbau.
2. Jeder Schritt ein Seitenaufruf mit Zwischenstand in der Sitzung. Verworfen: PDF lädt jedes Mal neu, Datei-Uploads
   je Zeile müssten zwischengespeichert werden, deutlich mehr Code.

Vorher entschieden: geführte Schritte (B) statt einer einzigen Formularfläche neben dem PDF (A).

## Ablauf

«Weitere Aktionen → Rechnung aufsplitten» ersetzt rechts das Kontierungsformular durch den Assistenten, links bleibt
der Beleg. Unter 992 px gilt der bestehende Umschalter Beleg/Formular. Das Popup entfällt. «Abbrechen» zeigt wieder
das Kontierungsformular mit dessen unveränderten Eingaben.

| Schritt | Inhalt | «Weiter» erst, wenn |
|---|---|---|
| 1 Rechnung | Typ, Lieferant, Gesamtbetrag, Versandkosten, ggf. Rechnungsnummer/Zahlungsziel (KI-Haken), ggf. IBAN-Kasten | Pflichtfelder gültig, KI-Haken gesetzt, Versandkosten kleiner als Gesamtbetrag |
| 2 Teile | je Teil Konto, Teilbetrag **ohne Versand**, Position, Konflikt, Beleg; Zeilen untereinander (schmale Spalte). Anzeige «Verteilt X von Y – offen Z», wobei Y = Gesamtbetrag − Versandkosten | mindestens 2 Teile, jeder mit Konto und Betrag, offen = 0.00; Begründung, falls Konflikt |
| 3 Prüfen | je Teil Konto, Teilbetrag, Versandanteil, Total; Summe = Gesamtbetrag | Knopf «Aufsplitten» |

«Zurück» ist in Schritt 2 und 3 immer möglich, Eingaben bleiben erhalten. Werte aus dem Kontierungsformular (Typ,
Betrag, Lieferant, Rechnungsnummer, Zahlungsziel, KI-Haken) werden beim Öffnen übernommen, wie heute.

## Versandkosten

- Feld «Versandkosten», freiwillig, leer = 0, gleiches Zahlenformat wie die Beträge.
- Gesamtbetrag = Summe der Teilbeträge + Versandkosten.
- Anteil je Teil = Versandkosten ÷ Anzahl Teile, in Rappen abgerundet; der Rest geht an den letzten Teil.
- Der gespeicherte Betrag eines Teils ist Teilbetrag + Anteil.
- Ist der Anteil grösser als 0, wird die Position ergänzt: «Pos. 2 (inkl. Versand 3.35)», ohne eigene Position
  «inkl. Versand 3.35».
- Gerechnet und geprüft wird verbindlich auf dem Server; der Browser zeigt nur eine Vorschau.
- Gilt für Rechnung und Gutschrift gleich.

## Fehler

Lehnt der Server ab (Fehler, Prüf-Popup, PDF-Störung), kommt die Kontierungsseite mit offenem Assistenten zurück: beim
ersten Schritt mit Fehler, beim Prüf-Popup in Schritt 3, mit allen Eingaben. Dateien müssen wie heute neu gewählt
werden. Es wird dann nichts angelegt.

## Meine Festlegungen (bitte prüfen)

- Die eigenständige Seite `/kontierung/:id/aufsplitten` entfällt; der GET leitet auf die Kontierung mit offenem
  Assistenten.
- Kommt als weiterer Punkt in die noch nicht committete Version 1.4.13.
- Anwender-Anleitung (Text) und `docs/rechnungs-workflow.md` werden nachgeführt.

## Dem Umsetzer überlassen

Aufbau der Views und des Skripts. Zu beachten: Beide Formulare liegen auf derselben Seite (doppelte IDs wie `betrag`,
`kreditorId`, `begruendung`, und die bestehenden `kontierung-*.js` dürfen sich nicht gegenseitig treffen), CSP mit
Nonce, CSRF, Touch-Ziele und Responsive-Seitenliste.
