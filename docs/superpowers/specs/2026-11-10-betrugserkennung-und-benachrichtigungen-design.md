# Release nach 1.0.1: Betrugserkennung ausweiten + Benachrichtigungen pro Ereignis

Datum: 2026-11-10 · Status: Entwurf zur Freigabe
Visuelle Entwürfe (Desktop): Design-Canvas „Betrugserkennung Entwürfe“ (privates Artefakt, Link beim User).

Der Release umfasst vier Teile:

- **A. Kleinkram:** Logo-Link, Logo-Position mobil, /audit-pruefen in Du-Form
- **B. Betrugserkennung:** Pflicht-IBAN, Prüfungen A–G, Prüf-Popup, manuelle IBAN-Kontrolle ohne QR-Code
- **C. Benachrichtigungen pro Ereignis:** neue Admin-Seite statt „Eskalationszeiten“ + „Mail-Einstellungen“
- **D. Durchgängig Du-Form**

## Warum

- Die bestehende IBAN-Prüfung (`pruefeIbanAbgleich`, `src/services/aufsplitten.js`) hat keine verlässliche Referenz: Hat ein Lieferant keine IBAN, kann die *erste* Rechnung ihre eigene IBAN über „IBAN merken“ als bekannt eintragen. Eine gefälschte Erstrechnung legitimiert sich so selbst. Die Referenz-IBAN muss aus einer unabhängigen Quelle (Vertrag, Telefonat) kommen und vom Admin erfasst werden.
- Heute geht die IBAN-Warn-Mail beim Speichern raus, ohne dass die kontierende Person aktiv innehält. Gewünscht: Sie wird *vor* dem Speichern gestoppt und aufgefordert, nochmals zu prüfen.
- Die Empfänger-Felder („ein Ziel pro Zeile, `gruppe:buchhaltung`“) und die 22 untereinanderstehenden Mail-Vorlagen sind für den Admin unübersichtlich.
- Das System ist **noch nicht produktiv**: Es gibt keine Rückwärtskompatibilität mit Live-Daten zu wahren. Bestehende Konfigurationswerte (Test-/Demo-Instanzen) werden migriert, nicht weggeworfen.

## Ziele / Nicht-Ziele / Anti-Ziele

**Ziele**
- Jeder Lieferant, der per Überweisung oder Dauerauftrag bezahlt wird, hat mindestens eine vom Admin erfasste IBAN.
- Auffälligkeiten werden der kontierenden Person in *einem* Popup gezeigt, bevor gespeichert wird. Sie bestätigt bewusst oder bricht ab. Bestätigung und Auffälligkeiten landen im Audit-Log, in der Freigabe-Ansicht und in *einer* Warn-Mail.
- Der Admin stellt pro Ereignis an einer Stelle ein, wann die Mail kommt, wer sie bekommt und was drinsteht.

**Nicht-Ziele**
- Keine harte Sperre einer Rechnung wegen Auffälligkeiten. Das letzte Wort haben die Freigeber (Hinweis, kein Stopp, wie heute).
- Keine Absender-Domain-/Mail-Header-Analyse, kein Machine Learning.
- Kein Umbau des Mail-Versands selbst (Outbox, Retry, Digest-Mechanik bleiben).

**Anti-Ziele** (wäre ein Fehlschlag, auch wenn es technisch funktioniert)
- Ein Popup, das bei jeder zweiten Rechnung kommt und deshalb blind weggeklickt wird. Schwellen und der Pro-Lieferant-Schalter existieren genau dagegen.
- Eine Kontierungsseite, die die hinterlegte IBAN vollständig anzeigt (dann wird abgeschrieben statt verglichen).
- Ein Weg, über den eine Nicht-Admin-Person eine IBAN als „bekannt“ markiert.

---

## A. Kleinkram

