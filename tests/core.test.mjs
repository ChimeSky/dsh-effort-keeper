import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EFFORT,
  PreferenceStore,
  createState,
  decideModelSwitch,
  effortToRemember,
  isSameModel,
  modelKey,
  parseState,
  rawEffort,
  sameRawEffort,
} from '../lib/core.js';

const sonnet = { provider: 'openrouter-custom', model: 'anthropic/claude-sonnet-5.5' };
const gemini = { provider: 'openrouter-custom', model: 'google/gemini-4-argon' };
const opus = { provider: 'openrouter-custom', model: 'anthropic/claude-opus-5.5' };

const info = (...efforts) => ({ reasoning: { efforts: efforts.map((id) => ({ id })) } });

test('model identity is provider + model, never display name', () => {
  assert.equal(modelKey('openrouter-custom', 'anthropic/claude-sonnet-5.5'), 'openrouter-custom::anthropic/claude-sonnet-5.5');
  assert.notEqual(modelKey('provider-a', 'same-model'), modelKey('provider-b', 'same-model'));
  assert.equal(isSameModel(sonnet, { ...sonnet, name: 'different display name' }), true);
  assert.equal(isSameModel(sonnet, { provider: 'other', model: sonnet.model }), false);
});

test('state round-trips explicit effort, provider default, and absence', () => {
  const state = {
    version: 1,
    preferences: {
      [modelKey(sonnet.provider, sonnet.model)]: 'high',
      [modelKey(opus.provider, opus.model)]: null,
    },
  };
  const parsed = parseState(state);
  assert.equal(parsed.preferences[modelKey(sonnet.provider, sonnet.model)], 'high');
  assert.equal(parsed.preferences[modelKey(opus.provider, opus.model)], null);
  const store = new PreferenceStore(parsed);
  assert.equal(store.get(sonnet.provider, sonnet.model), 'high');
  assert.equal(store.get(opus.provider, opus.model), null);
  assert.equal(store.get(gemini.provider, gemini.model), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(store.snapshot())), state);
});

test('invalid durable values are rejected', () => {
  assert.throws(() => parseState(null), /object/);
  assert.throws(() => parseState({ version: 2, preferences: {} }), /version/);
  assert.throws(() => parseState({ version: 1, preferences: [] }), /preferences/);
  assert.throws(() => parseState({ version: 1, preferences: { 'not-a-key': 'high' } }), /preference key/);
  assert.throws(() => parseState({ version: 1, preferences: { [modelKey('p', 'm')]: 3 } }), /invalid reasoning effort/);
  assert.throws(() => parseState({ version: 1, preferences: { [modelKey('p', 'm')]: '' } }), /invalid reasoning effort/);
});

test('first visit to a model never restores anything', () => {
  const decision = decideModelSwitch({
    previous: sonnet,
    request: { ...gemini },
    preference: undefined,
    modelInfo: info('low', 'medium', 'high'),
  });
  assert.equal(decision.action, 'pass');
  assert.equal(decision.reason, 'no-preference');
  assert.deepEqual(decision.request, gemini);
});

test('switch to Sonnet restores High in a single rewritten request', () => {
  const decision = decideModelSwitch({
    previous: gemini,
    request: { ...sonnet },
    preference: 'high',
    modelInfo: info('low', 'medium', 'high', 'xhigh', 'max'),
  });
  assert.equal(decision.action, 'restore');
  assert.equal(decision.request.reasoningEffort, 'high');
  assert.equal(decision.request.provider, sonnet.provider);
});

test('switch to Gemini restores Medium even when the native row supplied a model default', () => {
  const decision = decideModelSwitch({
    previous: sonnet,
    request: { ...gemini, reasoningEffort: 'low' },
    preference: 'medium',
    modelInfo: { reasoning: { defaultEffort: 'low', efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] } },
  });
  assert.equal(decision.action, 'restore');
  assert.equal(decision.request.reasoningEffort, 'medium');
});

