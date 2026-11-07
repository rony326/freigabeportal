// Gemeinsames Verhalten des Grundgerüsts (views/_seite_anfang.ejs). Wird mit defer geladen.
(function () {
  var root = document.documentElement;
  var dunkelMedium = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var systemAktiv = false;

  function setzeTheme(dunkel) {
    root.setAttribute('data-theme', dunkel ? 'dunkel' : 'hell');
    root.setAttribute('data-bs-theme', dunkel ? 'dark' : 'light');
  }
  function wende(wahl) {
    systemAktiv = wahl === 'system';
    setzeTheme(wahl === 'dunkel' || (systemAktiv && dunkelMedium && dunkelMedium.matches));
  }
  if (dunkelMedium) {
    dunkelMedium.addEventListener('change', function () {
      if (systemAktiv) setzeTheme(dunkelMedium.matches);
    });
  }
  var eintraege = document.querySelectorAll('[data-farbmodus]');
  // Ohne Cookie und ohne Admin-Standard liefert der Server "system" aus: dann dem Medium folgen.
  eintraege.forEach(function (e) {
    if (e.getAttribute('aria-pressed') === 'true') systemAktiv = e.getAttribute('data-farbmodus') === 'system';
  });
  eintraege.forEach(function (eintrag) {
    eintrag.addEventListener('click', function () {
      var wahl = eintrag.getAttribute('data-farbmodus');
      var bewegt = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      if (bewegt) {
        root.classList.add('farbwechsel');
        setTimeout(function () { root.classList.remove('farbwechsel'); }, 250);
      }
      wende(wahl);
      document.cookie = 'theme=' + wahl + ';path=/;max-age=31536000;samesite=lax';
      eintraege.forEach(function (e) { e.setAttribute('aria-pressed', e === eintrag ? 'true' : 'false'); });
    });
  });

  // Eingeklappte Seitenleiste (PDF-Seiten): Label als Tooltip neben dem Symbol.
  if (window.bootstrap && window.bootstrap.Tooltip) {
    document.querySelectorAll('.portal-seitenleiste.eingeklappt [title]').forEach(function (el) {
      window.bootstrap.Tooltip.getOrCreateInstance(el, { placement: 'right', trigger: 'hover focus' });
    });
  }
})();

// Namespace für gemeinsame Helfer; weitere Aufgaben ergänzen ihn in dieser Datei.
window.Portal = window.Portal || {};

// Sendestatus: Knopf als "arbeitet" markieren (Spinner, aria-busy) bis `arbeit` fertig ist.
// Der Knopf wird bewusst nicht disabled (sonst fehlt name/value im Formular).
(function () {
  function markiere(knopf) {
    knopf.setAttribute('aria-busy', 'true');
    knopf.classList.add('wird-gesendet');
    var spinner = document.createElement('span');
    spinner.className = 'spinner-border spinner-border-sm ms-1';
    spinner.setAttribute('aria-hidden', 'true');
    knopf.appendChild(spinner);
  }

  function entmarkiere(knopf) {
    knopf.removeAttribute('aria-busy');
    knopf.classList.remove('wird-gesendet');
    knopf.querySelectorAll(':scope > .spinner-border').forEach(function (s) { s.remove(); });
  }

  window.Portal.beschaeftigt = function (knopf, arbeit) {
    markiere(knopf);
    var fertig = function () { entmarkiere(knopf); };
    return Promise.resolve(arbeit).then(
      function (ergebnis) { fertig(); return ergebnis; },
      function (fehler) { fertig(); throw fehler; }
    );
  };

  // Formulare (POST, ohne target, ohne data-kein-sendestatus): erster Submit markiert den Knopf,
  // weitere Submits desselben Formulars werden verworfen. Nach 15 s wieder frei (z. B. Netzfehler).
  var gesendet = new Map(); // Formular -> markierter Knopf
  var FREIGABE_MS = 15000;

  document.addEventListener('submit', function (e) {
    if (e.defaultPrevented) return; // von einer Seite oder Bestätigung abgebrochen: nichts markieren
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    if ((form.method || '').toLowerCase() !== 'post') return;
    if (form.target || form.hasAttribute('data-kein-sendestatus')) return;
    if (e.submitter && e.submitter.formTarget) return; // z. B. formtarget=_blank: Seite bleibt stehen
    if (gesendet.has(form)) { e.preventDefault(); return; }
    var knopf = e.submitter || form.querySelector('button[type=submit], button:not([type]), input[type=submit]');
    if (knopf && knopf.tagName === 'INPUT') knopf = null; // kein Inhalt für einen Spinner
    if (knopf) markiere(knopf);
    gesendet.set(form, knopf);
    setTimeout(function () {
      if (gesendet.get(form) === knopf) { gesendet.delete(form); if (knopf) entmarkiere(knopf); }
    }, FREIGABE_MS);
  });

  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    gesendet.forEach(function (knopf) { if (knopf) entmarkiere(knopf); });
    gesendet.clear();
    document.querySelectorAll('.wird-gesendet').forEach(entmarkiere);
  });
})();

