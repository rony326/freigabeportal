// Gemeinsames Verhalten des Grundgerüsts (views/_seite_anfang.ejs). Wird mit defer geladen.
(function () {
  var toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var root = document.documentElement;
      var next = root.getAttribute('data-theme') === 'dunkel' ? 'hell' : 'dunkel';
      root.setAttribute('data-theme', next);
      root.setAttribute('data-bs-theme', next === 'dunkel' ? 'dark' : 'light');
      document.cookie = 'theme=' + next + ';path=/;max-age=31536000;samesite=lax';
    });
  }

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
