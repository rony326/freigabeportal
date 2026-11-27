// Aufsplitten-Assistent auf der Kontierungsseite (views/_aufsplitten_assistent.ejs): öffnet und schliesst ihn neben dem
// Beleg ohne Neuladen (dabei Übernahme der Werte aus dem Kontierungsformular), führt durch die drei Schritte mit
// laufender Restanzeige und Zusammenfassung, verwaltet die Teil-Zeilen und benennt Konflikt-Kennzeichen und Belegdateien
// so, dass der Server sie der richtigen Zeile zuordnet. Der Server rechnet und prüft verbindlich
// (routes/kontierung.js) – alles hier ist Vorschau und frühe Rückmeldung. Ohne Skript stehen alle Schritte untereinander.
(function () {
  // Gleiches Zahlenformat wie auf dem Server (BETRAG_PATTERN), Eingaben getrimmt.
  var BETRAG = /^\d+([.,]\d{1,2})?$/;

  /** @returns {number|null} Betrag in ganzen Rappen, null bei leerer oder ungültiger Eingabe */
  function rappen(text) {
    var t = String(text).trim();
    return BETRAG.test(t) ? Math.round(Number(t.replace(',', '.')) * 100) : null;
  }

  /** Versandanteile in Rappen, gleiche Regel wie verteileVersandkosten (services/aufsplitten.js): Rest an den letzten Teil. */
  function verteile(versandRappen, anzahl) {
    var anteil = Math.floor(versandRappen / anzahl);
    return Array.from({ length: anzahl }, function (_, i) {
      return i === anzahl - 1 ? versandRappen - anteil * (anzahl - 1) : anteil;
    });
  }

  /**
   * Stand der Verteilung in Rappen: Ziel = Gesamtbetrag minus Versandkosten (leer oder ungültig = 0), leere oder
   * ungültige Teilbeträge zählen nicht.
   * @returns {{ziel: number, verteilt: number, offen: number}|null} null bei ungültigem Gesamtbetrag
   */
  function stand(gesamt, versand, teile) {
    var gesamtRappen = rappen(gesamt);
    if (gesamtRappen === null) return null;
    var ziel = gesamtRappen - (rappen(versand) || 0);
    var verteilt = teile.reduce(function (summe, teil) { return summe + (rappen(teil) || 0); }, 0);
    return { ziel: ziel, verteilt: verteilt, offen: ziel - verteilt };
  }

  // Reine Rechenlogik in Node getestet: test/unit/aufsplittenAssistent.test.js.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { rappen: rappen, verteile: verteile, stand: stand };
    return;
  }

  var form = document.getElementById('aufsplitten-form');
  if (!form) return;
  var bereich = document.getElementById('aufsplitten-bereich');
  var kontierungBereich = document.getElementById('kontierung-bereich');
  var kontierung = document.getElementById('kontierung-form');
  var banner = bereich.querySelector('[data-pflicht-banner="aufsplitten-form"]');
  var zeilen = form.querySelector('#teile-container');
  var vorlage = form.querySelector('#split-zeile-vorlage');
  var gesamt = form.querySelector('#gesamtbetrag');
  var versand = form.querySelector('#versandkosten');
  var begruendung = form.querySelector('#split-begruendung');
  var standAnzeige = form.querySelector('#split-stand');
  var zusammenfassung = form.querySelector('#split-zusammenfassung');
  var kopf = form.querySelector('#split-kopf');
  var zurueckKnopf = form.querySelector('#split-zurueck');
  var weiterKnopf = form.querySelector('#split-weiter');
  var schritt = 1;

  function franken(r) { return (r / 100).toFixed(2); }

  // Die Felder einer Zeile; «ausgefüllt» wie auf dem Server: Zeilen ohne Konto und ohne Betrag zählen nicht.
  function alleZeilen() {
    return Array.prototype.map.call(zeilen.querySelectorAll('.teil-zeile'), function (element, i) {
      var konto = element.querySelector('select[name="teilKontoId"]');
      var betrag = element.querySelector('input[name="teilBetrag"]');
      var option = konto.options[konto.selectedIndex];
      var datei = element.querySelector('.teil-beleg-input');
      var angekreuzt = element.querySelector('.konflikt-checkbox').checked;
      return {
        nummer: i + 1,
        konto: konto,
        betrag: betrag,
        kontoText: konto.value && option ? option.textContent.trim() : '',
        angekreuzt: angekreuzt,
        // Ein Konflikt wirkt nur bei Konten, bei denen die Person selbst Freigeber oder Stellvertretung ist.
        konflikt: angekreuzt && Boolean(option) && option.hasAttribute('data-eigenes-konto'),
        datei: datei && datei.files.length > 0 ? datei.files[0].name : '',
        ausgefuellt: Boolean(konto.value || betrag.value.trim()),
      };
    });
  }
  function ausgefuellteZeilen() { return alleZeilen().filter(function (z) { return z.ausgefuellt; }); }
  function aktuellerStand() {
    return stand(gesamt.value, versand.value, alleZeilen().map(function (z) { return z.betrag.value; }));
  }
  function offenText(offen) { return offen < 0 ? franken(-offen) + ' zu viel' : 'offen ' + franken(offen); }

  function zeigeStand() {
    var s = aktuellerStand();
    var text = s
      ? 'Verteilt ' + franken(s.verteilt) + ' von ' + franken(s.ziel) + ' – ' + offenText(s.offen)
      : 'Bitte zuerst in Schritt 1 einen gültigen Gesamtbetrag erfassen.';
    // Nur bei Änderung schreiben: die Anzeige ist aria-live.
    if (standAnzeige.textContent !== text) standAnzeige.textContent = text;
    standAnzeige.classList.toggle('text-success-emphasis', Boolean(s) && s.offen === 0);
    standAnzeige.classList.toggle('text-danger-emphasis', Boolean(s) && s.offen < 0);
  }

  // Zusammenfassung (Schritt 3): ausschliesslich über textContent, Kontonamen und Dateinamen sind fremde Daten.
  function element(tag, klasse, text) {
    var e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function baueZusammenfassung() {
    var teile = ausgefuellteZeilen();
    var anteile = verteile(rappen(versand.value) || 0, teile.length);
    var summe = 0;
    var liste = element('ul', 'list-group mb-3');
    teile.forEach(function (teil, i) {
      var netto = rappen(teil.betrag.value) || 0;
      var total = netto + anteile[i];
      summe += total;
      var li = element('li', 'list-group-item');
      li.appendChild(element('div', 'fw-semibold', teil.kontoText || 'Kein Konto gewählt'));
      var werte = element('dl', 'row g-0 mb-0');
      [['Teilbetrag ohne Versand', netto, ''], ['Versandanteil', anteile[i], ''], ['Total', total, ' fw-semibold']].forEach(function (w) {
        werte.appendChild(element('dt', 'col-8 fw-normal' + w[2], w[0]));
        werte.appendChild(element('dd', 'col-4 text-end mb-0' + w[2], franken(w[1])));
      });
      li.appendChild(werte);
      if (teil.angekreuzt) {
        li.appendChild(element('div', teil.konflikt ? 'small fw-semibold text-warning-emphasis' : 'small text-muted',
          teil.konflikt ? 'Interessenskonflikt gemeldet' : 'Konflikt angekreuzt – ohne Wirkung, nicht dein Konto'));
      }
      if (teil.datei) li.appendChild(element('div', 'small text-break', 'Beleg: ' + teil.datei));
      liste.appendChild(li);
    });
    var gesamtRappen = rappen(gesamt.value);
    var schluss = element('p', 'fw-semibold', 'Summe ' + franken(summe) + (summe === gesamtRappen ? ' = ' : ' ≠ ')
      + 'Gesamtbetrag ' + (gesamtRappen === null ? '–' : franken(gesamtRappen)));
    zusammenfassung.textContent = '';
    zusammenfassung.appendChild(liste);
    zusammenfassung.appendChild(schluss);
  }

  function abschnitt(n) { return form.querySelector('section[data-schritt="' + n + '"]'); }

  function zeigeSchritt(n) {
    schritt = n;
    [1, 2, 3].forEach(function (i) { abschnitt(i).classList.toggle('d-none', i !== n); });
    form.querySelector('#split-schritt-anzeige').textContent = 'Schritt ' + n + ' von 3';
    // invisible statt d-none: die Anzeige bleibt in der Mitte stehen.
    zurueckKnopf.classList.toggle('invisible', n === 1);
    weiterKnopf.classList.toggle('invisible', n === 3);
    if (n === 2) zeigeStand();
    if (n === 3) baueZusammenfassung();
  }

  // Beim Hinscrollen Platz für das lassen, was oben klebt (Kopfzeile ab 992 px, darunter das Testmodus-Band).
  function haltePlatzFrei(ziel) {
    var hoehe = 0;
    document.querySelectorAll('.portal-oben, .testmodus-band').forEach(function (e) {
      if (getComputedStyle(e).position === 'sticky') hoehe = Math.max(hoehe, e.offsetHeight);
    });
    ziel.style.scrollMarginTop = (hoehe + 16) + 'px';
    return hoehe;
  }

  // Schrittwechsel durch die Person: Fokus auf den Titel des neuen Schritts (auch für Screenreader). Sind Schritt-Kopf
  // und Titel nicht beide zu sehen, den Kopf an den oberen Rand scrollen.
  function geheZu(n) {
    banner.hidden = true;
    zeigeSchritt(n);
    var titel = abschnitt(n).querySelector('h3');
    titel.focus({ preventScroll: true });
    var verdeckt = haltePlatzFrei(kopf);
    if (kopf.getBoundingClientRect().top < verdeckt || titel.getBoundingClientRect().bottom > window.innerHeight) {
      kopf.scrollIntoView({ block: 'start' });
    }
  }

  // Prüfungen vor «Weiter», die der Browser nicht selbst kann. Je Punkt das Feld, zu dem das Banner verlinkt.
  function offenInSchritt1() {
    var hinweise = [];
    var ki = [];
    var g = rappen(gesamt.value);
    var v = rappen(versand.value);
    if (g === null) hinweise.push({ feld: gesamt, label: 'Bitte einen gültigen Gesamtbetrag erfassen (z.B. 200.00).' });
    if (versand.value.trim() && v === null) hinweise.push({ feld: versand, label: 'Bitte gültige Versandkosten erfassen (z.B. 9.50).' });
    else if (versand.value.trim() && g !== null && v >= g) hinweise.push({ feld: versand, label: 'Die Versandkosten müssen kleiner als der Gesamtbetrag sein.' });
    abschnitt(1).querySelectorAll('[data-ki-feld]').forEach(function (feld) {
      var haken = form.querySelector('[data-ki-haken="' + feld.getAttribute('data-ki-feld') + '"]');
      if (haken && !haken.checked) ki.push({ feld: feld });
    });
    return { hinweise: hinweise, ki: ki };
  }

  function offenInSchritt2() {
    var hinweise = [];
    var teile = ausgefuellteZeilen();
    teile.forEach(function (teil) {
      if (!teil.konto.value) hinweise.push({ feld: teil.konto, label: 'Zeile ' + teil.nummer + ': Konto wählen.' });
      if (rappen(teil.betrag.value) === null) hinweise.push({ feld: teil.betrag, label: 'Zeile ' + teil.nummer + ': gültigen Teilbetrag erfassen (z.B. 123.45).' });
    });
    var erste = alleZeilen()[0];
    var ziel = erste ? erste.betrag : form.querySelector('#zeile-hinzufuegen');
    if (teile.length < 2) hinweise.push({ feld: ziel, label: 'Mindestens zwei Teile mit Konto und Teilbetrag erfassen.' });
    var s = aktuellerStand();
    if (!s) hinweise.push({ feld: gesamt, label: 'Bitte einen gültigen Gesamtbetrag erfassen (z.B. 200.00).' });
    else if (s.offen !== 0) hinweise.push({ feld: ziel, label: 'Die Teilbeträge müssen zusammen ' + franken(s.ziel) + ' ergeben: ' + offenText(s.offen) + '.' });
    if (!begruendung.value.trim() && teile.some(function (t) { return t.konflikt; })) {
      hinweise.push({ feld: begruendung, label: 'Begründung erfassen (Pflicht bei einem Interessenskonflikt).' });
    }
    return { hinweise: hinweise, ki: [] };
  }

  function weiter() {
    if (schritt >= 3) return;
    haltePlatzFrei(banner); // das Banner (kontierung-pflicht.js) scrollt sich selbst an den oberen Rand
    // Zuerst die Browser-Prüfung: jedes ungültige Feld meldet «invalid», kontierung-pflicht.js füllt daraus das Banner.
    var gueltig = true;
    abschnitt(schritt).querySelectorAll('input, select, textarea').forEach(function (feld) {
      if (!feld.checkValidity()) gueltig = false;
    });
    if (!gueltig) return;
    var offen = schritt === 1 ? offenInSchritt1() : offenInSchritt2();
    if (offen.hinweise.length > 0 || offen.ki.length > 0) {
      form.dispatchEvent(new CustomEvent('pflicht:melde', { detail: offen }));
      return;
    }
    geheZu(schritt + 1);
  }

  // «Weiter» und «Zurück» stehen im Schritt-Kopf und am Ende der Schritte.
  form.querySelectorAll('[data-split-weiter]').forEach(function (knopf) { knopf.addEventListener('click', weiter); });
  form.querySelectorAll('[data-split-zurueck]').forEach(function (knopf) {
    knopf.addEventListener('click', function () { if (schritt > 1) geheZu(schritt - 1); });
  });
  // Enter in einem Eingabefeld würde das Formular absenden (der erste Absende-Knopf liegt in Schritt 3): stattdessen «Weiter».
  form.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || /^(file|button|submit)$/.test(e.target.type)) return;
    e.preventDefault();
    weiter();
  });
  // Ein Banner-Link (kontierung-pflicht.js) auf ein Feld eines anderen Schritts wechselt dorthin.
  function zeigeSchrittVon(feld) {
    var ziel = feld && feld.closest('section[data-schritt]');
    if (ziel && form.contains(ziel)) zeigeSchritt(Number(ziel.getAttribute('data-schritt')));
  }
  form.addEventListener('pflicht:zeige', function (e) { zeigeSchrittVon(e.target); });
  // Dasselbe für das KI-Banner, das der Server nach einem abgelehnten Absenden mitschickt.
  bereich.addEventListener('click', function (e) {
    var link = e.target.closest('[data-ki-banner] a');
    if (!link) return;
    e.preventDefault();
    var feld = document.getElementById(link.getAttribute('href').slice(1));
    if (!feld) return;
    zeigeSchrittVon(feld);
    feld.focus();
  });

  // KI- und Pflicht-Banner der Kontierung stehen oberhalb der geteilten Ansicht, also ausserhalb von #kontierung-bereich.
  function blendeKontierungsBanner(ausblenden) {
    document.querySelectorAll('[data-pflicht-banner="kontierung-form"], [data-ki-banner]').forEach(function (b) {
      if (!bereich.contains(b)) b.classList.toggle('d-none', ausblenden);
    });
  }

  function setze(feld, wert) {
    feld.value = wert;
    feld.dispatchEvent(new Event('input', { bubbles: true }));
    feld.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Beim ersten Öffnen: ausgefüllte Werte aus dem Kontierungsformular übernehmen.
  function uebernimmWerte() {
    var typ = kontierung.querySelector('input[name="typ"]:checked');
    var radio = typ && form.querySelector('input[name="typ"][value="' + typ.value + '"]');
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    [['betrag', gesamt], ['kreditorId'], ['rechnungsnummer'], ['zahlungsziel']].forEach(function (paar) {
      var quelle = kontierung.querySelector('[name="' + paar[0] + '"]');
      // Rechnungsnummer und Zahlungsziel hat der Assistent nur bei KI-Werten.
      var ziel = paar[1] || form.querySelector('[name="' + paar[0] + '"]');
      if (quelle && ziel && quelle.value.trim()) setze(ziel, quelle.value);
    });
    // KI-Haken nach den Werten: eine Wertänderung setzt den Haken selbst (kontierung-ki.js), massgebend ist die Kontierung.
    kontierung.querySelectorAll('[data-ki-haken]').forEach(function (quelle) {
      var ziel = form.querySelector('[data-ki-haken="' + quelle.getAttribute('data-ki-haken') + '"]');
      if (!ziel || ziel.checked === quelle.checked) return;
      ziel.checked = quelle.checked;
      ziel.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Vom Server offen geliefert (?aufsplitten=1 oder abgelehntes Absenden): dessen Werte gelten, nichts übernehmen.
  var uebernommen = !bereich.classList.contains('d-none');

  function oeffne() {
    if (!uebernommen) uebernimmWerte();
    uebernommen = true;
    kontierungBereich.classList.add('d-none');
    bereich.classList.remove('d-none');
    blendeKontierungsBanner(true);
    zeigeStand();
    document.getElementById('split-ueberschrift').focus();
  }

  function schliesse() {
    bereich.classList.add('d-none');
    kontierungBereich.classList.remove('d-none');
    blendeKontierungsBanner(false);
    var menue = kontierungBereich.querySelector('[data-bs-toggle="dropdown"]');
    if (menue) menue.focus();
  }

  // «+ Lieferant» (views/kontierung.ejs) ergänzt nur die Auswahl der Kontierung, auch während der Assistent offen ist:
  // jede neue Option hierher kopieren (samt data-iban-pflicht) und bei sichtbarem Assistenten gleich wählen.
  function beobachteLieferanten() {
    var quelle = kontierung.querySelector('select[name="kreditorId"]');
    var ziel = form.querySelector('select[name="kreditorId"]');
    if (!quelle || !ziel || !window.MutationObserver) return;
    new MutationObserver(function (aenderungen) {
      aenderungen.forEach(function (aenderung) {
        Array.prototype.forEach.call(aenderung.addedNodes, function (option) {
          if (option.tagName !== 'OPTION') return;
          var kopie = option.cloneNode(true);
          kopie.removeAttribute('selected');
          kopie.selected = false; // die Auswahl nur unten und bewusst verschieben
          ziel.appendChild(kopie);
          if (!bereich.classList.contains('d-none')) setze(ziel, kopie.value);
        });
      });
    }).observe(quelle, { childList: true });
  }
  beobachteLieferanten();

  // Öffnen und Abbrechen sind Links (ohne Skript wird neu geladen); Klicks mit Zusatztaste öffnen weiterhin den Link.
  function ohneNeuladen(selektor, aktion) {
    document.querySelectorAll(selektor).forEach(function (link) {
      link.addEventListener('click', function (e) {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        aktion();
      });
    });
  }
  ohneNeuladen('[data-aufsplitten-oeffnen]', oeffne);
  ohneNeuladen('[data-aufsplitten-abbrechen]', schliesse);

  form.querySelector('#zeile-hinzufuegen').addEventListener('click', function () {
    zeilen.appendChild(vorlage.content.cloneNode(true));
  });

  zeilen.addEventListener('click', function (e) {
    var knopf = e.target.closest('.zeile-entfernen');
    if (!knopf) return;
    knopf.closest('.teil-zeile').remove();
    zeigeStand();
  });
  form.addEventListener('input', zeigeStand);
  form.addEventListener('change', zeigeStand);

  // The checkbox itself has no `name` and is never submitted — it only drives the hidden
  // input's value via this listener. With several dynamically added/removed rows, a shared
  // `name` on the checkboxes alone can't be parsed back into a reliable 1:1 array alongside
  // teilKontoId/teilBetrag: an unchecked checkbox sends nothing at all, so the submitted
  // array would silently shrink and misalign for any row after the first unchecked one. The
  // always-present hidden input keeps exactly one value per row, same as teilKontoId/teilBetrag.
  zeilen.addEventListener('change', function (e) {
    if (!e.target.classList.contains('konflikt-checkbox')) return;
    e.target.closest('.teil-zeile').querySelector('input[name="teilInteressenskonflikt"]').value = e.target.checked ? 'true' : 'false';
  });

  // Native <input type="file"> fields with nothing selected are simply omitted from the
  // multipart body by the browser — so req.files on the server would not line up
  // positionally with teilKontoId[i]/teilBetrag[i] whenever some rows have a file and others
  // don't. Renaming each row's file input to its current position right before submit (not
  // at row-creation time, so add/remove reordering is always handled correctly) gives the
  // server a stable teilBeleg_<i> fieldname to match back against that row's other fields.
  form.addEventListener('submit', function () {
    zeilen.querySelectorAll('.teil-zeile').forEach(function (zeile, i) {
      var datei = zeile.querySelector('.teil-beleg-input');
      if (datei && datei.files.length > 0) {
        datei.name = 'teilBeleg_' + i;
      } else if (datei) {
        datei.removeAttribute('name');
      }
    });
  });

  // Ausgangszustand: Schritt-Kopf zeigen, nur den Startschritt (vom Server: erster Schritt mit Fehler bzw. Prüf-Popup).
  kopf.hidden = false;
  form.querySelectorAll('[data-split-fuss]').forEach(function (fuss) { fuss.hidden = false; });
  [1, 2, 3].forEach(function (i) { abschnitt(i).classList.remove('border-top', 'pt-3'); });
  zeigeSchritt(Number(bereich.getAttribute('data-start-schritt')) || 1);
  zeigeStand();
  if (uebernommen) blendeKontierungsBanner(true);
})();