// Begründung: Pflicht erst, wenn der Interessenskonflikt gemeldet ist. Das Textfeld trägt
// data-begruendung-pflicht-bei="<id des Konflikt-Radios>"; der Hinweis im Label ist
// [data-begruendung-hinweis]. Fehlende Elemente werden ignoriert.
(function () {
  function init(feld) {
    var ja = document.getElementById(feld.getAttribute('data-begruendung-pflicht-bei'));
    if (!ja) return;
    var label = feld.id ? document.querySelector('label[for="' + feld.id + '"]') : null;
    var hinweis = label ? label.querySelector('[data-begruendung-hinweis]') : null;
    var radios = ja.name ? document.querySelectorAll('input[type="radio"][name="' + ja.name + '"]') : [ja];
    function aktualisiere() {
      feld.required = ja.checked;
      if (hinweis) hinweis.textContent = ja.checked ? '(Pflicht)' : '(bei Ablehnung Pflicht)';
    }
    Array.prototype.forEach.call(radios, function (r) { r.addEventListener('change', aktualisiere); });
    aktualisiere();
  }
  document.querySelectorAll('[data-begruendung-pflicht-bei]').forEach(init);
})();

// Bestätigungsdialog (views/_bestaetigen_dialog.ejs) statt window.confirm.
// Portal.bestaetigen({ titel, text, knopf, gefahr }) -> Promise<boolean>; Escape/Abbrechen/Schliessen -> false.
// form[data-bestaetigen="<Text>"] (optional data-bestaetigen-knopf, data-bestaetigen-gefahr): Der erste Submit wird
// in der Capture-Phase angehalten, nach "true" per requestSubmit(submitter) erneut ausgelöst (Flag gegen Endlosschleife).
// Ohne JS (oder ohne Dialog) sendet das Formular ganz normal.
(function () {
  var laufend = null;

  window.Portal.bestaetigen = function (opt) {
    var dialog = document.getElementById('bestaetigen-dialog');
    if (!dialog || !window.bootstrap || !window.bootstrap.Modal) {
      return Promise.resolve(true); // Notfall: Dialog fehlt, Aktion nicht blockieren
    }
    if (laufend) return laufend;
    var ok = document.getElementById('bestaetigen-dialog-ok');
    document.getElementById('bestaetigen-dialog-titel').textContent = opt.titel || 'Bitte bestätigen';
    document.getElementById('bestaetigen-dialog-text').textContent = opt.text || '';
    ok.textContent = opt.knopf || 'OK';
    ok.className = 'btn ' + (opt.gefahr ? 'btn-danger' : 'btn-primary');
    var modal = window.bootstrap.Modal.getOrCreateInstance(dialog);
    laufend = new Promise(function (resolve) {
      var antwort = false;
      var beiOk = function () { antwort = true; modal.hide(); };
      var beiZu = function () {
        ok.removeEventListener('click', beiOk);
        dialog.removeEventListener('hidden.bs.modal', beiZu);
        laufend = null;
        resolve(antwort);
      };
      ok.addEventListener('click', beiOk);
      dialog.addEventListener('hidden.bs.modal', beiZu);
      dialog.addEventListener('shown.bs.modal', function fokus() {
        dialog.removeEventListener('shown.bs.modal', fokus);
        ok.focus();
      });
      modal.show();
    });
    return laufend;
  };

  var freigegeben = new WeakSet();
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM' || !form.hasAttribute('data-bestaetigen')) return;
    if (freigegeben.has(form)) { freigegeben.delete(form); return; }
    if (!document.getElementById('bestaetigen-dialog') || !window.bootstrap) return;
    e.preventDefault();
    var submitter = e.submitter || null;
    window.Portal.bestaetigen({
      titel: form.getAttribute('data-bestaetigen-titel') || 'Bitte bestätigen',
      text: form.getAttribute('data-bestaetigen'),
      knopf: form.getAttribute('data-bestaetigen-knopf') || 'OK',
      gefahr: form.hasAttribute('data-bestaetigen-gefahr')
    }).then(function (ja) {
      if (!ja) return;
      freigegeben.add(form);
      form.requestSubmit(submitter);
    });
  }, true);
})();

// Kurze Rückmeldung unter einem Element statt eines Browser-Popups. art: 'erfolg' | 'fehler'.
window.Portal.meldung = function (ziel, text, art) {
  var alt = ziel.nextElementSibling;
  if (alt && alt.hasAttribute('data-portal-meldung')) alt.remove();
  var el = document.createElement('div');
  el.className = 'small ' + (art === 'erfolg' ? 'text-success' : 'text-danger');
  el.setAttribute('role', 'status');
  el.setAttribute('data-portal-meldung', '');
  el.textContent = text;
  ziel.insertAdjacentElement('afterend', el);
  return el;
};