1. **Logo verlinkt auf die Startseite:** `views/_logo.ejs` in `<a href="/">` einpacken, mit `aria-label`, z. B. „Zur Startseite“. Gilt für alle drei Ausrichtungen.
2. **Bug: Logo klebt auf dem Handy rechts am Farbmodus-Knopf, obwohl „links“ eingestellt ist.** Das Header-Grid unter 576 px liegt in `public/css/portal.css` (~Z. 54–70, Areas `menue marke rechts`). Die Ursache ist nicht geklärt: Zuerst im Browser bei 375 px reproduzieren (mit und ohne Seitenleisten-Knopf, eingeloggt und ausgeloggt). Dann mit einem Test belegen und beheben. Erwartet: Bei „links“ steht das Logo direkt rechts vom Menü-Knopf (bzw. ganz links, wenn es keinen gibt).
3. **/audit-pruefen in Du-Form** (`views/audit-pruefen.ejs`), siehe D.

---

## B. Betrugserkennung

### B1. Zahlungsart pro Lieferant + Pflicht-IBAN

Neue Spalte `kreditoren.zahlungsart` mit den Werten `ueberweisung` (Default) | `dauerauftrag` | `lastschrift` | `kreditkarte` (Lastschrift siehe Klärung 5).

| Zahlungsart | IBAN Pflicht | Verhalten |
|---|---|---|
| Überweisung (auch Proforma/Vorauskasse) | ja, ≥ 1 | volle IBAN-Prüfung |
| Dauerauftrag | ja, ≥ 1 | volle IBAN-Prüfung, falls QR vorhanden; ausgenommen von Prüfung G |
| Lastschrift (vom Konto belastet) | nein | wie Kreditkarte, siehe Klärung 5 |
| Kreditkarte | nein | keine IBAN-Prüfung. Hat die Rechnung trotzdem einen QR-Code, gibt es eine Auffälligkeit „Lieferant wird sonst per Kreditkarte bezahlt“ |

- Admin-Formular (Admin → Stammdaten → Kreditoren): Radio „Zahlungsart“. Speichern mit Überweisung/Dauerauftrag ohne IBAN wird abgelehnt (Feldfehler), siehe Entwurf 3. Neuer Lieferant: Die erste IBAN wird direkt im Anlege-Formular erfasst.
- Liste: Spalten Zahlungsart, IBANs (gekürzt `CH44 … 1234`), Status-Badge „vollständig“ / „IBAN fehlt“. Oben ein roter Hinweis mit Anzahl unvollständiger Lieferanten.
- **Unvollständige Lieferanten sind bei der Kontierung (normal und Aufsplitten) nicht auswählbar.** Sie erscheinen nicht im Dropdown, bzw. werden serverseitig mit Feldfehler abgelehnt. Gilt auch für Zuweisungsregeln: Trifft eine Regel einen unvollständigen Lieferanten, fällt der Beleg in den Pool statt direkt zugewiesen zu werden.
- Die IBAN-Löschung im Admin verhindert, dass die letzte IBAN eines Überweisungs-/Dauerauftrags-Lieferanten entfernt wird.
- Mehrere IBANs pro Lieferant bleiben möglich (`kreditor_ibans`). Die globale Eindeutigkeit einer IBAN bleibt.
- Hinweistext im Formular: „Neue IBANs nur aus unabhängiger Quelle (Vertrag, Telefonat) übernehmen, nicht von einer Rechnung.“
- Bestehende Lieferanten: keine Übergangslösung (System nicht produktiv). Die Migration setzt `zahlungsart = 'ueberweisung'`. Wer keine IBAN hat, ist danach „unvollständig“, bis der Admin sie nachträgt.

### B2. Ausländische IBANs

- `isValidIban` (`src/services/ibanUtils.js`) akzeptiert neu jede IBAN mit gültigem Ländercode, Länge gemäss Land und Mod-97-Prüfziffer. Heute erlaubt sie nur `^CH\d{2}[0-9A-Z]{17}$`. Eine Prüfziffer-Funktion existiert bereits (`ibanChecksumValid` in `paymentApproval.js`) und wird in `ibanUtils.js` zusammengeführt.
- **Achtung, für den Builder zu prüfen:** `paymentApproval.js` und der Bexio-/Zahlungsexport nutzen `isValidIban`. Ob ausländische IBANs dort durchgehen dürfen, ist offen, siehe „Offene Punkte“.

