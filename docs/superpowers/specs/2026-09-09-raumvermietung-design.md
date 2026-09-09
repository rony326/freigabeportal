# Raumvermietung — Design

Datum: 2026-09-09
Status: Zur Review

## Ziel

Heute werden Rechnungen für Raumvermietungen manuell in Word erstellt;
alle Eckdaten einer Vermietung (Räume, Stuhlung, Technik) werden separat
in Excel geführt und von dort von Hand in die Rechnung übertragen. Dieses
Feature bildet den kompletten Ablauf einer Raumvermietung — von der
telefonisch/per Mail eingehenden Anfrage über Kundendaten-Erfassung,
Checklisten/Aufgaben bis zur fertigen Rechnung — als eigenes,
workflow-gestütztes Modul im Portal ab, damit die manuelle
Excel→Word-Übertragung entfällt.

## Nicht-Ziele (bewusst ausgeklammert)

- **Kein öffentliches Anfrageformular.** Anfragen kommen ausschliesslich
  telefonisch/per Mail rein und werden von Staff im Portal erfasst.
- **Keine zweite Freigabe/Vier-Augen-Prinzip** für Mietrechnungen — die
  zuständige Person erstellt und versendet direkt.
- **Kein Bexio-Export** für Mietrechnungen — die Buchhaltung erfasst
  diese Erträge separat/manuell. Kann später als eigenes Feature
  nachgezogen werden.
- **Keine Zahlungsverfolgung** (bezahlt/offen) — Zahlungseingang wird
  ausserhalb des Portals verfolgt.
- **Keine eigene Raumverwaltung** — Räume kommen live aus ChurchTools,
  das dort die Quelle der Wahrheit für die eigentliche Buchung bleibt.
  Das Portal legt keine Buchungen in ChurchTools an (rein lesender
  Zugriff).
- **Kein eigener Preis-Katalog für Technik-/Stuhlungs-Zuschläge** — nur
  für Räume wurde eine strukturierte, admin-pflegbare Preisliste
  gewünscht; Technik/Stuhlung werden als freie, manuell erfasste
  Rechnungspositionen abgebildet.

## Status-Workflow

```
anfrage → bestaetigt → durchgefuehrt → rechnung_erstellt → rechnung_versendet
   \            \
    \            → storniert
     → storniert
```

`storniert` ist aus `anfrage` oder `bestaetigt` erreichbar (Abbruch vor
Durchführung); danach nicht mehr vorgesehen.

## Datenmodell

Alle Tabellen folgen dem bestehenden Muster: SQLite, kein ORM, ein Repo
pro Tabelle unter `src/db/`.

### `vermietungen`

Eine Zeile pro Mietanfrage/-vorgang.

| Spalte | Typ | Bemerkung |
|---|---|---|
| `id` | int PK | |
| `status` | text | CHECK: `anfrage`, `bestaetigt`, `durchgefuehrt`, `rechnung_erstellt`, `rechnung_versendet`, `storniert` |
| `kunde_name` | text | |
| `kunde_firma` | text NULL | |
| `kunde_adresse` | text NULL | |
| `kunde_telefon` | text NULL | |
| `kunde_email` | text NULL | |
| `kundentyp` | text | CHECK: `intern`, `extern` — gilt für die ganze Anfrage, bestimmt welcher Raum-Preis (Abschnitt Preisliste) angewendet wird |
| `zugewiesen_an` | text FK `personen` NULL | verantwortliche Person, NULL = offener Team-Pool |
| `erfasst_von` | text FK `personen` | wer die Anfrage angelegt hat |
| `erfasst_am` | text | |
| `rechnungsnummer` | text NULL | fortlaufend, admin-konfigurierbares Präfix |
| `rechnung_pdf_pfad` | text NULL | |
| `rechnung_betrag` | text NULL | Summen-Cache für Anzeige/Liste |
| `rechnung_versandart` | text NULL | CHECK: `mail`, `download` |
| `rechnung_versendet_am` | text NULL | |
| `storniert_am` | text NULL | |
| `storno_grund` | text NULL | |

Kein eigenes Zeitfenster auf dieser Ebene — siehe `vermietung_raeume`.
Für Dashboard/Sortierung wird der Gesamtzeitraum bei Bedarf per
`MIN(beginn)`/`MAX(ende)` über die zugehörigen Räume berechnet.

### `vermietung_raeume`

Mehrere Räume pro Anfrage, jeweils mit eigenem Zeitfenster (z. B.
Hauptsaal 18–22 Uhr, Nebenraum nur 17–19 Uhr als Ablageort).

