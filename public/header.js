(() => {
  const mnav = document.getElementById('mnav');
  if (!mnav) return;

  const summary = mnav.querySelector('.mnav__btn');
  const closeButton = mnav.querySelector('.mnav__close');
  const links = mnav.querySelectorAll('a[href]');
  const body = document.body;
  let savedScrollY = 0;
  let isLocked = false;

  const lockScroll = () => {
    if (isLocked) return;
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    body.classList.add('menu-open');
    body.style.top = `-${savedScrollY}px`;
    isLocked = true;
  };

  const unlockScroll = () => {
    if (!isLocked) return;
    body.classList.remove('menu-open');
    body.style.top = '';
    window.scrollTo(0, savedScrollY);
    isLocked = false;
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

  window.addEventListener('pageshow', closeMenu);
  window.addEventListener('pagehide', () => {
    closeMenu();
    unlockScroll();
  });
  window.addEventListener('beforeunload', unlockScroll);

  links.forEach((link) => {
    link.addEventListener('click', () => {
      closeMenu();
    });
  });

  if (closeButton) {
    closeButton.addEventListener('click', (event) => {
      event.preventDefault();
      closeMenu();
    });
  }

  syncState();
})();
