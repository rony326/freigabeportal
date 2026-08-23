# Aufsplitten auf fremde Konten + Interessenskonflikt pro Teil Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Beim Aufsplitten einer Rechnung (`/kontierung/:id/aufsplitten`) sollen einzelne Teile auch Konten zugewiesen werden können, bei denen die aufsplittende Person weder Freigeber1 noch Stellvertreter1 ist — plus eine Interessenskonflikt-Abfrage pro Teil für Konten, bei denen sie es ist.

**Architecture:** Pro Zeile wird serverseitig geprüft, ob das gewählte Konto in der bereits vorhandenen, rollen-gefilterten `konten`-Liste (`ladeKontenFuerJob`) enthalten ist. Eigene Konten ohne Konflikt: Freigabe 1 wie bisher sofort selbst erteilt. Eigene Konten mit Konflikt: direkt an die Stellvertretung eskaliert (bestehende `eskalierenFreigabe1`-Funktion, unverändert). Fremde Konten: Teil landet unzugewiesen im Pool mit `hinweis_konto_id` gesetzt — das ist exakt der bereits existierende Konto-Hinweis-Mechanismus aus dem "Zurück in den Pool legen"-Flow (Commit `31a8520`), hier nur aus einem zweiten Aufrufer heraus genutzt. **Kein neues DB-Feld, keine neue Pool-/Dashboard-Anzeige-Logik nötig** — `hinweis_konto_id` und dessen Darstellung in `poolPage.js`/`_job_table.ejs` existieren bereits und sind komplett agnostisch gegenüber der Quelle (Zurück-in-Pool oder Aufsplitten).

**Tech Stack:** Node.js/Express, EJS, SQLite (node:sqlite), `node --test` + `supertest`.

**Spec:** `docs/superpowers/specs/2026-08-23-aufsplitten-fremde-konten-design.md`

## Global Constraints

- Seltene Sonderfälle (z.B. bereits eskalierte Stellvertretung findet bei einer Zeile nochmal einen Konflikt) werden **nicht** automatisch pro Zeile erkannt oder an Portal-Admin eskaliert — bewusst ausserhalb des Scopes, siehe Spec "Kontext".
- Ein via `freigabe1_eskaliert_an_admin` autorisierter Portal-Admin muss eine Zeile mit dem ursprünglich zugewiesenen (Fallback-)Konto weiterhin selbst freigeben können — die Pro-Zeile-Prüfung muss die bestehende `konten`-Liste (inkl. Fallback) verwenden, keine neue direkte `freigeber1_id`/`stellvertreter1_id`-Prüfung.
- Der Teilbetrag wird in allen drei Fällen sofort auf dem Kind-Job gespeichert — bei einem Pool-Hinweis-Teil muss die zuständige Person ihn nicht erneut eintippen.
- Mail-Texte für die Eskalations- und Hinweis-Fälle sind wortgleich mit den bereits bestehenden Mails aus der normalen Kontierung bzw. dem Zurück-in-Pool-Flow (siehe Task 2, Schritt 3) — keine neuen Formulierungen erfinden.

---

## Task 1: `createSplitJob` unterstützt Pool-Hinweis-Teile ohne Konto

**Files:**
- Modify: `src/db/jobsRepo.js:557-582` (`createSplitJob`)
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Produces: `createSplitJob(db, parentJob, { pdfPfad, thumbnailPfad, kontoId, hinweisKontoId, betrag, zugewiesenAn })` — `kontoId`+`zugewiesenAn` und `hinweisKontoId` sind gegenseitig exklusiv (genau eines der beiden Paare wird übergeben). Ist `kontoId` gesetzt, ist der neue Job-Status `'zugewiesen'`; sonst `'unzugewiesen'`. Rückgabewert unverändert: die neue `jobs.id` als Number.

- [ ] **Step 1: Failing Unit-Tests schreiben**

In `test/unit/jobsRepo.test.js`, direkt nach dem bestehenden Test `'createSplitJob creates an independent job carrying over the parent's shared fields, and listSplitKinder finds it'` (endet auf `db.close();\n});` vor dem `setQrDaten`-Test) einfügen:

```javascript
test('createSplitJob with hinweisKontoId (no kontoId) creates an unzugewiesen job carrying the hint, not a real Konto', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const fremdKontoId = createKonto(db, { kontonummer: '4200', bezeichnung: 'Kinderbereich', freigeber1Id: '3', stellvertreter1Id: '4', freigeber2Id: '1', stellvertreter2Id: '2' });
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  updateKontierungMetadaten(db, parentId, { absender: 'lief@example.org', betrag: '200.00', zahlungsziel: '2026-09-01', rechnungsnummer: 'RE-1', lieferant: 'Muster AG', debitorId: null });
  const parentJob = getJobById(db, parentId);

  const kindId = createSplitJob(db, parentJob, { pdfPfad: '/tmp/split-b.pdf', thumbnailPfad: null, hinweisKontoId: fremdKontoId, betrag: '100.00' });
  const kind = getJobById(db, kindId);

  assert.equal(kind.status, 'unzugewiesen');
  assert.equal(kind.konto_id, null);
  assert.equal(kind.zugewiesen_an, null);
  assert.equal(kind.hinweis_konto_id, fremdKontoId);
  assert.equal(kind.betrag, '100.00');
  assert.equal(kind.aufgesplittet_von, parentId);
  db.close();
});

test('createSplitJob with kontoId still behaves exactly as before (regression: no hinweis_konto_id set)', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  updateKontierungMetadaten(db, parentId, { absender: 'lief@example.org', betrag: '200.00', zahlungsziel: '2026-09-01', rechnungsnummer: 'RE-1', lieferant: 'Muster AG', debitorId: null });
  const parentJob = getJobById(db, parentId);

  const kindId = createSplitJob(db, parentJob, { pdfPfad: '/tmp/split-a.pdf', thumbnailPfad: null, kontoId, betrag: '100.00', zugewiesenAn: '1' });
  const kind = getJobById(db, kindId);

  assert.equal(kind.status, 'zugewiesen');
  assert.equal(kind.konto_id, kontoId);
  assert.equal(kind.zugewiesen_an, '1');
  assert.equal(kind.hinweis_konto_id, null);
  db.close();
});
```

