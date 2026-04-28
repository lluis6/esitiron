/* ==========================================================================
   ESÍTIRON — theme.js  (se carga en el <head> para evitar flash)
   ========================================================================== */
(function () {
  // Aplicar tema guardado ANTES de que el DOM se renderice
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }

  // Una vez el DOM esté listo, conectar el botón toggle
  document.addEventListener('DOMContentLoaded', function () {
    const btn     = document.getElementById('theme-toggle');
    const iconSun = document.getElementById('icon-sun');
    const iconMoon= document.getElementById('icon-moon');

    function applyTheme(isDark) {
      document.documentElement.classList.toggle('dark', isDark);
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
      if (iconSun)  iconSun.style.display  = isDark ? 'none'  : '';
      if (iconMoon) iconMoon.style.display = isDark ? ''      : 'none';
    }

    // Estado inicial del icono
    applyTheme(document.documentElement.classList.contains('dark'));

    if (btn) {
      btn.addEventListener('click', function () {
        applyTheme(!document.documentElement.classList.contains('dark'));
      });
    }
  });
})();
