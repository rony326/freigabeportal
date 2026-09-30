# Review mit frischem Blick – 29.09.2026

Basis: Commit `cec9ebb`, unveränderter Anwendungscode. Keine Memories und keine früheren Audit-Berichte als Bewertungsgrundlage verwendet. Geprüft wurden aktuelle Betriebsdokumentation, Authentifizierung/Personen-Sync, Rechnungseingang, Freigabe 2, Export, Benachrichtigungen, Scheduler, Speicherverwaltung, Backup und TSA-Antwortverarbeitung. Dies ist eine Quellcodeprüfung mit lokalen Tests, keine Abnahme der produktiven Integrationen.

## Ergebnis und Validierung

`npm test`: **1.619 Tests bestanden**, keine fehlgeschlagenen oder übersprungenen Tests; Laufzeit rund 93 Sekunden. Zusätzlich wurden SMTP-Ausfall, ungültiger PDF-Eingang und Personen-Deaktivierung mit isolierten In-Memory-Datenbanken reproduziert. Keine produktiven Daten oder externen Dienste wurden dafür verwendet.

P1 bedeutet zeitnah beheben, weil ein regulärer Betriebsablauf ausfällt. P2 bedeutet relevanter Funktions- oder Dokumentationsfehler. Bestehende grüne Tests widerlegen die folgenden Befunde nicht: Die zusätzlichen Szenarien sind darin nicht ausreichend als gewünschtes Verhalten abgesichert.

## 1. P1: Personen-Sync deaktiviert berechtigte Nutzer außerhalb des alten Rollenmodells

**Stellen:** `src/services/sync.js:10–29,46–48`; `src/db/personenRepo.js:40`; `src/services/kkBelegEingang.js:19–21`.

Die Menge relevanter Personen enthält nur Mitglieder der drei Verwaltungsgruppen und Personen mit Kontorollen. Andere angemeldete Nutzer werden zur Deaktivierung vorgemerkt. Das betrifft insbesondere reine Spesen-Nutzer, Kartenverantwortliche ohne zusätzliche Kontorolle sowie Personen mit ausschließlich Einzelrechten. Der Login erlaubt diese Personen ausdrücklich.

**Reproduktion:** Zwei aktive Personen anlegen: einen Administrator und einen normalen angemeldeten Nutzer ohne Kontorolle. ChurchTools liefert den Administrator als Gruppenmitglied. Sync-Ergebnis: `upserted: 1, deactivated: 1`; der normale Nutzer hat anschließend `aktiv = false`. Die Suche nach seiner E-Mail-Adresse liefert `null`.

**Auswirkung:** Bestehende Sitzungen erhalten bei geschützten Seiten eine Anmeldeaufforderung; die E-Mail-Einreichung von Kreditkartenbelegen meldet einen unbekannten Absender. Erneutes Login aktiviert die Person wieder, bis der nächste Sync sie erneut deaktiviert. Bei größeren betroffenen Populationen kann stattdessen die Massendeaktivierungssperre den Sync abbrechen.

**Behebung:** Relevanzmodell an alle unterstützten Nutzerarten anpassen. Fehlende Verwaltungsgruppenmitgliedschaft darf allein keine Deaktivierung legitim angemeldeter Portalnutzer auslösen. Tatsächlichen Entzug des Zugangs separat prüfen. Regressionen für reine Spesen-Nutzer, Kartenverantwortliche, Ferienvertretungen und Einzelrechte ergänzen.

## 2. P1: SMTP-Ausfall verbraucht Erinnerungen ohne automatischen Wiederholungsversuch

**Stellen:** `src/services/notify.js:21–31`; `src/services/cronJobs.js:114–126,181–192,204–216`.

`sendRenderedMail` protokolliert SMTP-Fehler, liefert aber keinen Fehlschlag an den Aufrufer zurück. Die Erinnerungsjobs setzen anschließend trotzdem die Gesendet-Marker. Auch vollständig gescheiterte Zustellungen erscheinen dadurch im Cron-Verlauf als erfolgreicher Lauf.

**Reproduktion:** Überfällige Pool-Rechnung, ein konfigurierter Empfänger, Mailer mit geworfener SMTP-Exception. Zwei Erinnerungsdurchläufe ergeben insgesamt nur einen Sendeversuch. Der Mail-Log steht auf `fehlgeschlagen`, der Job besitzt trotzdem `reminder_gesendet_at`; beide Läufe melden `erfolg`.

**Auswirkung:** Ein kurzer Mailserver-Ausfall verhindert die spätere automatische Zustellung dieser Erinnerung. Manuelles Wiederholen über die Administration bleibt möglich, setzt aber die Entdeckung des Fehlers voraus. Beim Digest wechseln SMTP-Fehler ebenfalls dauerhaft aus der automatisch abgearbeiteten Menge `geplant` nach `fehlgeschlagen`.

