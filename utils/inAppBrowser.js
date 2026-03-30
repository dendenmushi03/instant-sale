function detectInAppBrowser(userAgent = '') {
  if (!userAgent || typeof userAgent !== 'string') {
    return { isInAppBrowser: false, matchedApps: [] };
  }

  const ua = userAgent.toLowerCase();
  const appDetectors = [
    { name: 'x', test: /twitterandroid|twitterios|twitter/i },
    { name: 'instagram', test: /instagram/i },
    { name: 'line', test: /\bline\//i },
    { name: 'facebook', test: /fban|fbav|fb_iab|fb4a|fbios/i },
    { name: 'messenger', test: /messenger/i }
  ];
  const webViewDetectors = [
    /; wv\)/i,
    /\bwv\b/i,
    /webview/i,
    /(iphone|ipod|ipad).*applewebkit(?!.*safari)/i
  ];

  const matchedApps = appDetectors
    .filter((entry) => entry.test.test(ua))
    .map((entry) => entry.name);
  const isWebView = webViewDetectors.some((pattern) => pattern.test(ua));

  return {
    isInAppBrowser: matchedApps.length > 0 || isWebView,
    matchedApps
  };
}

module.exports = {
  detectInAppBrowser
};