| Spalte | Typ | Bemerkung |
|---|---|---|
| `id` | int PK | |
| `vermietung_id` | int FK `vermietungen` | |
| `ct_resource_id` | int | **kein FK** — verweist auf eine Ressource in ChurchTools, nicht in unserer DB |
| `raum_bezeichnung` | text | Cache des CT-Raumnamens zum Auswahlzeitpunkt, damit eine spätere Umbenennung in CT alte Rechnungen nicht verändert |
| `beginn` | text (datetime) | gebuchtes CT-Zeitfenster, für Anzeige/Konflikt-Check |
| `ende` | text (datetime) | |
| `verrechnungs_tarif_typ` | text | CHECK: `stunde`, `halbtag`, `tag` |
| `verrechnungs_menge` | real | tatsächlich abgerechnete Menge — unabhängig vom Buchungsfenster (z. B. Aufbau am Vorabend nicht mitgezählt) |

### `vermietung_raum_preise` (Preisliste, admin-pflegbar)

| Spalte | Typ | Bemerkung |
|---|---|---|
| `id` | int PK | |
| `ct_resource_id` | int | kein FK, siehe oben |
| `raum_bezeichnung` | text | Cache für die Admin-Ansicht |
| `tarif_typ` | text | CHECK: `stunde`, `halbtag`, `tag` |
| `preis_extern` | text | |
| `preis_intern` | text | |
| `aktiv` | int | |

Pro Raum bis zu drei Zeilen (eine je Tarif-Typ) — nicht jeder Raum muss
alle drei gepflegt haben.

### `vermietung_positionen`

Editierbare Rechnungspositionen.

| Spalte | Typ | Bemerkung |
|---|---|---|
| `id` | int PK | |
| `vermietung_id` | int FK `vermietungen` | |
| `bezeichnung` | text | |
| `betrag` | text | |
| `sortierung` | int | |

Beim Erstellen der Rechnung wird pro Zeile aus `vermietung_raeume`
automatisch eine Position vorgeschlagen (Betrag = passender Preis aus
`vermietung_raum_preise` nach `tarif_typ` + `kundentyp`, ×
`verrechnungs_menge`). Technik-/Stuhlungs-Zuschläge werden als weitere,
frei erfasste Positionen ergänzt. Alle Positionen bleiben vor dem
Erstellen frei editierbar.

### `vermietung_aufgaben`

Checkliste/Aufgaben pro Vermietung.

| Spalte | Typ | Bemerkung |
|---|---|---|
| `id` | int PK | |
| `vermietung_id` | int FK `vermietungen` | |
| `bezeichnung` | text | |
| `faellig_am` | text (date) | |
| `zugewiesen_an` | text FK `personen` NULL | NULL = offener Team-Pool |
| `erledigt` | int default 0 | |
| `erledigt_von` | text FK `personen` NULL | |
| `erledigt_am` | text NULL | |
| `erinnerung_versendet_am` | text NULL | verhindert Mehrfach-Mails |
| `ist_standard` | int default 0 | ob aus einer Vorlage übernommen (informativ) |

### `vermietung_aufgaben_vorlagen` (admin-pflegbar)

| Spalte | Typ | Bemerkung |
|---|---|---|
| `id` | int PK | |
| `bezeichnung` | text | |
| `standard_frist_tage` | int | Tage vor Termin für den `faellig_am`-Vorschlag |
| `aktiv` | int | |

Beim Anlegen einer Vermietung werden aktive Vorlagen als Vorschläge
übernommen; zusätzlich können pro Vermietung frei formulierte Punkte
ergänzt werden ("Mischung" aus Standard-Katalog und Freitext).

## ChurchTools-Integration

Neuer Service `src/services/ctBookings.js`, rein lesend, nutzt den
bestehenden `CT_SYNC_SERVICE_TOKEN` (`Authorization: Login <token>`,
gleiches Muster wie `churchtools.js`). Keine neuen Schreibrechte nötig.

- **Raum-Katalog**: `GET /resource/masterdata` liefert `resourceTypes` +
  `resources`. Ein neuer `admin_config`-Wert (nicht Env-Variable — siehe
  unten) legt fest, welche `resourceTypeId`(s) als "Räume" zählen, damit
  andere Ressourcentypen (Autos, Geräte) nicht als Raum auswählbar sind.
- **Konflikt-Warnung**: Für jeden in `vermietung_raeume` gewählten Raum
  ruft das Portal `POST /bookings/conflicts` (mit `resourceId`,
  `startDate`, `endDate`) live ab, sobald Raum/Zeitfenster
  eingetragen/geändert werden. Kollisionen werden als Warnung mit den
  betroffenen Buchungen angezeigt — rein informativ, keine Blockade, da
  die eigentliche Buchung separat und weiterhin manuell in ChurchTools
  selbst vorgenommen wird.
