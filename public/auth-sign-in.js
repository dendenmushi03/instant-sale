(function () {
  var body = document.body;
  var btn = document.getElementById('googleSignInBtn');
  var modal = document.getElementById('inAppBrowserModal');
  var closeBtn = document.getElementById('inAppBrowserModalClose');
  var showInAppGuidance = body && body.getAttribute('data-show-inapp-guidance') === 'true';

  if (!body || !btn || !modal || !closeBtn) return;

  function openModal() {
    modal.hidden = false;
    body.classList.add('authSignInModalOpen');
  }

  function closeModal() {
    modal.hidden = true;
    body.classList.remove('authSignInModalOpen');
  }

  btn.addEventListener('click', function (event) {
    if (!showInAppGuidance) return;
    event.preventDefault();
    openModal();
  });

  closeBtn.addEventListener('click', closeModal);

  modal.addEventListener('click', function (event) {
    if (event.target && event.target.getAttribute('data-modal-close') === 'true') {
      closeModal();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) {
      closeModal();
    }
  });

  if (showInAppGuidance) {
    openModal();
  }
})();
