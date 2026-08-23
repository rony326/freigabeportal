# Aufsplitten auf fremde Konten + Interessenskonflikt pro Teil — Design

## Kontext

`POST /kontierung/:id/aufsplitten` teilt eine Rechnung in mehrere eigenständige Teil-Rechnungen mit je eigenem Konto und Teilbetrag auf. Die Konto-Auswahl im Formular ist heute auf `ladeKontenFuerJob` beschränkt — also nur Konten, bei denen die aufsplittende Person selbst Freigeber1 oder Stellvertreter1 ist (plus das ursprünglich zugewiesene Konto des Elternjobs als Fallback). Diese Einschränkung ist kein Zufall: der Handler erteilt direkt im Anschluss für **jeden** Teil automatisch und ohne Rückfrage Freigabe 1 im Namen der aufsplittenden Person (`src/routes/kontierung.js`, `POST /:id/aufsplitten`, Zeilen ~517–539) — das ist nur korrekt, weil die Auswahl-Beschränkung sicherstellt, dass diese Person für jedes gewählte Konto tatsächlich zeichnungsberechtigt ist. Zwei Lücken ergeben sich daraus:

1. **Fremde Konten sind nicht wählbar.** Beispiel aus der Praxis: eine Sammelbestellung (z.B. bei Brack) wird aufgesplittet, ein Teil geht an Kinderbereich, ein anderer an Technik — die aufsplittende Person hat aber nicht zwingend bei beiden Kompetenzen. Heute lässt sich ein solches Konto im Formular gar nicht erst auswählen.
2. **Keine Interessenskonflikt-Abfrage.** Selbst für eigene Konten gibt es beim Aufsplitten (anders als bei der normalen Kontierung) keine Möglichkeit, einen persönlichen Interessenskonflikt zu erklären — `interessenskonflikt: false` ist fest verdrahtet.

Dieses Dokument beschreibt, wie beide Lücken gemeinsam geschlossen werden, indem bereits bestehende Mechanismen wiederverwendet werden: die Konto-Hinweis-Funktion aus dem "Zurück in den Pool legen"-Flow (`hinweis_konto_id`, siehe Commit `31a8520`) und die bestehende `eskalierenFreigabe1`-Eskalation aus der normalen Kontierung.

**Bewusst ausserhalb des Scopes** (vom Nutzer im Brainstorming bestätigt): Seltene Sonderfälle wie "eine bereits an die Stellvertretung eskalierte Person findet bei einer Aufsplitten-Zeile nochmal einen Konflikt" werden **nicht** pro Zeile automatisch erkannt oder an Portal-Admin eskaliert — das würde den vollen Fallunterschieds-Automaten der normalen Kontierung pro Zeile erfordern. Im Zweifel legt die betroffene Person diesen einen Teil danach manuell über die bestehende "Zurück in den Pool legen"-Funktion (mit oder ohne Konto-Hinweis) zurück.

## Pro-Zeile-Ergebnismodell

Für jede validierte Teil-Zeile `{ konto, betrag, interessenskonflikt }` wird serverseitig geprüft, ob `konto` in der bereits vorhandenen `konten`-Liste enthalten ist (`ladeKontenFuerJob`, `konten.some((k) => k.id === konto.id)`) — derselben Liste, die auch den Haupt-Kontierungs-Dropdown befüllt. Das ist bewusst **keine** neue, direkte `freigeber1_id`/`stellvertreter1_id`-Prüfung: `ladeKontenFuerJob` enthält bereits den bestehenden Fallback, der einem via `freigabe1_eskaliert_an_admin` autorisierten Portal-Admin das ursprünglich zugewiesene Konto des Elternjobs zugänglich macht, obwohl er dort keine Rolle hält (siehe Kommentar direkt über `ladeKontenFuerJob` in `kontierung.js`). Ohne Wiederverwendung dieser Liste würde ein Portal-Admin, der einen admin-eskalierten Job aufsplittet, plötzlich für jede Zeile in den "fremdes Konto"-Fall fallen — auch für das Konto, das er laut bestehender Logik eigentlich direkt bestätigen darf. Daraus ergeben sich drei sich gegenseitig ausschliessende Ergebnisse:

| Fall | Bedingung | Verhalten |
|---|---|---|
| **Selbst freigegeben** | `konto` in `konten`, `interessenskonflikt` nicht angekreuzt | Wie heute: `createSplitJob` mit `kontoId`, `zugewiesenAn: personId`, Status `zugewiesen`; direkt `createFreigabe(rolle: 'freigeber1')` + `abschliessenFreigabe1` → Teil ist sofort bei Freigabe 2. |
| **An Stellvertretung eskaliert** | `konto` in `konten`, `interessenskonflikt` angekreuzt | `createSplitJob` mit `kontoId`, `zugewiesenAn: personId`, Status `zugewiesen` (identisch zum ersten Fall) — direkt im Anschluss `eskalierenFreigabe1(db, kindId, { eskaliertVon: personId, grund: begruendung, stellvertreterId: konto.stellvertreter1_id })` (bestehende, unveränderte Funktion) plus `createFreigabe(rolle: 'freigabe1_eskalation', interessenskonflikt: true, kommentar: begruendung)` für den Audit-Trail — mirrored 1:1 den Konflikt-Zweig der normalen Kontierung. |
| **Fremdes Konto** | `konto` nicht in `konten` | `createSplitJob` **ohne** `kontoId`, stattdessen `hinweisKontoId: konto.id` — Status `unzugewiesen`, `zugewiesen_an: null`, `konto_id: null`, `hinweis_konto_id: konto.id`. Landet im allgemeinen Pool mit Hinweis-Badge, identisch zur bestehenden "Zurück in den Pool legen mit Hinweis"-Funktion. Der Wert von `interessenskonflikt` ist für diese Zeile irrelevant und wird ignoriert (die Person hat ohnehin keine Zeichnungsberechtigung auf diesem Konto, eine Konflikterklärung wäre bedeutungslos). |

