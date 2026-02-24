(() => {
  const mnav = document.getElementById('mnav');
  if (!mnav) return;

  const summary = mnav.querySelector('.mnav__btn');
  const links = mnav.querySelectorAll('a[href]');
  const body = document.body;
  let savedScrollY = 0;

  const lockScroll = () => {
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    body.classList.add('menu-open');
    body.style.top = `-${savedScrollY}px`;
  };

  const unlockScroll = () => {
    body.classList.remove('menu-open');
    body.style.top = '';
    window.scrollTo(0, savedScrollY);
  };

  const syncState = () => {
    const isOpen = mnav.open;
    if (summary) {
      summary.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
    if (isOpen) {
      lockScroll();
    } else {
      unlockScroll();
    }
  };

  const closeMenu = () => {
    if (!mnav.open) return;
    mnav.open = false;
    syncState();
  };

  mnav.addEventListener('toggle', syncState);

  document.addEventListener('pointerdown', (event) => {
    if (!mnav.open) return;
    const target = event.target;
    if (target instanceof Node && mnav.contains(target)) return;
    closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
    }
  });

  links.forEach((link) => {
    link.addEventListener('click', () => {
      closeMenu();
    });
  });

  window.addEventListener('pagehide', unlockScroll);
  window.addEventListener('beforeunload', unlockScroll);

  syncState();
})();