### B3. „IBAN merken“ entfällt

Die Checkbox „IBAN … künftig automatisch zuordnen“ auf der Kontierungsseite und der zugehörige Speicherpfad (`quelle = 'bestaetigt'`) werden entfernt. Neue IBANs entstehen nur noch im Admin. Bestehende Zeilen mit `quelle = 'bestaetigt'` bleiben gültig.

### B4. Die Prüfungen

Alle Prüfungen laufen serverseitig beim Speichern der Kontierung (Aktion „Kontieren“) und pro Lieferant beim Aufsplitten. Sie laufen nicht bei „Ablehnen“, „Rapport“ oder „Zurück in den Pool“. Gutschriften: nur A–D. E–G entfallen, weil Gutschriften negative bzw. unregelmässige Beträge haben (Builder-Entscheid, siehe unten).

**Mit QR-Code** (`job.qr_iban` vorhanden):

| Code | Auffälligkeit | Bedingung | Schwere |
|---|---|---|---|
| IBAN | IBAN nicht hinterlegt | QR-IBAN ∉ IBANs des gewählten Lieferanten | rot |
| A | IBAN gehört anderem Lieferanten | QR-IBAN ist bei einem *anderen* Lieferanten hinterlegt (nennt dessen Namen) | rot, ersetzt in diesem Fall „IBAN nicht hinterlegt“ |
| B | Ausländische IBAN | Ländercode ∉ {CH, LI} und der Lieferant hat keine hinterlegte IBAN mit demselben Ländercode | gelb |
| C | Name weicht ab | `qr_creditor_name` passt nicht zum Lieferantennamen (normalisierter Vergleich, siehe unten) | gelb |
| D | Betrag weicht ab | `qr_betrag` vorhanden und ≠ kontierter Betrag (exakt, auf Rappen) | gelb |
| K | Kreditkarten-Lieferant mit QR-Code | `zahlungsart = 'kreditkarte'` und QR-Code vorhanden | gelb. Bei diesen Lieferanten entfallen IBAN/A/B |

**Ohne QR-Code**, Lieferant mit Überweisung/Dauerauftrag: manuelle IBAN-Kontrolle (B5).

**Betragsprüfungen** (unabhängig vom QR-Code, nur Typ Rechnung):

| Code | Auffälligkeit | Bedingung (Defaults, einstellbar) |
|---|---|---|
| E | Ungewöhnlich hoher Betrag | ≥ 5 frühere kontierte Rechnungen dieses Lieferanten **und** Betrag ≥ 3 × Durchschnitt derselben **und** Betrag ≥ CHF 500. Nicht, wenn beim Lieferanten „Beträge schwanken stark“ gesetzt ist (neue Spalte `kreditoren.betrag_schwankt`, Checkbox im Admin-Formular, Entwurf 3) |
| F | Neuer Lieferant, hoher Betrag | Lieferant hat noch keine frühere kontierte Rechnung **und** Betrag > CHF 2'000 |
| G | Gleicher Betrag kurz hintereinander | Anderer Job, gleicher Lieferant, gleicher Betrag, kontiert innerhalb 30 Tagen, Rechnungsnummer verschieden (gleiche Nummer = bestehender Duplikat-Check). Nicht bei `zahlungsart = 'dauerauftrag'` |

„Frühere kontierte Rechnungen“: Jobs desselben Lieferanten, Typ Rechnung, die mindestens kontiert wurden und nicht abgelehnt oder gelöscht sind, ohne den aktuellen Job. Der Durchschnitt läuft über die letzten 12 Monate, sonst über alle. Den Vergleichsbetrag bei Aufsplitten (Teilbetrag oder Gesamtbetrag) entscheidet der Builder.

