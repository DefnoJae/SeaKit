// Run with Node.js 24+: node --test tests/auto-dub.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const path = require('node:path');

function setup(enabled = false, entryPage = false) {
  const values = new Map([['seakit.autoDub', enabled]]);
  const handlers = {};
  const screen = { pathname: entryPage ? '/entry' : '/onlinestream', searchParams: { id: '42' } };
  let navigate, buttons = [], pendingCreation, timer;
  const bridges = [];
  const inserted = [];
  const requests = [];
  let entryRequests = 0;
  const anchor = { after: (element) => inserted.push(element) };
  const container = { query: async () => [], queryOne: async () => anchor };
  const state = (initial) => ({ get: () => initial, set: (next) => { initial = next; } });
  const tray = new Proxy({}, { get: (_, name) => name === 'render' ? (fn) => fn() : () => {} });
  const context = {
    console, URLSearchParams,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, text: () => url.includes('myanimelist.net')
        ? '<span itemprop="ratingValue">8.03</span>'
        : '{"dubbed":[4155],"partial":[]}' };
    },
    $storage: { get: (key) => values.get(key), set: (key, value) => values.set(key, value) },
    $ui: { register: (fn) => fn({
      state, newTray: () => tray,
      setTimeout(fn) { timer = fn; return () => { timer = null; }; },
      anime: { getAnimeEntry: async () => { entryRequests++; return { media: { idMal: 4155 } }; } },
      registerEventHandler: (name, fn) => { handlers[name] = fn; },
      screen: {
        state: () => { throw new Error('screen.state() causes a navigation feedback loop'); },
        onNavigate: (fn) => { navigate = fn; }, loadCurrent() {},
      },
      dom: {
        observe() { throw new Error('Broad mutation observer must not be installed'); },
        onReady() {}, onMainTabReady() {},
        queryOne: async () => container,
        query: async (selector, opts) => {
          if (selector === 'button') {
            assert.equal(opts.withInnerHTML, true);
            return buttons;
          }
          return bridges.filter((b) => b.isConnected);
        },
        createElement: async () => {
          if (pendingCreation) await pendingCreation;
          const bridge = {
            isConnected: false, button: null, html: '', attributes: {},
            setAttribute(key, value) { this.attributes[key] = value; },
            setStyle() {}, setInnerHTML(html) { this.html = html; }, append() {},
            remove() { this.isConnected = false; },
            closest() { return this.button; },
          };
          bridges.push(bridge);
          return bridge;
        },
      },
    }) },
  };
  vm.runInNewContext(stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../SeaKit.ts'), 'utf8')) + '\ninit();', context);
  const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
  return {
    screen, values, bridges,
    setButtons(next) { buttons = next; },
    inserted, requests, entryRequests: () => entryRequests,
    burst(count) { for (let i = 0; i < count; i++) navigate(screen); },
    setCreation: (promise) => { pendingCreation = promise; },
    button(id = 'dub-button', text = 'Switch to dub', disabled = false) {
      return {
        id, innerHTML: `<svg></svg>${text}`, textContent: text,
        attributes: disabled ? { disabled: '' } : {}, disabled, clicks: 0,
        async getText() { return this.textContent; },
        append(bridge) { bridge.button = this; bridge.isConnected = true; },
        click() { this.clicks++; this.textContent = 'Switch to subs'; },
      };
    },
    async emit(next) { buttons = next; navigate(screen); await flush(); },
    async tick() { const next = timer; timer = null; if (next) next(); await flush(); },
    async toggle() { await handlers['seakit-toggle-auto-dub'](); await flush(); },
    async navigate() { screen.pathname = '/other'; await navigate(screen); await flush(); },
    load(bridge) {
      const handler = bridge.html.match(/onload="([\s\S]*?)" src=/)[1].replaceAll('&amp;', '&');
      vm.runInNewContext(`(function(){${handler}}).call(image)`, {
        image: { parentElement: bridge }, URLSearchParams,
        location: { pathname: screen.pathname, search: `?id=${screen.searchParams.id}` },
      });
    },
  };
}

test('default off; toggle persists and selects dub once; manual subs stay selected', async () => {
  const app = setup();
  const button = app.button();
  await app.emit([button]);
  assert.equal(app.bridges.length, 0);
  await app.toggle();
  assert.equal(app.values.get('seakit.autoDub'), true);
  app.load(app.bridges[0]);
  assert.equal(button.clicks, 1);
  button.textContent = 'Switch to dub'; // User manually chose subs.
  await app.emit([app.button('unrelated', 'Cache')]);
  await app.emit([button]);
  assert.equal(app.bridges.length, 1);
  await app.toggle();
  assert.equal(app.values.get('seakit.autoDub'), false);
});

test('already dub, disabled, and unrelated controls are not clicked', async () => {
  const app = setup(true);
  await app.emit([app.button('dub', 'Switch to subs'), app.button('disabled', 'Switch to dub', true), app.button('other', 'Cache')]);
  assert.equal(app.bridges.length, 0);
  await app.emit([app.button('disabled')]);
  assert.equal(app.bridges.length, 1);
});

test('new anime or remounted streaming controls get a fresh attempt', async () => {
  const app = setup(true);
  await app.emit([app.button()]);
  app.screen.searchParams.id = '43';
  await app.emit([app.button()]);
  await app.emit([app.button('remounted')]);
  assert.equal(app.bridges.length, 3);
});

test('late image load rechecks navigation and manual selection', async () => {
  const app = setup(true);
  const button = app.button();
  await app.emit([button]);
  app.screen.searchParams.id = '43';
  app.load(app.bridges[0]);
  assert.equal(button.clicks, 0);
  await app.emit([button]);
  button.textContent = 'Switch to subs';
  app.load(app.bridges[1]);
  assert.equal(button.clicks, 0);
});

test('disabling while DOM creation is pending cancels automatic selection', async () => {
  const app = setup(true);
  let release;
  app.setCreation(new Promise((resolve) => { release = resolve; }));
  await app.emit([app.button()]);
  await app.toggle();
  release();
  await app.emit([]);
  assert.equal(app.bridges[0].isConnected, false);
});

test('late streaming controls are found by timer without navigation subscriptions', async () => {
  const app = setup(true);
  await app.emit([]);
  const button = app.button();
  app.setButtons([button]);
  await app.tick();
  app.load(app.bridges[0]);
  button.textContent = 'Switch to dub';
  await app.tick();
  await app.tick();
  assert.equal(button.clicks, 1);
  assert.equal(app.bridges.length, 1);
  await app.navigate();
  await app.tick();
  assert.equal(app.bridges.length, 1);
});

test('repeated navigation snapshots render MAL and dub once and fetch dub data once', async () => {
  const app = setup(false, true);
  app.burst(30);
  await app.emit([]);
  assert.equal(app.entryRequests(), 1);
  assert.equal(app.requests.filter(url => url.includes('dubbed_english.json')).length, 1);
  assert.equal(app.inserted.filter(element => element.attributes['data-seakit-mal']).length, 1);
  assert.equal(app.inserted.filter(element => element.attributes['data-seakit-dub']).length, 1);
});
