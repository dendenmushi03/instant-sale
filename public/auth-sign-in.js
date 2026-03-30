(function () {
  var body = document.body;
  var btn = document.getElementById('googleSignInBtn');
  var modal = document.getElementById('inAppBrowserModal');
  var closeBtn = document.getElementById('inAppBrowserModalClose');
  var showInAppGuidance = body && body.getAttribute('data-show-inapp-guidance') === 'true';

  if (!body || !btn || !modal || !closeBtn) return;

  function detectInAppBrowser(userAgent) {
    if (!userAgent || typeof userAgent !== 'string') return false;
    var ua = userAgent.toLowerCase();
    var appDetectors = [
      /twitterandroid|twitterios|twitter/i,
      /instagram/i,
      /line\//i,
      /fban|fbav|fb_iab|fb4a|fbios/i,
      /messenger/i
    ];
    var webViewDetectors = [
      /; wv\)/i,
      /\bwv\b/i,
      /webview/i,
      /(iphone|ipod|ipad).*applewebkit(?!.*safari)/i
    ];
    var matchedApp = appDetectors.some(function (pattern) { return pattern.test(ua); });
    var matchedWebView = webViewDetectors.some(function (pattern) { return pattern.test(ua); });
    return matchedApp || matchedWebView;
  }

  function removeInAppQueryParam() {
    if (typeof window === 'undefined' || !window.history || !window.history.replaceState) return;
    var url = new URL(window.location.href);
    if (!url.searchParams.has('inapp')) return;
    url.searchParams.delete('inapp');
    var next = url.pathname + (url.search ? url.search : '') + url.hash;
    window.history.replaceState({}, '', next);
  }

  function openModal() {
    modal.hidden = false;
    body.classList.add('authSignInModalOpen');
  }

  function closeModal() {
    modal.hidden = true;
    body.classList.remove('authSignInModalOpen');
  }

  btn.addEventListener('click', function (event) {
    if (!detectInAppBrowser(window.navigator.userAgent || '')) return;
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
    if (detectInAppBrowser(window.navigator.userAgent || '')) {
      openModal();
    }
    removeInAppQueryParam();
  }
})();