test('switch to Opus restores Max', () => {
  const decision = decideModelSwitch({
    previous: gemini,
    request: { ...opus },
    preference: 'max',
    modelInfo: info('low', 'medium', 'high', 'xhigh', 'max'),
  });
  assert.equal(decision.action, 'restore');
  assert.equal(decision.request.reasoningEffort, 'max');
});

test('explicit Default removes a model-default effort and is never replaced by an old value', () => {
  const decision = decideModelSwitch({
    previous: sonnet,
    request: { ...opus, reasoningEffort: 'high' },
    preference: DEFAULT_EFFORT,
    modelInfo: info('low', 'medium', 'high', 'xhigh', 'max'),
  });
  assert.equal(decision.action, 'restore');
  assert.equal(decision.reason, 'explicit-default');
  assert.equal(Object.hasOwn(decision.request, 'reasoningEffort'), false);
  assert.equal(rawEffort(decision.request), null);
});

test('unsupported saved effort is never sent to the model', () => {
  const decision = decideModelSwitch({
    previous: sonnet,
    request: { ...gemini },
    preference: 'max',
    modelInfo: info('low', 'medium', 'high'),
  });
  assert.equal(decision.action, 'pass');
  assert.equal(decision.reason, 'unsupported-effort');
  assert.equal(decision.request.reasoningEffort, undefined);
});

test('unknown capabilities keep DSH native behavior', () => {
  const decision = decideModelSwitch({
    previous: sonnet,
    request: { ...gemini },
    preference: 'high',
    modelInfo: undefined,
  });
  assert.equal(decision.action, 'pass');
  assert.equal(decision.reason, 'unknown-capabilities');
});

test('a native explicit effort different from the model default wins', () => {
  const decision = decideModelSwitch({
    previous: sonnet,
    request: { ...opus, reasoningEffort: 'max' },
    preference: 'high',
    modelInfo: { reasoning: { defaultEffort: 'medium', efforts: [{ id: 'medium' }, { id: 'high' }, { id: 'max' }] } },
  });
  assert.equal(decision.action, 'honour-explicit');
  assert.equal(decision.request.reasoningEffort, 'max');
});

test('same-model effort changes are the only thing saved, and Default is explicit', () => {
  const request = { ...sonnet, reasoningEffort: 'high' };
  assert.equal(effortToRemember(request), 'high');
  assert.equal(effortToRemember({ ...sonnet }), null);
  assert.notEqual(effortToRemember({ ...sonnet }), 'medium');

  const store = new PreferenceStore();
  assert.equal(store.set(sonnet.provider, sonnet.model, 'medium'), true);
  assert.equal(store.set(sonnet.provider, sonnet.model, 'high'), true);
  assert.equal(store.get(sonnet.provider, sonnet.model), 'high');
  assert.equal(store.set(sonnet.provider, sonnet.model, 'high'), false);
  assert.equal(store.set(sonnet.provider, sonnet.model, null), true);
  assert.equal(store.get(sonnet.provider, sonnet.model), null);
  assert.equal(store.snapshot().preferences[modelKey(sonnet.provider, sonnet.model)], null);
});

test('same-model comparisons distinguish absence from an explicit effort', () => {
  assert.equal(sameRawEffort({ ...sonnet }, { ...sonnet }), true);
  assert.equal(sameRawEffort({ ...sonnet, reasoningEffort: 'high' }, { ...sonnet, reasoningEffort: 'high' }), true);
  assert.equal(sameRawEffort({ ...sonnet }, { ...sonnet, reasoningEffort: 'high' }), false);
  assert.equal(sameRawEffort({ ...sonnet, reasoningEffort: 'high' }, { ...sonnet }), false);
  const empty = createState();
  assert.equal(empty.version, 1);
  assert.equal(Object.keys(empty.preferences).length, 0);
});