- [ ] **Step 2: RED bestätigen**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: Der erste neue Test schlägt fehl (`hinweis_konto_id` bleibt `null` bzw. `createSplitJob` wirft, da `hinweisKontoId` nicht in der Signatur existiert und `kontoId` `undefined` in die NOT-NULL-freie, aber bislang immer gesetzte Spalte eingefügt wird). Der zweite Test (Regression) sollte bereits grün sein — das bestätigt, dass er nichts Neues testet, nur die Ausgangslage absichert.

- [ ] **Step 3: `createSplitJob` implementieren**

In `src/db/jobsRepo.js`, den kompletten bestehenden Funktionskörper (Zeilen 557-582) ersetzen durch:

```javascript
export function createSplitJob(db, parentJob, { pdfPfad, thumbnailPfad, kontoId, hinweisKontoId, betrag, zugewiesenAn }) {
  const status = kontoId ? 'zugewiesen' : 'unzugewiesen';
  const result = db
    .prepare(
      `INSERT INTO jobs (
         eingang_am, quelle, absender, dateiname, pdf_pfad, thumbnail_pfad, status,
         konto_id, zugewiesen_an, hinweis_konto_id, betrag, zahlungsziel, rechnungsnummer, lieferant, debitor_id, aufgesplittet_von
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      parentJob.eingang_am,
      parentJob.quelle,
      parentJob.absender,
      parentJob.dateiname,
      pdfPfad,
      thumbnailPfad ?? null,
      status,
      kontoId ?? null,
      zugewiesenAn ?? null,
      hinweisKontoId ?? null,
      betrag,
      parentJob.zahlungsziel,
      parentJob.rechnungsnummer,
      parentJob.lieferant,
      parentJob.debitor_id,
      parentJob.id
    );
  return Number(result.lastInsertRowid);
}
```

- [ ] **Step 4: GREEN bestätigen**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: Alle Tests in dieser Datei grün, inklusive der zwei neuen und des bestehenden `createSplitJob`-Tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat: createSplitJob supports hinweis_konto_id for split parts on unowned Konten"
```

---

## Task 2: Aufsplitten-Route — Pro-Zeile-Entscheidung, Eskalation, Pool-Hinweis

**Files:**
- Modify: `src/routes/kontierung.js:443-564` (`renderAufsplittenForm`, `GET /:id/aufsplitten`, `POST /:id/aufsplitten`)
- Test: `test/integration/kontierung.test.js`

**Interfaces:**
- Consumes: `createSplitJob(db, parentJob, { pdfPfad, thumbnailPfad, kontoId, hinweisKontoId, betrag, zugewiesenAn })` aus Task 1; `listKonten(db)` (bereits importiert, liefert alle aktiven Konten); `eskalierenFreigabe1(db, jobId, { eskaliertVon, grund, stellvertreterId })` (bestehend, unverändert).
- Produces: `renderAufsplittenForm(req, res, status, job, konten, alleKonten, gesamtbetrag, teile, begruendung, errors)` — neue Signatur, zwei zusätzliche Parameter (`alleKonten`, `begruendung`) gegenüber heute. `teile`-Array-Elemente tragen neu auch `interessenskonflikt: boolean`. Task 3 (View) konsumiert diese Locals.

### Schritt 1: Bestehenden Test ersetzen, neue Tests hinzufügen

- [ ] **Bestehenden Test `'POST /kontierung/:id/aufsplitten rejects a Konto the person is not authorized on'` in `test/integration/kontierung.test.js` komplett ersetzen** durch:

```javascript
test('POST /kontierung/:id/aufsplitten sends a part on a Konto the person is not authorized on to the Pool with a Konto-Hinweis, instead of rejecting the whole split', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const { id, kontoId } = seedJobMitDateien(db, jobsDir, { betrag: '200.00' });
  upsertPerson(db, { id: '5', vorname: 'Kinder', nachname: 'Bereich', email: 'kinder@example.org', gruppen: ['10'], loggedInNow: true });
  const fremdKontoId = createKonto(db, { kontonummer: '4200', bezeichnung: 'Kinderbereich', freigeber1Id: '5', stellvertreter1Id: '5', freigeber2Id: '5', stellvertreter2Id: '5' });
  const mailer = createStubMailer();
  const app = buildTestAppMitDateien(db, mailer, jobsDir);

  const res = await request(app)
    .post(`/kontierung/${id}/aufsplitten`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      gesamtbetrag: '200.00',
      teilKontoId: [String(kontoId), String(fremdKontoId)],
      teilBetrag: ['100.00', '100.00'],
    });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');

  const kinder = listSplitKinder(db, id);
  assert.equal(kinder.length, 2);
  const eigenerTeil = kinder.find((k) => k.konto_id === kontoId);
  const fremderTeil = kinder.find((k) => k.konto_id === null);

  assert.ok(eigenerTeil, 'the own-Konto part should still be created with a real Konto');
  assert.equal(eigenerTeil.status, 'freigabe2', 'still self-approved as before');

  assert.ok(fremderTeil, 'the foreign-Konto part should be created without a Konto');
  assert.equal(fremderTeil.status, 'unzugewiesen');
  assert.equal(fremderTeil.hinweis_konto_id, fremdKontoId);
  assert.equal(fremderTeil.betrag, '100.00');
  assert.equal(fremderTeil.zugewiesen_an, null);

  const hinweisMail = mailer.sent.find((m) => m.to === 'kinder@example.org');
  assert.ok(hinweisMail, "the foreign Konto's Freigeber1 must be notified");
  assert.match(hinweisMail.text, /4200 — Kinderbereich/);
  db.close();
});
```

