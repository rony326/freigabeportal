// Konto-Auswahl folgt dem Typ (Rechnung/Gutschrift): Konten mit data-buchungsart="gutschrift" gibt es nur
// bei Gutschriften, "rechnung" nur bei Rechnungen, "beides" immer. Ein nicht mehr passendes gewähltes
// Konto wird geleert, mit Hinweis. Der Server prüft zusätzlich (routes/kontierung.js).
// Wirkt je Formular: Kontierung und Aufsplitten-Assistent haben je eigene Typ-Auswahl.
(function () {
  var AUSWAHL = 'select[name="kontoId"], select[name="teilKontoId"]';

  function passt(art, typ) {
    if (typ !== 'rechnung' && typ !== 'gutschrift') return true;
    return !art || art === 'beides' || art === typ;
  }

  function binde(form) {
    var radios = form.querySelectorAll('input[name="typ"]');
    if (radios.length === 0) return;
    var hinweis = form.querySelector('[data-konto-typ-hinweis]');

    function aktuellerTyp() {
      var radio = form.querySelector('input[name="typ"]:checked');
      return radio ? radio.value : null;
    }

    function anwenden(select, typ) {
      var geleert = false;
      Array.prototype.forEach.call(select.options, function (option) {
        if (!option.value) return;
        var ok = passt(option.getAttribute('data-buchungsart'), typ);
        option.disabled = !ok;
        option.hidden = !ok;
        if (!ok && option.selected) {
          select.value = '';
          geleert = true;
        }
      });
      if (geleert) {
        // Die durchsuchbare Auswahl (kontierung.ejs) zeigt das gewählte Konto in einem eigenen Feld.
        var suche = select.id ? form.querySelector('#' + select.id + '-suche') : null;
        if (suche) suche.value = '';
      }
      return geleert;
    }

    function alleAnwenden(meldungErlaubt) {
      var typ = aktuellerTyp();
      var geleert = false;
      Array.prototype.forEach.call(form.querySelectorAll(AUSWAHL), function (select) {
        if (anwenden(select, typ)) geleert = true;
      });
      if (hinweis) hinweis.hidden = !(geleert && meldungErlaubt);
    }

    Array.prototype.forEach.call(radios, function (radio) {
      radio.addEventListener('change', function () { alleAnwenden(true); });
    });
    // Beim Aufsplitten kommen Zeilen dynamisch dazu: neue Auswahlfelder sofort filtern.
    var zeilen = form.querySelector('#teile-container');
    if (zeilen && window.MutationObserver) {
      new MutationObserver(function () { alleAnwenden(false); }).observe(zeilen, { childList: true });
    }
    alleAnwenden(true);
  }

  Array.prototype.forEach.call(document.forms, binde);
})();
