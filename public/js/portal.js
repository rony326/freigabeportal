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
