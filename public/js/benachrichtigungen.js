// Komfort auf /admin/benachrichtigungen/:id (views/admin/benachrichtigungen.ejs). Die Seite funktioniert
// ohne JS; dieses Skript ergänzt:
// - Empfänger-Auswahl: Kärtchen + Suche mit Vorschlagsliste statt Textfeld. Das Textfeld #empfaenger
//   bleibt das gesendete Feld (versteckt) und wird bei jeder Änderung neu geschrieben.
// - Variablen-Knöpfe: fügen %name% an der Cursorposition von Betreff bzw. Text ein.
// - Live-Vorschau mit Beispieldaten (gleiche Ersetzung wie renderTemplate in src/services/mailTemplates.js).
// - Hinweis bei der Test-Mail, wenn das Formular ungespeicherte Änderungen hat.
// Nutzerdaten (Namen, Adressen, Vorlagentext) nur über textContent bzw. DOM-Knoten, nie innerHTML.
(function () {
  'use strict';

  var PLATZHALTER = /%([a-zA-Z0-9_]+)%/g;
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var EMAIL_MAX_LAENGE = 320;
  var MAX_PERSONEN = 8;
  var PERSON = 'person:';
  var hat = Object.prototype.hasOwnProperty;

  // Ersetzt %name% durch die Beispielwerte; unbekannte Platzhalter bleiben stehen und werden
  // (je einmal, in Reihenfolge des Auftretens) gemeldet.
  function vorschau(vorlage, beispiele) {
    var unbekannt = [];
    var text = String(vorlage).replace(PLATZHALTER, function (treffer, name) {
      if (hat.call(beispiele, name)) return String(beispiele[name]);
      if (unbekannt.indexOf(name) === -1) unbekannt.push(name);
      return treffer;
    });
    return { text: text, unbekannt: unbekannt };
  }

  function istEmail(wert) {
    return wert.length <= EMAIL_MAX_LAENGE && EMAIL.test(wert);
  }

  // Vorschläge zur Sucheingabe: Gruppen (Name enthält die Suche), Personen (Vor- oder Nachname
  // enthält die Suche, max. 8) und die eingegebene Adresse, wenn sie gültig ist. Bereits gewählte
  // Einträge fehlen. Bei nurEmail nur die Adresse.
  function vorschlaege(daten, gewaehlt, suche) {
    var eingabe = String(suche).trim();
    var klein = eingabe.toLowerCase();
    var vergeben = gewaehlt.map(function (w) { return w.toLowerCase(); });
    var frei = function (wert) { return vergeben.indexOf(wert.toLowerCase()) === -1; };
    var enthaelt = function (text) { return !klein || text.toLowerCase().indexOf(klein) !== -1; };
    var gruppen = daten.nurEmail ? [] : daten.gruppen.filter(function (g) { return frei(g.wert) && enthaelt(g.label); });
    var personen = daten.nurEmail ? [] : daten.personen.filter(function (p) {
      return frei(PERSON + p.id) && enthaelt(p.name);
    }).slice(0, MAX_PERSONEN);
    return { gruppen: gruppen, personen: personen, email: istEmail(eingabe) && frei(eingabe) ? eingabe : null };
  }

  // Empfängerliste für den Vergleich "ungespeichert": CRLF vereinheitlicht, Zeilen getrimmt, Leerzeilen weg.
  function normalisiereEmpfaenger(text) {
    return String(text).split(/\r\n|\r|\n/).map(function (z) { return z.trim(); }).filter(Boolean).join('\n');
  }

  // Anzeigenamen der Personen: der Name, bei gleichen Namen (ohne Gross-/Kleinschreibung) mit "(ID n)".
  function personenLabels(personen) {
    var anzahl = {};
    personen.forEach(function (p) {
      var k = String(p.name).trim().toLowerCase();
      anzahl[k] = (anzahl[k] || 0) + 1;
    });
    var labels = {};
    personen.forEach(function (p) {
      labels[p.id] = anzahl[String(p.name).trim().toLowerCase()] > 1 ? p.name + ' (ID ' + p.id + ')' : p.name;
    });
    return labels;
  }

  window.Benachrichtigungen = { vorschau: vorschau, vorschlaege: vorschlaege, normalisiereEmpfaenger: normalisiereEmpfaenger, personenLabels: personenLabels };

  var datenElement = document.getElementById('benachrichtigungDaten');
  if (!datenElement) return;
  var daten;
  try {
    daten = JSON.parse(datenElement.textContent);
  } catch (err) {
    return;
  }

  function leere(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function aendere(feld) {
    feld.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Test-Mail: nutzt immer den gespeicherten Text. Bei ungespeicherten Änderungen darauf hinweisen.
  function testmailHinweis() {
    var form = document.getElementById('ereignisForm');
    var hinweis = document.getElementById('testmailHinweis');
    if (!form || !hinweis) return;
    var original = hinweis.textContent;
    // Die Empfängerliste wird normalisiert verglichen (Zeilenenden, Leerzeilen, Leerraum zählen nicht).
    var stand = function () {
      var paare = [];
      new FormData(form).forEach(function (wert, name) {
        paare.push([name, name === 'empfaenger' ? normalisiereEmpfaenger(wert) : wert]);
      });
      return new URLSearchParams(paare).toString();
    };
    var gespeichert = stand();
    var vonAnfangAn = form.hasAttribute('data-ungespeichert');
    function pruefe() {
      var geaendert = vonAnfangAn || stand() !== gespeichert;
      hinweis.textContent = geaendert ? 'Die Test-Mail nutzt den gespeicherten Text – speichere zuerst, um deine Änderungen zu testen.' : original;
      hinweis.classList.toggle('text-muted', !geaendert);
      hinweis.classList.toggle('text-warning-emphasis', geaendert);
    }
    form.addEventListener('input', pruefe);
    form.addEventListener('change', pruefe);
    pruefe();
  }

  function empfaengerAuswahl() {
    var picker = document.querySelector('[data-empfaenger-picker]');
    var feld = document.getElementById('empfaenger');
    if (!picker || !feld) return;
    var kaertchen = picker.querySelector('[data-empfaenger-kaertchen]');
    var leerHinweis = picker.querySelector('[data-empfaenger-leer]');
    var suche = picker.querySelector('[data-empfaenger-suche]');
    var liste = picker.querySelector('[data-empfaenger-vorschlaege]');
    var meldung = picker.querySelector('[data-empfaenger-meldung]');
    var symbole = document.getElementById('empfaengerSymbole');

    var gruppenNamen = {};
    daten.gruppen.forEach(function (g) { gruppenNamen[g.wert] = g.label; });
    var personenNamen = {};
    var personenLabel = personenLabels(daten.personen);
    daten.personen.forEach(function (p) { personenNamen[PERSON + p.id] = personenLabel[p.id]; });
    var gespeichert = {};
    daten.anzeige.forEach(function (e) { gespeichert[e.wert] = e; });

    var werte = feld.value.split(/\r?\n|\r/).map(function (z) { return z.trim(); }).filter(Boolean);
    var optionen = [];
    var aktiv = -1;

    function beschreibe(wert) {
      if (!daten.nurEmail && gruppenNamen[wert]) return { art: 'gruppe', label: gruppenNamen[wert], hinweis: null };
      if (!daten.nurEmail && wert.indexOf(PERSON) === 0) {
        if (personenNamen[wert]) return { art: 'person', label: personenNamen[wert], hinweis: null };
        var bekannt = gespeichert[wert];
        return { art: 'person', label: bekannt ? bekannt.label : 'Person ' + wert.slice(PERSON.length), hinweis: bekannt ? bekannt.hinweis : 'unbekannt' };
      }
      return { art: 'mail', label: wert, hinweis: null };
    }

    function symbol(art) {
      var vorlage = symbole && symbole.content.querySelector('[data-art="' + art + '"] svg');
      return vorlage ? vorlage.cloneNode(true) : null;
    }

    function melde(text) {
      meldung.textContent = text;
    }

    function schreibe() {
      feld.value = werte.join('\n');
      aendere(feld);
    }

    function zeichne() {
      leere(kaertchen);
      werte.forEach(function (wert, index) {
        var info = beschreibe(wert);
        var li = document.createElement('li');
        li.className = 'zielwahl-chip';
        var icon = symbol(info.art);
        if (icon) li.appendChild(icon);
        var text = document.createElement('span');
        text.className = 'zielwahl-chip-text';
        text.textContent = info.label;
        li.appendChild(text);
        if (info.hinweis) {
          var badge = document.createElement('span');
          badge.className = 'badge ' + (info.hinweis === 'unbekannt' ? 'text-bg-warning' : 'text-bg-secondary');
          badge.textContent = info.hinweis;
          li.appendChild(badge);
        }
        var entfernen = document.createElement('button');
        entfernen.type = 'button';
        entfernen.className = 'btn-close';
        entfernen.setAttribute('aria-label', info.label + ' entfernen');
        entfernen.addEventListener('click', function () { entferne(index); });
        li.appendChild(entfernen);
        kaertchen.appendChild(li);
      });
      kaertchen.hidden = werte.length === 0;
      leerHinweis.hidden = werte.length > 0;
    }

    function entferne(index) {
      var label = beschreibe(werte[index]).label;
      werte.splice(index, 1);
      schreibe();
      zeichne();
      melde(label + ' entfernt.');
      // Fokus nicht verlieren: auf das nächste (sonst vorherige) Kärtchen, zuletzt auf die Suche.
      var knoepfe = kaertchen.querySelectorAll('.btn-close');
      var ziel = knoepfe[Math.min(index, knoepfe.length - 1)];
      (ziel || suche).focus();
    }

    function fuegeHinzu(wert) {
      var vorhanden = werte.some(function (w) { return w.toLowerCase() === wert.toLowerCase(); });
      var label = beschreibe(wert).label;
      if (vorhanden) {
        melde(label + ' ist schon ausgewählt.');
      } else {
        werte.push(wert);
        schreibe();
        zeichne();
        melde(label + ' hinzugefügt.');
      }
      suche.value = '';
      schliesse();
      suche.focus();
    }

    function setzeAktiv(index) {
      optionen.forEach(function (o, i) {
        var an = i === index;
        o.element.classList.toggle('active', an);
        o.element.setAttribute('aria-selected', an ? 'true' : 'false');
      });
      aktiv = index;
      if (index >= 0) {
        suche.setAttribute('aria-activedescendant', optionen[index].element.id);
        optionen[index].element.scrollIntoView({ block: 'nearest' });
      } else {
        suche.removeAttribute('aria-activedescendant');
      }
    }

    function option(eltern, text, aktion, zusatz) {
      var element = document.createElement('div');
      element.className = 'dropdown-item' + (zusatz ? ' ' + zusatz : '');
      element.id = 'empfaengerOption' + optionen.length;
      element.setAttribute('role', 'option');
      element.setAttribute('aria-selected', 'false');
      element.textContent = text;
      var index = optionen.length;
      element.addEventListener('click', function () { setzeAktiv(index); aktion(); });
      eltern.appendChild(element);
      optionen.push({ element: element, aktion: aktion });
    }

    function abschnitt(titel, eintraege) {
      if (eintraege.length === 0) return;
      var gruppe = document.createElement('div');
      gruppe.setAttribute('role', 'group');
      var kopf = document.createElement('div');
      kopf.className = 'dropdown-header';
      kopf.id = 'empfaengerAbschnitt' + titel;
      kopf.textContent = titel;
      gruppe.setAttribute('aria-labelledby', kopf.id);
      gruppe.appendChild(kopf);
      eintraege.forEach(function (e) { option(gruppe, e.label, e.aktion); });
      liste.appendChild(gruppe);
    }

    function andereAdresse() {
      var eingabe = suche.value.trim();
      if (!eingabe) melde('Gib die E-Mail-Adresse ins Suchfeld ein.');
      else if (istEmail(eingabe)) melde(eingabe + ' ist schon ausgewählt.');
      else melde('„' + eingabe + '“ ist keine gültige E-Mail-Adresse.');
      suche.focus();
    }

    function baueListe() {
      leere(liste);
      optionen = [];
      var v = vorschlaege(daten, werte, suche.value);
      abschnitt('Gruppen', v.gruppen.map(function (g) {
        return { label: g.label, aktion: function () { fuegeHinzu(g.wert); } };
      }));
      abschnitt('Personen', v.personen.map(function (p) {
        return { label: personenLabel[p.id], aktion: function () { fuegeHinzu(PERSON + p.id); } };
      }));
      if (liste.firstChild) {
        var trenner = document.createElement('div');
        trenner.className = 'dropdown-divider';
        trenner.setAttribute('aria-hidden', 'true');
        liste.appendChild(trenner);
      }
      if (v.email) option(liste, v.email + ' hinzufügen', function () { fuegeHinzu(v.email); });
      else option(liste, 'Andere E-Mail-Adresse eingeben …', andereAdresse, 'text-body-secondary');
      setzeAktiv(suche.value.trim() ? 0 : -1);
    }

    function offen() {
      return liste.classList.contains('show');
    }

    function oeffne() {
      baueListe();
      liste.classList.add('show');
      suche.setAttribute('aria-expanded', 'true');
    }

    function schliesse() {
      liste.classList.remove('show');
      suche.setAttribute('aria-expanded', 'false');
      setzeAktiv(-1);
    }

    // mousedown in der Liste (Option, Überschrift, Bildlaufleiste): Fokus bleibt in der Suche,
    // sonst schliesst blur die Liste vor dem Klick.
    liste.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    suche.addEventListener('input', function () { melde(''); oeffne(); });
    suche.addEventListener('click', function () { if (!offen()) oeffne(); });
    suche.addEventListener('blur', schliesse);
    suche.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (!offen()) oeffne();
        else setzeAktiv((aktiv + 1) % optionen.length);
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (!offen()) oeffne();
        setzeAktiv(aktiv <= 0 ? optionen.length - 1 : aktiv - 1);
      } else if (ev.key === 'Enter') {
        // Nie das Formular absenden: Enter wählt nur aus.
        ev.preventDefault();
        if (offen() && aktiv >= 0) optionen[aktiv].aktion();
        else if (istEmail(suche.value.trim())) fuegeHinzu(suche.value.trim());
      } else if (ev.key === 'Escape') {
        if (offen()) {
          ev.preventDefault();
          schliesse();
        } else if (suche.value) {
          ev.preventDefault();
          suche.value = '';
        }
      }
    });

    document.querySelectorAll('[data-empfaenger-ohne-js]').forEach(function (el) { el.hidden = true; });
    picker.hidden = false;
    zeichne();
  }

  function variablenKnoepfe() {
    var betreff = document.getElementById('betreff');
    var text = document.getElementById('text');
    if (!text) return;
    var zuletzt = text;
    [betreff, text].forEach(function (feld) {
      if (feld) feld.addEventListener('focus', function () { zuletzt = feld; });
    });
    document.querySelectorAll('button.var[data-var]').forEach(function (knopf) {
      knopf.addEventListener('click', function () {
        var platzhalter = '%' + knopf.getAttribute('data-var') + '%';
        var start = zuletzt.selectionStart;
        var ende = zuletzt.selectionEnd;
        zuletzt.setRangeText(platzhalter, start, ende, 'end');
        var cursor = start + platzhalter.length;
        zuletzt.focus();
        zuletzt.setSelectionRange(cursor, cursor);
        aendere(zuletzt);
      });
    });
  }

  function liveVorschau() {
    var betreff = document.getElementById('betreff');
    var text = document.getElementById('text');
    var zielBetreff = document.getElementById('vorschauBetreff');
    var zielText = document.getElementById('vorschauText');
    var warnungen = document.getElementById('vorschauWarnungen');
    var quelle = document.getElementById('vorschauQuelle');
    if (!betreff || !text || !zielBetreff || !zielText || !warnungen) return;
    function aktualisiere() {
      var b = vorschau(betreff.value, daten.beispiele);
      var t = vorschau(text.value, daten.beispiele);
      zielBetreff.textContent = b.text;
      zielText.textContent = t.text;
      var unbekannt = b.unbekannt.concat(t.unbekannt.filter(function (n) { return b.unbekannt.indexOf(n) === -1; }));
      leere(warnungen);
      unbekannt.forEach(function (name) {
        var li = document.createElement('li');
        li.textContent = 'Unbekannter Platzhalter: %' + name + '%';
        warnungen.appendChild(li);
      });
      warnungen.hidden = unbekannt.length === 0;
    }
    if (quelle) quelle.textContent = '(dein aktueller Text mit Beispieldaten)';
    betreff.addEventListener('input', aktualisiere);
    text.addEventListener('input', aktualisiere);
    aktualisiere();
  }

  testmailHinweis();
  empfaengerAuswahl();
  variablenKnoepfe();
  liveVorschau();
})();