- [ ] **Neue Tests direkt danach einfügen:**

```javascript
test('POST /kontierung/:id/aufsplitten escalates a part with a declared Interessenskonflikt to that Konto\'s Stellvertretung', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const { id, kontoId } = seedJobMitDateien(db, jobsDir, { betrag: '200.00' }); // stellvertreter1Id: '2'
  const mailer = createStubMailer();
  const app = buildTestAppMitDateien(db, mailer, jobsDir);

  const res = await request(app)
    .post(`/kontierung/${id}/aufsplitten`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      gesamtbetrag: '200.00',
      teilKontoId: [String(kontoId), String(kontoId)],
      teilBetrag: ['120.00', '80.00'],
      teilInteressenskonflikt: ['false', 'true'],
      begruendung: 'Befangen beim zweiten Teil',
    });

  assert.equal(res.status, 302);
  const kinder = listSplitKinder(db, id);
  assert.equal(kinder.length, 2);
  const normal = kinder.find((k) => k.betrag === '120.00');
  const eskaliert = kinder.find((k) => k.betrag === '80.00');

  assert.equal(normal.status, 'freigabe2');

  assert.equal(eskaliert.status, 'zugewiesen', 'still needs Freigabe 1 from the Stellvertretung');
  assert.equal(eskaliert.konto_id, kontoId);
  assert.equal(eskaliert.zugewiesen_an, '2');
  assert.equal(eskaliert.freigabe1_eskaliert_von, '1');
  assert.equal(eskaliert.freigabe1_eskalationsgrund, 'Befangen beim zweiten Teil');

  const mail = mailer.sent.find((m) => m.to === 'p2@example.org');
  assert.ok(mail, 'the Stellvertretung must be notified');
  assert.match(mail.text, /Interessenskonflikt/);
  db.close();
});

test('POST /kontierung/:id/aufsplitten requires a Begründung when any Zeile declares an Interessenskonflikt', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const { id, kontoId } = seedJobMitDateien(db, jobsDir, { betrag: '200.00' });
  const app = buildTestAppMitDateien(db, createStubMailer(), jobsDir);

  const res = await request(app)
    .post(`/kontierung/${id}/aufsplitten`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      gesamtbetrag: '200.00',
      teilKontoId: [String(kontoId), String(kontoId)],
      teilBetrag: ['120.00', '80.00'],
      teilInteressenskonflikt: ['false', 'true'],
      begruendung: '',
    });

  assert.equal(res.status, 400);
  assert.match(res.text, /Bei einem Interessenskonflikt ist eine Begründung Pflicht\./);
  assert.equal(listSplitKinder(db, id).length, 0);
  db.close();
});

test('POST /kontierung/:id/aufsplitten handles all three outcomes in a single mixed split', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const { id, kontoId } = seedJobMitDateien(db, jobsDir, { betrag: '300.00' }); // freigeber1Id: '1', stellvertreter1Id: '2'
  upsertPerson(db, { id: '5', vorname: 'Kinder', nachname: 'Bereich', email: 'kinder@example.org', gruppen: ['10'], loggedInNow: true });
  const fremdKontoId = createKonto(db, { kontonummer: '4200', bezeichnung: 'Kinderbereich', freigeber1Id: '5', stellvertreter1Id: '5', freigeber2Id: '5', stellvertreter2Id: '5' });
  const mailer = createStubMailer();
  const app = buildTestAppMitDateien(db, mailer, jobsDir);

  const res = await request(app)
    .post(`/kontierung/${id}/aufsplitten`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      gesamtbetrag: '300.00',
      teilKontoId: [String(kontoId), String(kontoId), String(fremdKontoId)],
      teilBetrag: ['100.00', '100.00', '100.00'],
      teilInteressenskonflikt: ['false', 'true', 'false'],
      begruendung: 'Befangen beim zweiten Teil',
    });

  assert.equal(res.status, 302);
  const kinder = listSplitKinder(db, id);
  assert.equal(kinder.length, 3);

  const selbst = kinder.find((k) => k.konto_id === kontoId && k.status === 'freigabe2');
  const eskaliert = kinder.find((k) => k.konto_id === kontoId && k.status === 'zugewiesen');
  const fremd = kinder.find((k) => k.konto_id === null);

  assert.ok(selbst, 'self-approved part');
  assert.ok(eskaliert, 'escalated part');
  assert.equal(eskaliert.zugewiesen_an, '2');
  assert.ok(fremd, 'foreign-Konto part');
  assert.equal(fremd.hinweis_konto_id, fremdKontoId);
  assert.equal(fremd.status, 'unzugewiesen');

  assert.equal(mailer.sent.length, 3, 'one mail per non-trivial outcome: Freigabe2, Stellvertretung, and Konto-Hinweis');
  db.close();
});

test('POST /kontierung/:id/aufsplitten lets an admin-escalated Portal-Admin still self-approve a part on the job\'s originally-assigned Konto, despite holding no role there', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const kontoId = seedKontoAndPersonen(db); // freigeber1Id:'1', stellvertreter1Id:'2', freigeber2Id:'3', stellvertreter2Id:'4'
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const pdfPfad = join(jobsDir, `original-${Date.now()}.pdf`);
  writeFileSync(pdfPfad, '%PDF-1.4\n%test\n');
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '2', konto_id = ?, betrag = '200.00', freigabe1_eskaliert_an_admin = 1 WHERE id = ?").run(kontoId, id);
  const mailer = createStubMailer();
  const app = buildTestAppMitDateien(db, mailer, jobsDir);

  const res = await request(app)
    .post(`/kontierung/${id}/aufsplitten`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({
      gesamtbetrag: '200.00',
      teilKontoId: [String(kontoId), String(kontoId)],
      teilBetrag: ['120.00', '80.00'],
    });

  assert.equal(res.status, 302, "the admin should be able to self-approve the job's own already-assigned Konto, not have it treated as foreign");
  const kinder = listSplitKinder(db, id);
  assert.equal(kinder.length, 2);
  for (const kind of kinder) {
    assert.equal(kind.konto_id, kontoId, 'must NOT fall back to the foreign-Konto pool path');
    assert.equal(kind.status, 'freigabe2');
  }
  db.close();
});
```