Der Teilbetrag wird in allen drei Fällen sofort auf dem Kind-Job gespeichert (`createSplitJob`s bestehender `betrag`-Parameter, unverändert) — bei einem Pool-Hinweis-Teil muss die zuständige Person den Betrag später also nicht erneut eintippen.

## Datenmodell-Änderung: `createSplitJob`

Aktuelle Signatur (`src/db/jobsRepo.js`):
```js
export function createSplitJob(db, parentJob, { pdfPfad, thumbnailPfad, kontoId, betrag, zugewiesenAn })
```

Neue Signatur — `kontoId`/`zugewiesenAn` und `hinweisKontoId` sind gegenseitig exklusiv, genau eines der beiden Paare ist gesetzt:
```js
export function createSplitJob(db, parentJob, { pdfPfad, thumbnailPfad, kontoId, hinweisKontoId, betrag, zugewiesenAn })
```
Status wird innerhalb der Funktion abgeleitet: `kontoId ? 'zugewiesen' : 'unzugewiesen'`. Kein neues DB-Feld nötig — `hinweis_konto_id` existiert bereits seit der Konto-Hinweis-Funktion.

## Formular-Änderungen (`views/kontierung-aufsplitten.ejs`)

- Konto-`<select>` pro Zeile zeigt neu **alle aktiven Konten** (`alleKonten`, wie schon beim Hinweis-Konto-Picker im Zurück-in-Pool-Modal), nicht mehr nur `konten` (eigene). Der Route-Handler übergibt beide Listen an die View — `alleKonten` fürs Dropdown, `konten` bleibt intern für die Server-Validierung, welche Zeilen "eigene" Konten sind.
- Neue Checkbox pro Zeile: "Interessenskonflikt bei diesem Konto" mit Hilfetext "(nur relevant, wenn du selbst Freigeber oder Stellvertretung bist)" — bewusst immer sichtbar statt dynamisch per JS ein-/ausgeblendet, um die Komplexität niedrig zu halten.
- **Ein gemeinsames Begründungs-Feld** für das ganze Formular (nicht pro Zeile) — Pflicht, sobald mindestens eine Zeile die Konflikt-Checkbox gesetzt hat (serverseitige Validierung, analog zur bestehenden Prüfung in der normalen Kontierung: "Bei einem Interessenskonflikt ist eine Begründung Pflicht."). Wird als `grund` für alle eskalierten Zeilen dieser Einreichung verwendet.
- Erklärungstext oben im Formular wird von "Freigabe 1 gilt für jeden Teil als durch dich erteilt." auf eine kurze Beschreibung der drei Fälle umgestellt.
- Submit-Button-Text ändert von "Aufsplitten und Freigabe 1 erteilen" zu schlicht "Aufsplitten".
- Die "Bitte für jede Zeile ein gültiges Konto auswählen"-Validierung im Handler prüft neu gegen `alleKonten` statt `konten`.

## Benachrichtigungen

Nach dem Commit wird pro Ergebnis-Gruppe (nicht mehr einheitlich wie heute) die passende, bereits vorhandene Mail verschickt:

- **Selbst freigegeben** → Mail an den effektiven Freigeber2 (`getEffectiveFreigeber2Id`), exakt wie heute.
- **An Stellvertretung eskaliert** → Mail an `konto.stellvertreter1_id`, Text identisch zur bestehenden "Interessenskonflikt bei Freigabe 1 – Kontierung an dich übergeben"-Mail aus der normalen Kontierung.
- **Fremdes Konto** → Mail an `konto.freigeber1_id`, Text identisch zur bestehenden "Rechnung vermutlich für dein Konto — bitte aus dem Pool holen"-Mail aus dem Zurück-in-Pool-Hinweis-Flow.

## Testing

- Regression: reiner Selbst-freigegeben-Split über ausschliesslich eigene Konten funktioniert wie bisher (bestehende Tests bleiben grün).
- Neu: eine Zeile mit eigenem Konto + Konflikt-Checkbox → Kind-Job landet bei der Stellvertretung, Eskalations-Felder gesetzt, Mail verschickt, Begründung im Audit-Trail.
- Neu: eine Zeile mit fremdem Konto → Kind-Job landet unzugewiesen im Pool mit `hinweis_konto_id`, Betrag bereits gesetzt, Hinweis-Mail an den echten Freigeber1.
- Neu: gemischter Split (eine Zeile pro Fall in derselben Einreichung) → alle drei Ergebnisse gleichzeitig korrekt, nur eine Begründung nötig (deckt die eskalierte Zeile ab), Pool-Zeile zeigt Hinweis-Badge im Dashboard.
- Validierung: Konflikt-Checkbox ohne Begründung → Fehler, nichts wird persistiert (mirrored die bestehende Prüfung der normalen Kontierung).
- Validierung: fremdes Konto in einer Zeile lässt sich weiterhin nicht durch eine manipulierte, komplett unbekannte Konto-ID umgehen (Prüfung gegen `alleKonten`, nicht freies Texteingabe).
- Admin-Sonderfall: ein via `freigabe1_eskaliert_an_admin` autorisierter Portal-Admin, der einen admin-eskalierten Job aufsplittet, kann eine Zeile mit dem ursprünglich zugewiesenen (Fallback-)Konto weiterhin selbst freigeben — nicht fälschlich in den "fremdes Konto"-Pool-Pfad fallen, obwohl er dort keine Rolle hält.
