import test from 'node:test';
import assert from 'node:assert/strict';
import { installEffortKeeper } from '../lib/bridge.js';

const SONNET = { provider: 'openrouter-custom', model: 'anthropic/claude-sonnet-5.5' };
const GEMINI = { provider: 'openrouter-custom', model: 'google/gemini-4-argon' };
const OPUS = { provider: 'openrouter-custom', model: 'anthropic/claude-opus-5.5' };

const models = {
  'anthropic/claude-sonnet-5.5': { reasoning: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id })) } },
  'google/gemini-4-argon': { reasoning: { efforts: ['low', 'medium', 'high'].map((id) => ({ id })) } },
  'anthropic/claude-opus-5.5': { reasoning: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id })) } },
};

function harness(options = {}) {
  let durable = options.initialState === undefined ? undefined : structuredClone(options.initialState);
  let current = options.current ?? null;
  const calls = [];
  const sessionId = options.sessionId ?? 'session-test';
  const blank = options.blank ?? false;
  const events = options.events ?? [];
  const agent = {
    id: sessionId,
    session: {
      header: { id: sessionId },
      snapshotEvents: () => events,
    },
  };
  const service = {
    async selectModel(request) {
      calls.push(structuredClone(request));
      current = {
        provider: request.provider,
        model: request.model,
        ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
      };
      return { selected: structuredClone(current) };
    },
  };
  const originalMethod = service.selectModel;
  const domain = {
    closed: false,
    global: {
      get: () => durable,
      set: async (value) => {
        durable = structuredClone(value);
      },
    },
    close: async () => {
      domain.closed = true;
    },
  };
  const disposers = [];
  const listeners = new Map();
  const ctx = {
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    sessionController: service,
    storageDomain: { open: async () => domain },
    llm: {
      async resolveModelInfo(provider, model) {
        if (provider !== 'openrouter-custom') throw new Error('unknown provider');
        const info = models[model];
        if (info === undefined) throw new Error('unknown model');
        return { provider, id: model, name: model, ...info };
      },
    },
    agents: {
      get(id) {
        return id === sessionId ? agent : undefined;
      },
      list() {
        return [agent];
      },
    },
    sessionProjections: {
      stateOf(_session, key) {
        if (key === 'modelSelection') {
          return current === null ? { lastUsed: null, pending: null } : { lastUsed: structuredClone(current), pending: null };
        }
        if (key === 'sessionListMetadata') return { blank };
        return undefined;
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return current ?? { ...options.defaultSelection ?? SONNET };
      },
    },
    effect(factory) {
      const cleanup = factory();
      disposers.push(cleanup);
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    inject(_deps, callback) {
      callback(ctx);
    },
  };
  return {
    ctx,
    service,
    domain,
    calls,
    originalMethod,
    get current() {
      return current;
    },
    get durable() {
      return durable;
    },
    async dispose() {
      for (const cleanup of disposers.reverse()) await cleanup();
    },
    async fire(event, payload) {
      for (const listener of listeners.get(event) ?? []) await listener(payload);
    },
  };
}

test('install decorates selectModel and restores the original method on dispose', async () => {
  const h = harness();
  const bridge = await installEffortKeeper(h.ctx);
  assert.notEqual(h.service.selectModel, h.originalMethod);
  assert.equal(h.service.selectModel.__effortKeeperWrapper, undefined);
  await h.dispose();
  assert.equal(h.service.selectModel, h.originalMethod);
  assert.equal(bridge.disposed, true);
});

test('model switch is rewritten to the saved effort in one native call', async () => {
  const h = harness({ current: { ...SONNET, reasoningEffort: 'high' } });
  const bridge = await installEffortKeeper(h.ctx);
  await bridge.remember(SONNET.provider, SONNET.model, 'high');
  await bridge.remember(OPUS.provider, OPUS.model, 'max');

  const result = await h.service.selectModel({ sessionId: 'session-test', ...OPUS });
  assert.equal(h.calls.length, 1); // remember() writes storage only; selectModel is called once
  assert.deepEqual(h.calls[0], { sessionId: 'session-test', ...OPUS, reasoningEffort: 'max' });
  assert.equal(result.selected.reasoningEffort, 'max');
  assert.equal(h.durable.preferences['openrouter-custom::anthropic/claude-opus-5.5'], 'max');
  await h.dispose();
});

test('manual effort change updates the stored value; Default is stored as null', async () => {
  const h = harness({ current: { ...SONNET, reasoningEffort: 'medium' } });
  const bridge = await installEffortKeeper(h.ctx);
  await bridge.remember(SONNET.provider, SONNET.model, 'medium');

  await h.service.selectModel({ sessionId: 'session-test', ...SONNET, reasoningEffort: 'high' });
  assert.equal(h.durable.preferences['openrouter-custom::anthropic/claude-sonnet-5.5'], 'high');

  await h.service.selectModel({ sessionId: 'session-test', ...SONNET });
  assert.equal(h.durable.preferences['openrouter-custom::anthropic/claude-sonnet-5.5'], null);
  await h.dispose();
});

test('switching to an unsupported saved effort falls back to the native request', async () => {
  const h = harness({ current: { ...SONNET, reasoningEffort: 'high' } });
  const bridge = await installEffortKeeper(h.ctx);
  await bridge.remember(GEMINI.provider, GEMINI.model, 'max'); // not advertised by Gemini

  await h.service.selectModel({ sessionId: 'session-test', ...GEMINI });
  assert.deepEqual(h.calls[0], { sessionId: 'session-test', ...GEMINI });
  assert.equal(h.durable.preferences['openrouter-custom::google/gemini-4-argon'], 'max');
  assert.equal(bridge.status().stats.unsupported, 1);
  await h.dispose();
});

test('new blank sessions restore their model preference without a user click', async () => {
  const h = harness({
    current: { ...SONNET },
    blank: true,
    defaultSelection: SONNET,
    initialState: {
      version: 1,
      preferences: { 'openrouter-custom::anthropic/claude-sonnet-5.5': 'high' },
    },
  });
  const bridge = await installEffortKeeper(h.ctx);
  const restoreCall = h.calls.at(-1);
  assert.equal(restoreCall.reasoningEffort, 'high');
  assert.equal(restoreCall.provider, SONNET.provider);
  assert.equal(restoreCall.model, SONNET.model);
  await h.dispose();
  assert.equal(bridge.disposed, true);
});

test('sessions with a committed turn are not retroactively changed on plugin mount', async () => {
  const h = harness({
    current: { ...SONNET, reasoningEffort: 'high' },
    blank: false,
    events: [{ type: 'turn/start', data: { turn: 1 } }],
  });
  const bridge = await installEffortKeeper(h.ctx);
  await bridge.remember(SONNET.provider, SONNET.model, 'high');
  await bridge.restoreForAgent({ id: 'session-test', session: { header: {}, snapshotEvents: () => [{ type: 'turn/start' }] } });
  assert.equal(h.calls.length, 0);
  await h.dispose();
});

test('dispose closes the durable domain and does not touch a newer wrapper', async () => {
  const h = harness();
  const bridge = await installEffortKeeper(h.ctx);
  const firstWrapper = h.service.selectModel;
  await h.dispose();
  assert.equal(h.domain.closed, true);
  assert.equal(h.service.selectModel, h.originalMethod);

  const second = await installEffortKeeper(h.ctx);
  assert.notEqual(h.service.selectModel, firstWrapper);
  await second.dispose();
});

test('hot reload swaps bridges without stacking decorators', async () => {
  const h = harness();
  const first = await installEffortKeeper(h.ctx);
  const wrapper = h.service.selectModel;
  const second = await installEffortKeeper(h.ctx);
  assert.equal(h.service.selectModel, wrapper, 'the second apply reuses the one wrapper');
  assert.equal(h.service[Symbol.for('dsh-effort-keeper.bridge.v1')], second);
  await second.dispose();
  assert.equal(h.service.selectModel, h.originalMethod, 'the inherited original is restored');
  await first.dispose();
  assert.equal(h.service.selectModel, h.originalMethod);
});