- [ ] **Step 2: RED bestätigen**

Run: `node --test test/integration/kontierung.test.js`
Expected: Die fünf neuen/ersetzten Tests schlagen fehl (heute wird jede Zeile mit einem fremden Konto pauschal mit 400 abgelehnt, es gibt keine `teilInteressenskonflikt`-Verarbeitung, keine Begründungs-Pflicht-Prüfung). Alle anderen Tests in der Datei bleiben grün.

### Schritt 2: `renderAufsplittenForm` + `GET /:id/aufsplitten` anpassen

- [ ] Den bestehenden Block

```javascript
  function renderAufsplittenForm(req, res, status, job, konten, gesamtbetrag, teile, errors) {
    res.status(status).render('kontierung-aufsplitten', { job, konten, gesamtbetrag, teile, errors });
  }

  router.get('/:id/aufsplitten', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const konten = ladeKontenFuerJob(req, job);
    renderAufsplittenForm(req, res, 200, job, konten, job.betrag || '', [
      { kontoId: '', betrag: '' },
      { kontoId: '', betrag: '' },
    ], []);
  });
```

ersetzen durch:

```javascript
  function renderAufsplittenForm(req, res, status, job, konten, alleKonten, gesamtbetrag, teile, begruendung, errors) {
    res.status(status).render('kontierung-aufsplitten', { job, konten, alleKonten, gesamtbetrag, teile, begruendung, errors });
  }

  router.get('/:id/aufsplitten', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const konten = ladeKontenFuerJob(req, job);
    renderAufsplittenForm(req, res, 200, job, konten, listKonten(db), job.betrag || '', [
      { kontoId: '', betrag: '', interessenskonflikt: false },
      { kontoId: '', betrag: '', interessenskonflikt: false },
    ], '', []);
  });
```

### Schritt 3: `POST /:id/aufsplitten` umbauen

- [ ] Den kompletten bestehenden Handler (von `router.post('/:id/aufsplitten', async (req, res, next) => {` bis zu dessen schliessendem `});`, direkt vor `return router;`) ersetzen durch:

