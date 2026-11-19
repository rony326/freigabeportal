// Pflichtfelder und KI-Bestätigungen vor dem Absenden prüfen (Kontierung und Aufsplitten). Ohne dieses Skript hält der
// Browser ein unvollständiges Formular selbst an und zeigt nur eine flüchtige Sprechblase am ersten leeren Feld – bei
// den Auswahllisten mit Suchfeld (Konto, Lieferant) gar keine, weil die eigentliche <select> unsichtbar ist. Die Seite
// scrollte dann nur hoch, ohne Hinweis. Stattdessen: alle offenen Punkte als ruhiges Banner unter «Quelle»
// ([data-pflicht-banner], gleiche Optik wie views/_ki_banner.ejs), mit Links zu den Feldern.
//
// Ablauf: Die Browser-Prüfung bleibt eingeschaltet (kein novalidate). Ihre «invalid»-Ereignisse fangen wir ab (keine
// Sprechblase) und sammeln die Felder; ist alles gültig, prüft das «submit»-Ereignis noch die KI-Haken
// (public/js/kontierung-ki.js, services/kiBestaetigung.js). KI-Haken zählen nur für Knöpfe mit data-pflicht-pruefen
// (Kontieren, Aufsplitten) – nicht für Ablehnen oder Rapport. Der Server prüft unabhängig davon alles nochmals.
(function () {
  /**
   * Reine Prüflogik (in Node getestet: test/unit/kontierungPflicht.test.js).
   * @param {{id: string, label: string, ungueltig: boolean, kiOffen: boolean}[]} felder
   * @param {boolean} kiPruefen KI-Haken mitprüfen (nur beim Kontieren/Aufsplitten)
   * @returns {{fehlend: {id: string, label: string}[], ki: {id: string, label: string}[]}}
   */
  function offenePunkte(felder, kiPruefen) {
    var fehlend = [];
    var ki = [];
    felder.forEach(function (f) {
      if (f.ungueltig) fehlend.push({ id: f.id, label: f.label });
      else if (kiPruefen && f.kiOffen) ki.push({ id: f.id, label: f.label });
    });
    return { fehlend: fehlend, ki: ki };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { offenePunkte: offenePunkte };
    return;
  }

  var form = document.querySelector('form[data-pflicht-pruefung]');
  var banner = document.querySelector('[data-pflicht-banner]');
  if (!form || !banner) return;

  var zaehler = 0;
  function feldId(feld) {
    if (!feld.id) { zaehler += 1; feld.id = 'pflichtfeld-' + zaehler; }
    return feld.id;
  }
  function beschriftung(feld) {
    var label = feld.labels && feld.labels[0] ? feld.labels[0].textContent : '';
    label = (label || feld.getAttribute('aria-label') || feld.getAttribute('placeholder') || feld.name || 'Feld').trim();
    return label.replace(/\s+/g, ' ');
  }

  // Welcher Knopf hat abgesendet? (Die Knöpfe stehen teils ausserhalb des Formulars, form="…".)
  var knopf = null;
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[type="submit"], input[type="submit"]') : null;
    if (b && (b.form === form)) knopf = b;
  }, true);
  function kiPruefen() { return Boolean(knopf && knopf.hasAttribute('data-pflicht-pruefen')); }

  function sammle(ungueltige) {
    var felder = [];
    var gesehen = new Set();
    ungueltige.forEach(function (f) {
      gesehen.add(f);
      felder.push({ id: feldId(f), label: beschriftung(f), ungueltig: true, kiOffen: false });
    });
    form.querySelectorAll('[data-ki-feld]').forEach(function (f) {
      if (gesehen.has(f) || f.disabled) return;
      var haken = document.querySelector('[data-ki-haken="' + f.getAttribute('data-ki-feld') + '"]');
      felder.push({ id: feldId(f), label: beschriftung(f), ungueltig: false, kiOffen: Boolean(haken && !haken.checked) });
    });
    return offenePunkte(felder, kiPruefen());
  }

  function liste(titel, punkte) {
    var p = document.createElement('p');
    p.className = 'mb-1';
    p.textContent = titel;
    var ul = document.createElement('ul');
    ul.className = 'mb-2';
    punkte.forEach(function (punkt) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#' + punkt.id;
      a.className = 'ki-banner-link';
      a.textContent = punkt.label;
      a.addEventListener('click', function (e) {
        e.preventDefault();
        // Unter 992 px zeigt der Beleg/Formular-Umschalter evtl. gerade den Beleg: auf das Formular wechseln.
        var formularKnopf = document.querySelector('[data-beleg-ansicht="formular"]');
        if (formularKnopf && formularKnopf.getAttribute('aria-pressed') !== 'true') formularKnopf.click();
        var ziel = document.getElementById(punkt.id);
        // Auswahllisten mit Suchfeld: die sichtbare Eingabe direkt davor/danach fokussieren statt der versteckten <select>.
        var sichtbar = ziel && ziel.classList.contains('visually-hidden') && ziel.parentElement ? ziel.parentElement.querySelector('input:not([type="hidden"]):not(.visually-hidden)') : null;
        (sichtbar || ziel).focus();
        (sichtbar || ziel).scrollIntoView({ block: 'center' });
      });
      li.appendChild(a);
      ul.appendChild(li);
    });
    return [p, ul];
  }

  function zeige(punkte) {
    banner.textContent = '';
    if (punkte.fehlend.length > 0) liste('Bitte noch ausfüllen:', punkte.fehlend).forEach(function (el) { banner.appendChild(el); });
    if (punkte.ki.length > 0) liste('Diese Werte wurden automatisch erkannt. Bitte prüfe sie und bestätige sie mit dem Haken am Feldrand oder korrigiere sie:', punkte.ki).forEach(function (el) { banner.appendChild(el); });
    var letzte = banner.lastElementChild;
    if (letzte) letzte.classList.replace('mb-2', 'mb-0');
    banner.hidden = false;
    banner.scrollIntoView({ block: 'start' });
    banner.focus({ preventScroll: true });
  }

  // Browser-Prüfung: jedes ungültige Feld meldet sich einzeln; einmal pro Absendeversuch gesammelt anzeigen.
  var ungueltige = [];
  var geplant = false;
  form.addEventListener('invalid', function (e) {
    e.preventDefault(); // keine Sprechblase – das Banner sagt es vollständig
    ungueltige.push(e.target);
    if (geplant) return;
    geplant = true;
    setTimeout(function () {
      zeige(sammle(ungueltige));
      ungueltige = [];
      geplant = false;
    }, 0);
  }, true);

  // Alles gültig: noch die KI-Haken (nur beim Kontieren/Aufsplitten).
  form.addEventListener('submit', function (e) {
    var punkte = sammle([]);
    if (punkte.ki.length > 0) {
      e.preventDefault();
      zeige(punkte);
      return;
    }
    banner.hidden = true;
  });
})();
