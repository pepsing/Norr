import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bridge = readFileSync(new URL('../src-tauri/src/verification_windows.js', import.meta.url), 'utf8');
const proof = { sessionId: 'fixture-session', sig: 'fixture-sig', token: 'fixture-token' };
const origin = 'https://h5.app.polestar-auto.com';

function verificationWindow(invoke = async () => {}) {
  const messages = new Map();
  const events = new Map();
  const calls = [];
  const status = { textContent: '' };
  const window = {
    addEventListener: (name, callback) => messages.set(name, callback),
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        calls.push({ command, ...args });
        return invoke(command, args);
      },
    },
  };
  window.top = window;
  const document = {
    addEventListener: (name, callback) => events.set(name, callback),
    getElementById: () => status,
  };
  vm.runInNewContext(bridge, {
    window, document,
    location: { origin, pathname: '/account-components/auth-slider/index.html' },
  });
  return { window, calls, status, events, message: messages.get('message') };
}

test('Windows verification selects the official webview callback and forwards its proof once', async () => {
  const source = readFileSync(new URL('../src-tauri/src/verification_windows.rs', import.meta.url), 'utf8');
  const page = source.match(/const PAGE: &str\s*=\s*"([^"]+)"/)[1];
  assert.equal(new URL(page).searchParams.get('from'), 'webview');
  const view = verificationWindow();
  const event = { source: view.window, origin, data: proof };
  view.message(event);
  view.message(event);
  await Promise.resolve();
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0].command, 'submit_verification');
  assert.deepEqual(JSON.parse(view.calls[0].payload), proof);
});

test('verification ignores messages from foreign origins, frames and unrelated objects', () => {
  const view = verificationWindow();
  view.message({ source: view.window, origin: 'https://example.org', data: proof });
  view.message({ source: {}, origin, data: proof });
  view.message({ source: view.window, origin, data: { event: 'ready' } });
  assert.equal(view.calls.length, 0);
});

test('IPC rejection shows a recoverable error and permits another submission', async () => {
  const view = verificationWindow(async () => { throw new Error('ACL rejection'); });
  await view.window.chromium.postMessage(JSON.stringify(proof));
  assert.match(view.status.textContent, /未能提交/);
  await view.window.chromium.postMessage(JSON.stringify(proof));
  assert.equal(view.calls.length, 2);
});

test('Escape cancels verification with a null result', async () => {
  const view = verificationWindow();
  view.events.get('keydown')({ key: 'Escape' });
  await Promise.resolve();
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0].payload, null);
});