```javascript
  router.post('/:id/aufsplitten', async (req, res, next) => {
    try {
      const job = loadAuthorizedJob(req, res);
      if (!job) return;
      const konten = ladeKontenFuerJob(req, job);
      const alleKonten = listKonten(db);

      const gesamtbetrag = req.body.gesamtbetrag || '';
      const kontoIds = [].concat(req.body.teilKontoId || []);
      const betraege = [].concat(req.body.teilBetrag || []);
      const konflikte = [].concat(req.body.teilInteressenskonflikt || []);
      const begruendung = req.body.begruendung || '';
      const teileEingabe = kontoIds.map((kontoId, i) => ({
        kontoId,
        betrag: betraege[i] || '',
        interessenskonflikt: konflikte[i] === 'true',
      }));

      const errors = [];
      if (!gesamtbetrag || !BETRAG_PATTERN.test(gesamtbetrag)) {
        errors.push('Bitte einen gültigen Gesamtbetrag erfassen (z.B. 200.00).');
      }
      if (teileEingabe.filter((t) => t.kontoId || t.betrag).length < 2) {
        errors.push('Mindestens zwei Teilbeträge sind nötig, um aufzusplitten.');
      }

      const aufgeloesteTeile = [];
      for (const teil of teileEingabe) {
        if (!teil.kontoId && !teil.betrag) continue;
        const konto = alleKonten.find((k) => String(k.id) === teil.kontoId);
        if (!konto) {
          errors.push('Bitte für jede Zeile ein gültiges Konto auswählen.');
          continue;
        }
        if (!teil.betrag || !BETRAG_PATTERN.test(teil.betrag)) {
          errors.push('Jede Zeile braucht einen gültigen Betrag (z.B. 123.45).');
          continue;
        }
        aufgeloesteTeile.push({ konto, betrag: teil.betrag.replace(',', '.'), interessenskonflikt: teil.interessenskonflikt });
      }

      if (errors.length === 0) {
        const summe = aufgeloesteTeile.reduce((sum, t) => sum + Number(t.betrag), 0);
        const original = Number(gesamtbetrag.replace(',', '.'));
        if (Math.abs(summe - original) > 0.005) {
          errors.push(`Die Summe der Teilbeträge (${summe.toFixed(2)}) muss dem Gesamtbetrag (${original.toFixed(2)}) entsprechen.`);
        }
      }

      // Nur Zeilen auf eigenen Konten (in `konten`, inkl. des Admin-Eskalations-Fallbacks aus
      // ladeKontenFuerJob) können überhaupt einen Interessenskonflikt haben — für ein fremdes
      // Konto ist die Checkbox bedeutungslos, siehe Design-Spec.
      const hatKonflikt = aufgeloesteTeile.some((t) => t.interessenskonflikt && konten.some((k) => k.id === t.konto.id));
      if (hatKonflikt && !begruendung) {
        errors.push('Bei einem Interessenskonflikt ist eine Begründung Pflicht.');
      }

      if (errors.length > 0) {
        return renderAufsplittenForm(req, res, 400, job, konten, alleKonten, gesamtbetrag, teileEingabe, begruendung, errors);
      }

      // Persisted on the parent even though it's about to be retired: the parent may never have
      // had a Betrag saved before (that's exactly the gap this Gesamtbetrag field closes), and
      // its own record should reflect the real total the split was based on, not stay empty.
      job.betrag = gesamtbetrag.replace(',', '.');

      db.exec('BEGIN');
      const selbstFreigegeben = [];
      const eskaliert = [];
      const fremdeKonten = [];
      try {
        setJobBetrag(db, job.id, job.betrag);
        const markiert = markJobAufgesplittet(db, job.id);
        if (!markiert) {
          db.exec('ROLLBACK');
          return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
        }
        for (const teil of aufgeloesteTeile) {
          const pdfPfad = neuerDateipfad(config.jobsDir, job.pdf_pfad);
          const thumbnailPfad = job.thumbnail_pfad ? neuerDateipfad(config.jobsDir, job.thumbnail_pfad) : null;
          const istEigenesKonto = konten.some((k) => k.id === teil.konto.id);

          if (!istEigenesKonto) {
            const kindId = createSplitJob(db, job, {
              pdfPfad,
              thumbnailPfad,
              hinweisKontoId: teil.konto.id,
              betrag: teil.betrag,
            });
            fremdeKonten.push({ id: kindId, konto: teil.konto });
            continue;
          }

          const kindId = createSplitJob(db, job, {
            pdfPfad,
            thumbnailPfad,
            kontoId: teil.konto.id,
            betrag: teil.betrag,
            zugewiesenAn: req.currentPerson.churchtools_person_id,
          });

          if (teil.interessenskonflikt) {
            eskalierenFreigabe1(db, kindId, {
              eskaliertVon: req.currentPerson.churchtools_person_id,
              grund: begruendung,
              stellvertreterId: teil.konto.stellvertreter1_id,
            });
            createFreigabe(db, {
              jobId: kindId,
              personId: req.currentPerson.churchtools_person_id,
              rolle: 'freigabe1_eskalation',
              zeitpunkt: new Date().toISOString(),
              ip: req.ip,
              interessenskonflikt: true,
              kommentar: begruendung,
              eskaliertVon: null,
            });
            eskaliert.push({ id: kindId, konto: teil.konto });
          } else {
            createFreigabe(db, {
              jobId: kindId,
              personId: req.currentPerson.churchtools_person_id,
              rolle: 'freigeber1',
              zeitpunkt: new Date().toISOString(),
              ip: req.ip,
              interessenskonflikt: false,
              kommentar: null,
              eskaliertVon: null,
            });
            abschliessenFreigabe1(db, kindId);
            selbstFreigegeben.push({ id: kindId, konto: teil.konto });
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      for (const { id: kindId, konto } of selbstFreigegeben) {
        const kindJob = getJobById(db, kindId);
        const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(kindJob, konto));
        if (freigeber2) {
          await sendNotification(db, mailer, {
            to: freigeber2.email,
            subject: 'Freigabeportal: Neue Rechnung zur Freigabe 2',
            text: `Eine Rechnung wartet auf deine Freigabe 2: ${kindJob.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${kindJob.id}`,
            typ: 'zuweisung',
            jobId: kindJob.id,
          });
        }
      }

      for (const { id: kindId, konto } of eskaliert) {
        const stellvertreter1 = getPersonById(db, konto.stellvertreter1_id);
        if (stellvertreter1) {
          await sendNotification(db, mailer, {
            to: stellvertreter1.email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – Kontierung an dich übergeben',
            text: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${kindId}`,
            typ: 'zuweisung',
            jobId: kindId,
          });
        }
      }

      for (const { id: kindId, konto } of fremdeKonten) {
        const freigeber1 = getPersonById(db, konto.freigeber1_id);
        if (freigeber1) {
          await sendNotification(db, mailer, {
            to: freigeber1.email,
            subject: 'Freigabeportal: Rechnung vermutlich für dein Konto — bitte aus dem Pool holen',
            text: `Eine Rechnung wurde mit dem Hinweis in den Pool zurückgelegt, dass sie vermutlich für dein Konto ${konto.kontonummer} — ${konto.bezeichnung} bestimmt ist: ${job.dateiname}\n\nBitte im Freigabeportal anmelden und aus dem Pool holen: ${config.publicBaseUrl}/pool`,
            typ: 'zuweisung',
            jobId: kindId,
          });
        }
      }

      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  });