**Behebung:** Versand beziehungsweise dauerhafte Einreihung explizit bestätigen; gescheiterte Zustellungen pro Empfänger wiederholen. Cron-Ergebnisse sollen Zustellfehler sichtbar ausweisen. Bereits erfolgreich erreichte Empfänger bei Teilfehlern berücksichtigen.

## 3. P2: Freigabe-2-Mails verlinken eine nicht vorhandene Seite

**Stellen:** `src/services/cronJobs.js:189,211`; `src/routes/freigabe2.js` definiert GET `/:id`.

Erinnerungen und automatische Eskalationen verwenden `/freigabe2` ohne Job-ID. Eine entsprechende Übersichtsroute existiert nicht; der Aufruf endet für angemeldete Nutzer auf der 404-Seite.

**Behebung:** Auf `/freigabe2/${job.id}` oder bewusst auf `/pool` verlinken. Den Link aus einer tatsächlich gerenderten Mail gegen die Anwendung prüfen.

## 4. P2: Unlesbare PDFs werden als erfolgreich eingegangene Rechnungen gespeichert

**Stellen:** `src/routes/n8n/jobs.js:27–28` und Fehlerbehandlung von Thumbnail-/QR-Verarbeitung.

Die Eingangsvalidierung prüft nur die vier Zeichen `%PDF`. Die Datenbankzeile wird vor der weitergehenden PDF-Verarbeitung angelegt; Fehler dieser Verarbeitung werden ausschließlich protokolliert.

**Reproduktion:** Upload mit dem Inhalt `%PDF kaputt`, Quelle `scanner` und Dateiname `kaputt.pdf`. Beide PDF-Verarbeitungen melden Fehler, die API antwortet trotzdem mit **201** und `{ id: 2, status: 'unzugewiesen' }`.

**Auswirkung:** n8n erhält eine Erfolgsmeldung für einen Beleg, den Nutzer nicht lesen und regulär abschließen können. Derselbe erneut eingereichte Dateiinhalt wird anschließend als Duplikat behandelt.

**Behebung:** Vor Jobanlage prüfen, ob das Dokument geöffnet werden kann und lesbare Seiten besitzt; unbrauchbare beziehungsweise nicht unterstützte verschlüsselte Dateien mit verständlichem Fehler ablehnen oder ausdrücklich als fehlerhaften Eingang quarantänisieren. Fehlende QR-Erkennung bei einem ansonsten lesbaren Dokument darf weiterhin zulässig sein.

## 5. P2: Betriebsdokumentation widerspricht dem aktuellen Backup-Verfahren

**Stellen:** `docs/geplante-jobs-und-benachrichtigungen.md:44,182–190`; `docs/admin-bereich.md:106–113`; außerdem veraltete Jobzahlen in README, Dokumentationsindex und Architektur.

Die Fachseiten beschreiben Sicherungen weiterhin als ZIP mit Geheimnissen im Klartext. Das aktuelle README und die Implementierung verlangen dagegen verschlüsselte `.fpbak`-Sicherungen mit separat gesichertem Schlüsselbund. Die Zahl der Hintergrundjobs wird wechselnd mit fünf, sechs, acht oder neun angegeben; der Scheduler registriert zehn einschließlich Sicherheitsalarmierung.

**Auswirkung:** Betreiber erhalten widersprüchliche Anweisungen zur Sicherung und Wiederherstellung. Gerade Schlüsselaufbewahrung und Prüfung der automatischen Jobs müssen eindeutig beschrieben sein.

**Behebung:** Backup-Beschreibungen auf eine verbindliche Anleitung für Verschlüsselung und Offline-Restore verweisen lassen; Format, Voraussetzungen, Aufbewahrung und aktuelle Jobliste überall abgleichen.

## Weitere Betriebsgrenzen

- Tägliche Scheduler-Jobs werden nach einem Neustart nur für den nächsten zukünftigen Termin eingeplant. Ein während eines Ausfalls verpasster Backup- oder Sync-Termin wird nicht automatisch nachgeholt (`src/services/scheduler.js:54–56`). Das sollte überwacht und ausdrücklich dokumentiert werden.
- Die Datenspeichersperre verlangt nach einem harten Prozessabbruch gegebenenfalls manuelles Eingreifen. Dieses Verhalten ist in der Offline-Restore-Anleitung vorgesehen; es wurde deshalb nicht als neuer Codefehler gewertet.
- Produktive SMTP-Zustellung, ChurchTools-Konfiguration, TSA-Vertrauenskette/CRL-Aktualisierung und n8n/Paperless-Roundtrip wurden nicht live geprüft. Aus den lokalen Tests folgt keine Bestätigung dieser Betriebsabhängigkeiten.

Der Review verändert keine Anwendungsfunktionen. Empfohlene Reihenfolge: Personen-Sync und zuverlässige Benachrichtigungen, danach Mail-Links und PDF-Eingangsvalidierung; Betriebsdokumentation gemeinsam mit den Korrekturen aktualisieren.