Die Schwellen für E/F/G (Mindestanzahl, Faktor, Mindestbetrag, Neu-Lieferant-Betrag, Tage) liegen in `admin_config` und sind auf der Benachrichtigungsseite beim Ereignis „Auffälligkeiten bei Kontierung“ unter „Wann“ einstellbar (Teil C).

Der bestehende Rechnungsnummer-Duplikat-Check und der Doppelscan-Check bleiben unverändert und eigenständig. Sie erscheinen **nicht** im Popup.

**Namensvergleich C:** Kleinbuchstaben, Umlaute und Akzente vereinheitlicht, Rechtsform-Suffixe entfernt (AG, GmbH, SA, Sàrl, KLG, e.V., Ltd …), Satzzeichen und Leerzeichen entfernt. Treffer, wenn ein Name den anderen enthält oder die Ähnlichkeit hoch ist. Die Schwelle legt der Builder fest, Ziel: „Muster Druck AG“ = „MUSTER-DRUCK“, aber „Muster Druk GmbH“ ≠ „Muster Druck AG“ wird angezeigt. Lieber gelegentlich ein gelber Hinweis zu viel als ein Treffer zu wenig, aber nicht bei jeder Rechnung.

### B5. Manuelle IBAN-Kontrolle ohne QR-Code (Entwurf 2)

- Gilt nur, wenn die Rechnung keinen QR-Code hat und der gewählte Lieferant Überweisung oder Dauerauftrag ist (nur Typ Rechnung, nicht Gutschrift oder Rapport).
- Gelber Kasten „Kein QR-Code: IBAN bitte von Hand prüfen“ mit dem Feld **„Letzte 4 Zeichen der IBAN“** (Pflichtfeld, 4 alphanumerische Zeichen, Gross/Klein egal).
- Die hinterlegte IBAN wird **nicht** angezeigt, auch nicht teilweise.
- Der Kasten erscheint bzw. verschwindet beim Wechsel des Lieferanten im Dropdown (clientseitig, Daten: Zahlungsart je Lieferant). Massgeblich ist der Server.
- Optional clientseitiger Sofort-Hinweis „Passt zu einer hinterlegten IBAN“: nur, wenn das ohne Preisgabe der Endziffern geht (z. B. Abgleich per Server-Endpoint). Sonst nur serverseitig beim Speichern.
- Kein Treffer: Die 4 Zeichen passen auf keine hinterlegte IBAN → Auffälligkeit „IBAN nicht hinterlegt (manuelle Prüfung)“ im Popup.
- Audit-Log in jedem Fall: „IBAN manuell geprüft: Übereinstimmung / keine Übereinstimmung“, Person, Zeit, die eingegebenen 4 Zeichen.
- Aufsplitten: dieselbe Kontrolle pro Teilrechnung bzw. Lieferant.

### B6. Das Prüf-Popup (Entwurf 1)

- Ablauf: Formular absenden → Server prüft → Gibt es Auffälligkeiten und hat der Request keine gültige Bestätigung, wird **nichts gespeichert und keine Mail verschickt**. Die Seite wird mit erhaltenen Formularwerten und geöffnetem Modal neu gerendert (gleiches Muster wie bestehende Validierungsfehler, Bootstrap-Modal, CSP-Nonce beachten).
- Modal: Titel „Bitte Rechnung nochmals prüfen“, Liste der Auffälligkeiten (rot vor gelb), Hinweisbox „Prüfe die Bankverbindung telefonisch beim Lieferanten, mit der Nummer aus deinen eigenen Unterlagen, nicht mit der auf der Rechnung.“ (nur, wenn eine IBAN-Auffälligkeit dabei ist), optionales Feld „Wie hast du geprüft?“ (max. 500 Zeichen), Hinweis „Beim Speichern werden Freigeber 1 und 2 per Mail informiert.“, Knöpfe **Abbrechen** (schliesst das Modal, Formular bleibt ausgefüllt) und **Geprüft, trotzdem speichern**.
- „Trotzdem speichern“ sendet das Formular erneut mit einem Bestätigungs-Token. Der Server rechnet die Prüfungen neu. Die Bestätigung gilt nur, wenn die bestätigten Auffälligkeiten identisch mit den neu berechneten sind (z. B. Hash über Codes und Werte). Sonst wird das Popup erneut gezeigt.
- Nach Bestätigung im Speicher-Vorgang:
  - Auffälligkeiten + Bemerkung + Person + Zeit am Job persistieren (neue Tabelle oder `freigaben`-Eintrag mit neuer `rolle`, Builder entscheidet). Muss die Freigabe-Ansichten speisen können.
  - Audit-Log-Eintrag.
  - **Eine** Mail vom Ereignis „Auffälligkeiten bei Kontierung“ (ersetzt `iban-warnung`) an: Freigeber 1 + 2 des Kontos, die kontierende Person, zusätzlich konfigurierte Empfänger. Immer sofort, nicht gebündelt.
