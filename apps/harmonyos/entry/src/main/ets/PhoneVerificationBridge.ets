export const VERIFICATION_ORIGIN = 'https://h5.app.polestar-auto.com';
export const VERIFICATION_PAGE = VERIFICATION_ORIGIN + '/account-components/auth-slider/index.html?from=webview';

export const VERIFICATION_SCRIPT = `(() => {
  if (!window.__norrVerificationListener) {
    window.addEventListener('message', (event) => {
      if (event.origin !== '${VERIFICATION_ORIGIN}' || event.source !== window) return;
      if (!event.data || typeof event.data !== 'object') return;
      NorrVerification.postMessage(JSON.stringify(event.data));
    });
    window.__norrVerificationListener = true;
  }
  return typeof NorrVerification !== 'undefined' && typeof NorrVerification.postMessage === 'function';
})()`;