- Die `resourceTypeId`-Zuordnung liegt in `admin_config` statt in einer
  Env-Variable (anders als `CT_GROUP_ID_*`), weil sie betrieblich, nicht
  sicherheitskritisch ist und ohne Redeploy änderbar sein soll.

## Aufgaben-Erinnerung

Neuer, siebter Hintergrund-Job (`src/services/scheduler.js` erweitert,
analog zu `eskalation.js`): läuft täglich, sucht `vermietung_aufgaben`
mit `erledigt = 0 AND faellig_am <= heute AND erinnerung_versendet_am IS
NULL`, verschickt eine Mail (neuer Typ im bestehenden
`mailTemplates.js`/Batching-System) an die zugewiesene Person — oder,
falls `zugewiesen_an` leer ist, an alle Personen mit der neuen
Vermietungs-Rolle — und setzt `erinnerung_versendet_am`. Keine
wiederholte Mail für dieselbe Aufgabe.

Neue Dashboard-Seite `/vermietung/aufgaben` (Muster wie `/pool`): zeigt
offene Aufgaben, die der eingeloggten Person zugewiesen sind oder offen
im Pool liegen, mit "Erledigt"-Button
(`POST /vermietung/aufgaben/:id/erledigen`). Eine fällige, unerledigte
Aufgabe bleibt dauerhaft sichtbar, bis sie erledigt markiert wird.

## Rechte und Rollen

Folgt dem bestehenden Muster aus [auth-und-rechte.md](../../auth-und-rechte.md).

- Neue, **optionale** ChurchTools-Gruppe → neue Rolle `vermietung`
  (mirrors `buchhaltung`): `CT_GROUP_ID_VERMIETUNG` (optional wie
  `CT_GROUP_ID_MANAGER`, damit bestehende Deployments nichts sofort
  konfigurieren müssen). Diese Rolle sieht das Vermietungs-Dashboard,
  legt Anfragen an, bearbeitet sie bis zur Rechnung.
- Neues additives Einzelrecht `vermietung_preise_verwalten` (ergänzt die
  bestehenden acht additiven Rechte in `person_berechtigungen`) — Pflege
  der Preisliste (`vermietung_raum_preise`) und der Aufgaben-Vorlagen
  (`vermietung_aufgaben_vorlagen`) im Admin-Bereich. `superadmin` erhält
  es automatisch wie die anderen sieben Rechte.
- Modul-Toggle nach etabliertem Muster (Spesenmodul):
  `modul_vermietung_aktiv` in `admin_config`, schaltbar über die
  bestehende `/admin/module`-Seite. Deaktivierung blockt nur neue
  Anfragen, laufende Vermietungen bleiben unangetastet.

## Rechnungs-PDF und Versand

Neuer Service `src/services/vermietungRechnung.js`, nutzt das bereits
vorhandene `pdf-lib` (wie `pdfStamp.js`/`splitGruppenExport.js`) — Kopf
mit Branding-Logo, Kundendaten, Positionstabelle (Räume + Zuschläge),
Summe. Direkt als PDF, kein Word-Zwischenschritt. Eigene fortlaufende
Rechnungsnummer mit admin-konfigurierbarem Präfix.

`rechnung_versandart` ist pro Vermietung wählbar:
- `mail`: PDF wird als Anhang über den bestehenden `mailer.js` an
  `kunde_email` verschickt.
- `download`: PDF wird als direkter Download-Link bereitgestellt (kein
  komplexes Autorisierungsschema wie bei Lieferantenrechnungen nötig, da
  keine Freigabe-Kette).

Nach Abschluss (Mail verschickt bzw. Download-Link erzeugt) wechselt der
Status auf `rechnung_versendet`.

## Admin-Bereich

Neue Unterseiten (Zugriff: `superadmin` oder
`vermietung_preise_verwalten`):

- Preisliste verwalten: Räume aus ChurchTools laden, Tarife/Preise
  pflegen (`vermietung_raum_preise`).
- Aufgaben-Vorlagen verwalten (`vermietung_aufgaben_vorlagen`).
- Zuordnung, welche(r) CT-`resourceTypeId`(s) als "Räume" zählen
  (`admin_config`).
- Rechnungsnummer-Präfix (`admin_config`).

Modul-Toggle (`modul_vermietung_aktiv`) ergänzt die bestehende
`/admin/module`-Seite neben dem Spesenmodul-Schalter.

## Offene Punkte für die Umsetzung

- Genaues Kunden-Formular-Layout (welche Felder Pflicht sind) wird in
  der Implementierungsphase anhand des Anfrage-Formulars konkretisiert.
- Exaktes PDF-Layout der Mietrechnung wird anhand eines existierenden
  Word-Musters (falls vorhanden) nachgebildet — sonst ein einfaches,
  brandingkonformes Layout analog zu bestehenden Stempelseiten.
