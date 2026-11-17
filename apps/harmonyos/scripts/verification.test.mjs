import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../entry/src/main/ets/PhoneVerificationBridge.ets', import.meta.url), 'utf8');
const { VERIFICATION_ORIGIN, VERIFICATION_PAGE, VERIFICATION_SCRIPT } = await import(
  'data:text/javascript,' + encodeURIComponent(source)
);

function page() {
  const listeners = [];
  const received = [];
  const window = { addEventListener: (type, listener) => {
    assert.equal(type, 'message');
    listeners.push(listener);
  } };
  const context = vm.createContext({ window, NorrVerification: { postMessage: text => received.push(JSON.parse(text)) } });
  const ready = vm.runInContext(VERIFICATION_SCRIPT, context);
  return { window, context, listeners, received, ready };
}

test('verification uses the official WebView callback independent of user agent', () => {
  assert.equal(new URL(VERIFICATION_PAGE).searchParams.get('from'), 'webview');
  const view = page();
  assert.equal(view.ready, true);
  const data = { sessionId: 'test-session', sig: 'test-signature', token: 'test-token' };
  view.listeners[0]({ origin: VERIFICATION_ORIGIN, source: view.window, data });
  assert.deepEqual(view.received, [data]);
});

test('verification rejects messages from other origins and frames', () => {
  const view = page();
  for (const origin of ['null', 'https://example.com', VERIFICATION_ORIGIN + '.example.com']) {
    view.listeners[0]({ origin, source: view.window, data: {} });
  }
  view.listeners[0]({ origin: VERIFICATION_ORIGIN, source: {}, data: {} });
  assert.deepEqual(view.received, []);
});

test('document-start and page-end injection register a single listener', () => {
  const view = page();
  vm.runInContext(VERIFICATION_SCRIPT, view.context);
  assert.equal(view.listeners.length, 1);
});

test('verification ignores non-object page messages', () => {
  const view = page();
  for (const data of [null, undefined, 'ready', 1]) {
    view.listeners[0]({ origin: VERIFICATION_ORIGIN, source: view.window, data });
  }
  assert.deepEqual(view.received, []);
});
