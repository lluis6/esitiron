/* ==========================================================================
   ESÍTIRON — theme.js  (se carga en el <head> para evitar flash)
   ========================================================================== */
(function () {
  // Aplicar tema guardado ANTES de que el DOM se renderice
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }

  // Una vez el DOM esté listo, conectar el botón toggle y otras funciones visuales
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

    /* ================================================================
       AUTO-SCROLL DEL MENÚ EN MÓVILES
       ================================================================ */
    if (window.innerWidth <= 850) {
      // Le damos 100ms al navegador para renderizar el CSS antes de mover el scroll
      setTimeout(() => {
        const navContainer = document.querySelector('.nav-links');
        // Buscamos si hay un enlace activo (Productos, Tiquets...) o el perfil de usuario (estilos inline)
        const activeLink = document.querySelector('.nav-link.active') || document.querySelector('.nav-user[style*="var(--accent)"]');
        
        if (navContainer && activeLink) {
          // Modificamos el scroll al instante para evitar el bug de iOS con scroll-snap
          // Restamos 15px de margen para que se vea por dónde hemos cortado
          navContainer.scrollLeft = activeLink.offsetLeft - 15;
        }
      }, 100);
    }
  });
})();