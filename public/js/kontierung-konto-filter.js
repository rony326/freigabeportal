// Konto-Auswahl folgt dem Typ (Rechnung/Gutschrift): Konten mit data-buchungsart="gutschrift" gibt es nur
// bei Gutschriften, "rechnung" nur bei Rechnungen, "beides" immer. Ein nicht mehr passendes gewähltes
// Konto wird geleert, mit Hinweis. Der Server prüft zusätzlich (routes/kontierung.js).
(function () {
  var AUSWAHL = 'select#kontoId, select[name="teilKontoId"]';
  var hinweis = document.getElementById('konto-typ-hinweis');

  function aktuellerTyp() {
    var radio = document.querySelector('input[name="typ"]:checked');
    return radio ? radio.value : null;
  }

  function passt(art, typ) {
    if (typ !== 'rechnung' && typ !== 'gutschrift') return true;
    return !art || art === 'beides' || art === typ;
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
      var suche = select.id ? document.getElementById(select.id + '-suche') : null;
      if (suche) suche.value = '';
    }
    return geleert;
  }

  function alleAnwenden(meldungErlaubt) {
    var typ = aktuellerTyp();
    var geleert = false;
    Array.prototype.forEach.call(document.querySelectorAll(AUSWAHL), function (select) {
      if (anwenden(select, typ)) geleert = true;
    });
    if (hinweis) hinweis.hidden = !(geleert && meldungErlaubt);
  }

  Array.prototype.forEach.call(document.querySelectorAll('input[name="typ"]'), function (radio) {
    radio.addEventListener('change', function () { alleAnwenden(true); });
  });
  // Beim Aufsplitten kommen Zeilen dynamisch dazu: neue Auswahlfelder sofort filtern.
  var formular = document.getElementById('aufsplitten-form');
  if (formular && window.MutationObserver) {
    new MutationObserver(function () { alleAnwenden(false); }).observe(formular, { childList: true, subtree: true });
  }
  alleAnwenden(true);
})();