```

- [ ] **Step 4: GREEN bestätigen**

Run: `node --test test/integration/kontierung.test.js`
Expected: Alle Tests grün, inklusive der fünf neuen/ersetzten. (Die View wurde in diesem Task bewusst noch nicht angepasst — das ist unproblematisch: alle hier hinzugefügten Tests prüfen entweder den Erfolgspfad, der ohne `res.render` direkt zu `/pool` redirected, oder den 400-Begründungs-Fehlerpfad, dessen Fehlermeldung bereits über die bestehende, generische `<% errors.forEach %>`-Schleife im Formular gerendert wird — EJS ignoriert zusätzliche, nicht referenzierte Locals wie `alleKonten`/`begruendung` klaglos.)

- [ ] **Step 5: Gesamte Suite laufen lassen**

Run: `npm test`
Expected: Alle Tests grün, keine Regressionen in anderen Dateien.

- [ ] **Step 6: Commit**

```bash
git add src/routes/kontierung.js test/integration/kontierung.test.js
git commit -m "feat: aufsplitten routes parts on unowned Konten to the Pool, escalates own-Konto conflicts to the Stellvertretung"
```

---

## Task 3: Aufsplitten-Formular — alle Konten wählbar, Interessenskonflikt-Checkbox, Begründung

**Files:**
- Modify: `views/kontierung-aufsplitten.ejs`
- Test: `test/integration/kontierung.test.js`

**Interfaces:**
- Consumes: Locals aus Task 2 — `alleKonten` (Array von Konten fürs Dropdown), `konten` (unverändert, nur noch intern ungenutzt in der View selbst), `teile` (Array mit `{kontoId, betrag, interessenskonflikt}`), `begruendung` (String), `errors` (Array), `job`, `gesamtbetrag`.

- [ ] **Step 1: Failing Test schreiben**

In `test/integration/kontierung.test.js`, direkt vor dem Test `'POST /kontierung/:id/aufsplitten creates independent split jobs...'` einfügen:

```javascript
test('GET /kontierung/:id/aufsplitten lists every active Konto, not just this person\'s own, and offers an Interessenskonflikt checkbox per Zeile plus a shared Begründung field', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const { id } = seedJobMitDateien(db, jobsDir, { betrag: '200.00' });
  upsertPerson(db, { id: '5', vorname: 'Kinder', nachname: 'Bereich', email: 'kinder@example.org', gruppen: ['10'], loggedInNow: true });
  createKonto(db, { kontonummer: '4200', bezeichnung: 'Kinderbereich', freigeber1Id: '5', stellvertreter1Id: '5', freigeber2Id: '5', stellvertreter2Id: '5' });
  const app = buildTestAppMitDateien(db, createStubMailer(), jobsDir);

  const res = await request(app).get(`/kontierung/${id}/aufsplitten`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /4200 — Kinderbereich/, 'a Konto this person has no role on must still be selectable');
  assert.match(res.text, /class="[^"]*konflikt-checkbox/);
  assert.match(res.text, /name="teilInteressenskonflikt"/);
  assert.match(res.text, /name="begruendung"/);
  db.close();
});
```

- [ ] **Step 2: RED bestätigen**

Run: `node --test test/integration/kontierung.test.js`
Expected: Der neue Test schlägt fehl — `konten` (nicht `alleKonten`) enthält "4200 — Kinderbereich" heute nicht, und `konflikt-checkbox`/`teilInteressenskonflikt`/`begruendung` existieren im Formular noch nicht.

- [ ] **Step 3: View anpassen**

`views/kontierung-aufsplitten.ejs` komplett durch folgenden Inhalt ersetzen:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Rechnung aufsplitten — <%= branding.seitenTitel %></title>
</head>
<body>
  <%- include('_brand_styles') %>
  <main class="container py-4">
    <h1 class="h3">Rechnung aufsplitten: <%= job.dateiname %></h1>
    <p class="text-muted">Vorgangsnummer: <%= job.id %></p>
    <% if (errors.length > 0) { %>
      <div class="alert alert-danger">
        <ul class="mb-0"><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
      </div>
    <% } %>
    <p>Jede Zeile wird zu einer eigenständigen Rechnung mit eigenem Konto und Teilbetrag. Zahlungsziel, Lieferant, Absender und Rechnungsnummer werden übernommen. Für Konten, bei denen du Freigeber oder Stellvertretung bist, gilt Freigabe 1 automatisch als durch dich erteilt — ausser du kreuzt "Konflikt" an, dann geht der Teil direkt an deine Stellvertretung. Für andere Konten landet der Teil unzugewiesen im Pool mit einem Hinweis für die zuständige Person.</p>

    <form method="post" action="/kontierung/<%= job.id %>/aufsplitten" class="col-12 col-md-10 col-lg-8">
      <div class="mb-3 col-6 col-md-4">
        <label class="form-label" for="gesamtbetrag">Gesamtbetrag</label>
        <input type="text" inputmode="decimal" class="form-control" id="gesamtbetrag" name="gesamtbetrag" value="<%= gesamtbetrag %>" placeholder="z.B. 200.00" required>
        <div class="form-text">Die Teilbeträge unten müssen exakt diese Summe ergeben.</div>
      </div>
      <div id="teile-container">
        <% teile.forEach((teil) => { %>
          <div class="row g-2 mb-2 align-items-center teil-zeile">
            <div class="col-5">
              <select class="form-select" name="teilKontoId">
                <option value="">— Konto wählen —</option>
                <% alleKonten.forEach((k) => { %>
                  <option value="<%= k.id %>" <%= String(k.id) === teil.kontoId ? 'selected' : '' %>><%= k.kontonummer %> — <%= k.bezeichnung %></option>
                <% }) %>
              </select>
            </div>
            <div class="col-3">
              <input type="text" inputmode="decimal" class="form-control" name="teilBetrag" value="<%= teil.betrag %>" placeholder="Teilbetrag, z.B. 61.75">
            </div>
            <div class="col-2 form-check">
              <input type="checkbox" class="form-check-input konflikt-checkbox" <%= teil.interessenskonflikt ? 'checked' : '' %>>
              <label class="form-check-label small">Konflikt</label>
              <input type="hidden" name="teilInteressenskonflikt" value="<%= teil.interessenskonflikt ? 'true' : 'false' %>">
            </div>
            <div class="col-2">
              <button type="button" class="btn btn-outline-danger btn-sm zeile-entfernen">Entfernen</button>
            </div>
          </div>
        <% }) %>
      </div>
      <button type="button" id="zeile-hinzufuegen" class="btn btn-outline-secondary btn-sm mb-3">+ Teilbetrag hinzufügen</button>
      <div class="mb-3">
        <label class="form-label" for="begruendung">Begründung <span class="text-muted">(bei mind. einem Interessenskonflikt Pflicht)</span></label>
        <textarea class="form-control" id="begruendung" name="begruendung"><%= begruendung || '' %></textarea>
      </div>
      <div class="d-flex flex-wrap gap-2">
        <button type="submit" class="btn btn-primary">Aufsplitten</button>
        <a href="/kontierung/<%= job.id %>" id="abbrechen-link" class="btn btn-outline-secondary">Abbrechen</a>
      </div>
    </form>
  </main>
  <script>
    (function () {
      // Reached both standalone (direct navigation) and embedded in an <iframe> inside a Bootstrap
      // modal on kontierung.ejs. Embedded, "Abbrechen" must close the modal, not navigate the
      // iframe to a full standalone page — there's no way to reach the parent's Bootstrap modal
      // API directly (different document), so this posts a message the parent listens for instead.
      if (window.parent !== window) {
        document.getElementById('abbrechen-link').addEventListener('click', function (e) {
          e.preventDefault();
          window.parent.postMessage('aufsplitten-abbrechen', window.location.origin);
        });
      }
    })();
    (function () {
      var kontoOptionsHtml = document.querySelector('.teil-zeile select').innerHTML;
      // The checkbox itself has no `name` and is never submitted — it only drives the hidden
      // input's value via this listener. With several dynamically added/removed rows, a shared
      // `name` on the checkboxes alone can't be parsed back into a reliable 1:1 array alongside
      // teilKontoId/teilBetrag: an unchecked checkbox sends nothing at all, so the submitted
      // array would silently shrink and misalign for any row after the first unchecked one. The
      // always-present hidden input keeps exactly one value per row, same as teilKontoId/teilBetrag.
      function konfliktCheckboxBinden(zeile) {
        var checkbox = zeile.querySelector('.konflikt-checkbox');
        var hidden = zeile.querySelector('input[name="teilInteressenskonflikt"]');
        checkbox.addEventListener('change', function () {
          hidden.value = checkbox.checked ? 'true' : 'false';
        });
      }
      function zeileEntfernenBinden(zeile) {
        zeile.querySelector('.zeile-entfernen').addEventListener('click', function () {
          zeile.remove();
        });
      }
      document.querySelectorAll('.teil-zeile').forEach(function (zeile) {
        zeileEntfernenBinden(zeile);
        konfliktCheckboxBinden(zeile);
      });
      document.getElementById('zeile-hinzufuegen').addEventListener('click', function () {
        var zeile = document.createElement('div');
        zeile.className = 'row g-2 mb-2 align-items-center teil-zeile';
        zeile.innerHTML =
          '<div class="col-5"><select class="form-select" name="teilKontoId">' + kontoOptionsHtml + '</select></div>' +
          '<div class="col-3"><input type="text" inputmode="decimal" class="form-control" name="teilBetrag" placeholder="Teilbetrag, z.B. 61.75"></div>' +
          '<div class="col-2 form-check"><input type="checkbox" class="form-check-input konflikt-checkbox"><label class="form-check-label small">Konflikt</label><input type="hidden" name="teilInteressenskonflikt" value="false"></div>' +
          '<div class="col-2"><button type="button" class="btn btn-outline-danger btn-sm zeile-entfernen">Entfernen</button></div>';
        document.getElementById('teile-container').appendChild(zeile);
        zeileEntfernenBinden(zeile);
        konfliktCheckboxBinden(zeile);
      });
    })();
  </script>
</body>
</html>
```