- Freigabe-Ansicht (Freigabe 1, Freigabe 2, Spesen, sofern zutreffend): rot umrandeter Kasten „N Auffälligkeiten, bewusst bestätigt“ mit Liste, „Bestätigt von X am …“, „Wie geprüft: …“ (Entwurf 4). Ebenso in der Admin-Vorgangsansicht.
- Der heutige Hinweis „QR-Code deutet auf Lieferant X hin, aktuell zugewiesen Y“ auf der Kontierungsseite bleibt.

---

## C. Benachrichtigungen pro Ereignis (Entwurf 5)

Neue Admin-Seite **„Benachrichtigungen“**. Sie ersetzt die Seiten „Eskalationszeiten“ (`/admin/eskalation`) und „Mail-Einstellungen“ (`/admin/mail-einstellungen`). Alte URLs leiten weiter, Dashboard-Kachel und Links (u. a. `views/admin/geplante-jobs.ejs`) werden angepasst. Rechte wie die heutigen Seiten.

**Layout:** links die Ereignisliste nach Bereichen mit Suchfeld und Markierung „angepasst“ (Text weicht vom Standard ab). Rechts das gewählte Ereignis mit drei Blöcken. Ein Ereignis pro URL (z. B. `/admin/benachrichtigungen/reminder`), Speichern pro Ereignis.

**Bereiche und Ereignisse** (Zuordnung der bestehenden 22 Vorlagen + Konfigwerte):

- *Allgemein:* Zusammenfassung & Versandzeit (Standard sofort/täglich/wöchentlich, Wochentag, Uhrzeit, Digest-Vorlage)
- *Rechnungen:* Neue Rechnung zugewiesen · Erinnerung · Eskalation · Abgelehnt · Von Administration übergeben · Neuer Kommentar
- *Freigabe 2:* Erinnerung · Übergabe an Admin
- *Warnungen:* Auffälligkeiten bei Kontierung (neu, ersetzt IBAN-Warnung, inkl. Schwellen E/F/G) · Rechnungsnummer doppelt · Mögliche doppelte Rechnung
- *Rapporte:* Zur Kenntnis · Erinnerung · Eskalation
- *Kreditkarten:* Abrechnung zum Abgleich · Belege-Erinnerung · Beleg eingegangen
- *System & Sicherheit:* Sync-Fehler · Neues Gerät · Fehlermeldung · Audit-Prüfnummer

**Block 1 „Wann“:** die zum Ereignis gehörenden Stunden-Werte (Reminder/Eskalation/F2/Rapport). Bei sofortigen Ereignissen nur der Hinweis „wird sofort verschickt“. Die Werte und Validierungen sind dieselben wie heute.