- [ ] **Step 4: GREEN bestätigen**

Run: `node --test test/integration/kontierung.test.js`
Expected: Alle Tests grün, inklusive des neuen GET-Markup-Tests.

- [ ] **Step 5: Gesamte Suite laufen lassen**

Run: `npm test`
Expected: Alle Tests grün.

- [ ] **Step 6: Live-Server-Sanity-Check**

Kein Playwright/Chromium in dieser Umgebung verfügbar (kein Root für die System-Abhängigkeiten) — stattdessen ein echter, laufender Server mit gemocktem ChurchTools-Login, angesprochen über echte HTTP-Requests statt in-process `supertest`. Datei `scratch-manual-check.mjs` im Repo-Root anlegen:

```javascript
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase } from './src/db/index.js';
import { upsertPerson } from './src/db/personenRepo.js';
import { createKonto } from './src/db/kontenRepo.js';
import { createJob, claimJob } from './src/db/jobsRepo.js';
import { createApp } from './src/app.js';
import { setupMockChurchTools } from './test/helpers/mockChurchTools.js';

const config = {
  sessionSecret: 'test-secret-test-secret-test-secret',
  env: 'test',
  churchtools: {
    baseUrl: 'https://ct.example.org',
    clientId: 'client-id',
    clientSecret: 'client-secret-client-secret-32c',
    redirectUri: 'https://portal.example.org/auth/callback',
    groupIdBuchhaltung: '10',
    groupIdAdmin: '20',
    syncServiceToken: 'sync-token-sync-token-sync-token',
  },
  cronSecret: 'cron-secret-cron-secret-cron-sec',
  n8nApiKey: 'n8n-key-n8n-key-n8n-key-n8n-key32',
  smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
  downloadSigningSecret: 'download-secret-download-secret',
};

const jobsDir = mkdtempSync(join(tmpdir(), 'manual-check-aufsplitten-'));
const db = openDatabase(':memory:');
const client = setupMockChurchTools(config.churchtools.baseUrl);

upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
upsertPerson(db, { id: '5', vorname: 'Kinder', nachname: 'Bereich', email: 'kinder@example.org', gruppen: ['10'], loggedInNow: false });
const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '1', stellvertreter2Id: '2' });
const kinderbereichId = createKonto(db, { kontonummer: '4200', bezeichnung: 'Kinderbereich', freigeber1Id: '5', stellvertreter1Id: '5', freigeber2Id: '5', stellvertreter2Id: '5' });
const pdfPfad = join(jobsDir, 'sammelbestellung.pdf');
writeFileSync(pdfPfad, '%PDF-1.4\n%test\n');
const jobId = createJob(db, { eingangAm: '2026-08-22T08:00:00.000Z', quelle: 'lieferant', absender: 'buchhaltung@brack.example', dateiname: 'sammelbestellung.pdf', pdfPfad });
claimJob(db, jobId, '1');

const app = createApp({ db, config: { ...config, jobsDir } });

client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok-1' });
client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id: 1, firstName: 'Frei', lastName: 'Geber', email: 'f1@example.org' });
client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

const agent = request.agent(app);
const loginRes = await agent.get('/auth/login');
const state = new URL(loginRes.headers.location).searchParams.get('state');
const callbackRes = await agent.get('/auth/callback').query({ code: 'code-1', state });
if (callbackRes.status !== 302) throw new Error(`login failed: ${callbackRes.status}`);
const cookieHeader = callbackRes.headers['set-cookie'][0].split(';')[0];

const server = app.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log('SERVER_URL=http://127.0.0.1:' + port);
  console.log('COOKIE=' + cookieHeader);
  console.log('AUFSPLITTEN_URL=http://127.0.0.1:' + port + '/kontierung/' + jobId + '/aufsplitten');
  console.log('KONTO=3000 (id ' + kontoId + '), KINDERBEREICH=4200 (id ' + kinderbereichId + ')');
  console.log('READY');
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
```