**Block 2 „Wer“:**
- Fester Text, wer automatisch eine Mail bekommt (z. B. „die zuständige Person“, „Freigeber 1 und 2 des Kontos“), aus einer Ereignis-Definition im Code.
- Nur bei Ereignissen, die heute konfigurierbare Empfänger haben (Reminder, Eskalation, F2-Übergabe, IBAN- bzw. Auffälligkeiten, Rapport-Eskalation): zusätzliche Empfänger als Kärtchen mit ×. Ein Suchfeld zeigt Gruppen (Buchhaltung, Admin), aktive Personen aus der Personenliste (Name, Mail) und „Andere E-Mail-Adresse eingeben …“ (validiert).
- Speicherformat: Der Builder entscheidet, die Formate `gruppe:…` und Mail bleiben gültig. Personen werden über ID referenziert und beim Versand zur aktuellen Mail aufgelöst; `resolveEmpfaenger` wird entsprechend erweitert. Bestehende Werte werden ohne Verlust übernommen.
- Ohne JavaScript: einfache Fallback-Bedienung (Checkboxen für Gruppen, Select für Personen, Textfeld für Adresse) reicht.

**Block 3 „Was“:**
- Betreff + Text. Variablen als Knöpfe mit lesbaren Namen („Name“, „Dateiname“, „Link“ …), die beim Klick `%variable%` an der Cursorposition einfügen. Liste pro Ereignis aus der Ereignis-Definition, ersetzt die heutigen `form-text`-Hinweise.
- **Live-Vorschau** mit Beispieldaten (clientseitig, gleiche Ersetzungslogik wie `renderTemplate`).
- Warnung bei unbekannten Variablen. Bestehende Pflicht-Hinweise (z. B. Digest `%zusammenfassung%`) bleiben.
- Knöpfe: **Speichern**, **Test-Mail an mich** (rendert mit Beispieldaten, sendet an die Mail des angemeldeten Admins über den normalen Versandweg, Audit-Log-Eintrag), **Text auf Standard zurücksetzen** (mit Bestätigung).
- Markierung „angepasst“: Vergleich mit dem Standardtext.

Die heutigen Vorlagen-Keys (`TYP_ZU_KEY_INFIX`, `admin_config`) bleiben die Datenbasis. Neuer Typ `auffaelligkeiten-warnung`. `iban-warnung` wird migriert: Ein angepasster Text wird übernommen, aber die neuen Variablen (Liste der Auffälligkeiten, Bemerkung, Bestätigt von) müssen im Standardtext vorkommen.

---

## D. Durchgängig Du-Form

- Die Oberfläche ist schon fast überall Du. Umstellen: `views/audit-pruefen.ejs` (heute bewusst Sie, auf Wunsch des Users nun Du) und alle **Standard**-Mailtexte, die noch Sie-Form enthalten. Der Builder greppt Views, Standardvorlagen und Fehlermeldungen in Routen.
- Vom Admin angepasste Mailtexte werden nicht automatisch umgeschrieben.
- Alle neuen Texte dieses Releases in Du-Form.

---

## Dokumentation & Tests

- Docs aktualisieren: `docs/qr-bill-und-betrugserkennung.md` (neu strukturieren: Pflicht-IBAN, Prüfungen, Popup, manuelle Prüfung), `docs/datenmodell.md`, `docs/admin-bereich.md`, `docs/geplante-jobs-und-benachrichtigungen.md`, Testdrehbuch (`docs/testdrehbuch/`), Release-Notes `docs/releases/`, CHANGELOG.
- Tests: jede Prüfung (Treffer, Nicht-Treffer, Grenzwerte), Popup-Flow (ohne Bestätigung nichts gespeichert, keine Mail; mit Bestätigung genau eine Mail; veränderte Daten → erneutes Popup), Aufsplitten, Pflicht-IBAN (Formular, Kontierungs-Dropdown, Zuweisungsregel, letzte IBAN löschen), ausländische IBAN-Validierung, Empfänger-Migration und -Auflösung, Test-Mail, Weiterleitungen alte URLs, CSRF-Sweep für neue Routen.
- Testmodus-Beispieldaten (`src/services/testmodus/beispieldaten.js`): Lieferanten bekommen IBAN und Zahlungsart.

## Dem Builder überlassen

Tabellen- und Spaltendesign für persistierte Auffälligkeiten, Bestätigungs-Token-Mechanik, Namens-Ähnlichkeitsschwelle, Datenformat der Empfänger, Aufteilung in Commits/Etappen, Mobile-Darstellung der neuen Seiten (muss bei 375 px benutzbar sein; Entwürfe sind Desktop).