Ausführen und Ergebnis notieren:

```bash
node scratch-manual-check.mjs > /tmp/aufsplitten-manual-check.log 2>&1 &
sleep 2
cat /tmp/aufsplitten-manual-check.log
```

Aus der Ausgabe `COOKIE=...`, `AUFSPLITTEN_URL=...` und die IDs entnehmen, dann (Platzhalter `$COOKIE`, `$URL`, `$KONTO_ID`, `$KINDERBEREICH_ID` durch die tatsächlichen Werte ersetzen):

```bash
curl -s -b "$COOKIE" "$URL" -o /tmp/aufsplitten-page.html -w "status=%{http_code}\n"
grep -o '4200 — Kinderbereich' /tmp/aufsplitten-page.html
grep -c 'konflikt-checkbox' /tmp/aufsplitten-page.html
grep -o 'name="begruendung"' /tmp/aufsplitten-page.html

curl -s -b "$COOKIE" -X POST "$URL" \
  -d "gesamtbetrag=300.00" \
  -d "teilKontoId=$KONTO_ID&teilBetrag=100.00&teilInteressenskonflikt=false" \
  -d "teilKontoId=$KONTO_ID&teilBetrag=100.00&teilInteressenskonflikt=true" \
  -d "teilKontoId=$KINDERBEREICH_ID&teilBetrag=100.00&teilInteressenskonflikt=false" \
  -d "begruendung=Sammelbestellung, ein Teil für Kinderbereich" \
  -w "\nstatus=%{http_code}\n" -D - -o /dev/null | grep -i "location\|status"
```

Erwartet: `status=200` für den GET-Request mit allen drei Markup-Treffern; `status=302` mit `Location: /pool` für den POST-Request. Anschliessend das ausgelieferte `<script>` aus `/tmp/aufsplitten-page.html` mit einem kleinen Python- oder Node-Snippet extrahieren (regex `/<script>(.*?)<\/script>/gs`) und mit `node --check` auf Syntaxfehler prüfen. Danach den Server beenden (`kill %1`) und `scratch-manual-check.mjs` wieder löschen (`rm scratch-manual-check.mjs`) — nicht committen.

- [ ] **Step 7: Commit**

```bash
git add views/kontierung-aufsplitten.ejs test/integration/kontierung.test.js
git commit -m "feat: aufsplitten form offers every active Konto, an Interessenskonflikt checkbox per Zeile, and a shared Begründung field"
```

---

## Selbst-Review-Notiz (bereits durchgeführt beim Schreiben dieses Plans)

- **Spec-Abdeckung:** Alle drei Fälle aus der Design-Spec-Tabelle (selbst freigegeben / an Stellvertretung eskaliert / fremdes Konto) sind in Task 2 abgedeckt. Der Admin-Sonderfall aus der Spec ("Pro-Zeile-Ergebnismodell") hat einen eigenen Test in Task 2. Formular-Änderungen aus der Spec (alle Konten, Checkbox, gemeinsames Begründungsfeld, Copy-Änderungen, Button-Text) sind vollständig in Task 3. Benachrichtigungen aus der Spec sind in Task 2, Schritt 3, mit den exakten, wiederverwendeten Mail-Texten umgesetzt.
- **Keine Platzhalter:** Alle Code-Blöcke sind vollständig, keine "TODO"/"ähnlich wie oben".
- **Typkonsistenz:** `createSplitJob`s neue Signatur aus Task 1 stimmt mit ihrer Verwendung in Task 2, Schritt 3, überein (`hinweisKontoId`, `kontoId`/`zugewiesenAn` optional). `renderAufsplittenForm`s neue Signatur aus Task 2, Schritt 2, stimmt mit ihrer Verwendung in Task 2, Schritt 3 (Fehlerpfad) überein. Die View in Task 3 konsumiert exakt die Locals, die Task 2 produziert (`alleKonten`, `begruendung`, `teil.interessenskonflikt`).