## Entscheide von Claude (nicht explizit vom User)

- Unvollständige Lieferanten sind bei der Kontierung nicht wählbar (User: „passt“).
- Ausländische IBAN B nur, wenn der Lieferant keine IBAN dieses Landes hat.
- Popup-Feld „Wie hast du geprüft?“ optional. Kasten in der Freigabe-Ansicht.
- Schwellen E/F/G: 5 Rechnungen / 3× / CHF 500 / CHF 2'000 / 30 Tage, einstellbar.
- E/F/G nicht für Gutschriften. G nicht für Daueraufträge.
- Variablen-Knöpfe mit lesbaren Namen. IBAN-Warnung geht in „Auffälligkeiten bei Kontierung“ auf.

## Klärungen nach Builder-Check (Entscheide von Claude)

1. **Ausländische IBANs nur in den Stammdaten.** `isValidIban` wird aufgeteilt: Eine breite Prüfung (alle Länder, Länge, Mod-97) gilt für die Kreditor-IBANs im Admin. Die strenge CH/LI-Prüfung bleibt für `validateSpesenPayment`, `validateQrPayment` und den Zahlungsexport. Spesen-Auszahlungen und der Export ändern ihr Verhalten nicht. B2 gilt entsprechend nur für die Stammdaten.
2. **Prüfung B entfällt.** Swiss-QR-Rechnungen enthalten nur CH/LI-IBANs, B könnte nie anschlagen. Eine fremde IBAN auf einer QR-Rechnung ist bereits durch „IBAN nicht hinterlegt“ abgedeckt. Ohne QR-Code ist nur die manuelle 4-Zeichen-Kontrolle möglich.
3. **Alle Empfänger-Einstellungen ziehen auf die neue Seite**, auch `sync_fehler_empfaenger` (heute `/admin/sync`), `sicherheitsalarm_empfaenger` (heute `/admin/zeitstempel`) und `audit_revision_empfaenger`. Ereignisse ohne Vorlage (z. B. `sicherheitsalarm`) erscheinen ohne Block „Was“. Die alten Felder werden auf ihren Seiten durch einen Link „Empfänger einstellen → Benachrichtigungen“ ersetzt.
4. **Währung bei E/F/G:** Es gibt keine Währungsspalte. E und G vergleichen innerhalb desselben Lieferanten, der praktisch immer in derselben Währung abrechnet. Die Beträge werden nominal verglichen, ohne Umrechnung. Die Schwellen „CHF 500“ und „CHF 2'000“ gelten nominal auch für Fremdwährungen. Bewusst einfach gehalten.

5. **Vierte Zahlungsart `lastschrift`** („Lastschrift (vom Konto belastet)“). Für Lieferanten, die per LSV oder Belastung direkt vom Konto bezahlt werden, z. B. Kartenherausgeber von Debit- und Kreditkarten. Der User weiss nicht sicher, wie die Kartenabrechnungen verrechnet werden, darum ist diese Option bewusst vorhanden. Wird die Rechnung doch per Einzahlungsschein bezahlt, stellt der Admin auf „Überweisung“ um und erfasst die IBAN. Verhalten wie `kreditkarte`: keine IBAN-Pflicht, keine IBAN-Prüfung. Hat eine Rechnung trotzdem einen QR-Code, gibt es die gelbe Auffälligkeit K mit dem Text „Lieferant wird sonst per Lastschrift bezahlt“. G ist für Lastschrift ausgenommen (regelmässige gleiche Beträge sind normal).
6. **Kartenherausgeber im Kreditkarten-Abgleich** (`kkAbgleich.js`, optionales Feld aus `kreditoren`): Dort gilt dieselbe Regel wie bei der Kontierung, unvollständige Lieferanten sind nicht wählbar. Weil Kartenherausgeber typischerweise `lastschrift` oder `kreditkarte` sind, sind sie nie unvollständig.

## Offene Punkte

Keine.
