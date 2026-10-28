/**
 * EffortKeeper's pure state and selection rules.
 *
 * No DSH imports live here on purpose: the rules are unit-testable with plain
 * Node and the shipped plugin has no runtime dependencies beyond Node itself.
 */

/** Durable state schema version. Bump only with a migration. */
export const STATE_VERSION = 1;

/** Separator used by the readable preference key. */
export const KEY_SEPARATOR = '::';

/** Explicit "use the provider/DSH default" marker. */
export const DEFAULT_EFFORT = null;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EFFORT_RE = /^[A-Za-z0-9][A-Za-z0-9._:+\/-]{0,127}$/;
const MAX_KEY_LENGTH = 600;

/**
 * Build the stable, readable identity for one provider-owned model.
 * Display names are never used: two providers may expose the same model id.
 * @param {string} provider
 * @param {string} model
 * @returns {string}
 */
export function modelKey(provider, model) {
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new TypeError('provider must be a non-empty string');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('model must be a non-empty string');
  }
  const key = `${provider}${KEY_SEPARATOR}${model}`;
  if (key.length > MAX_KEY_LENGTH) throw new TypeError('provider/model identity is too long');
  return key;
}

/**
 * True when two selection-like values name the same provider/model route.
 * @param {{ provider?: string, model?: string } | null | undefined} left
 * @param {{ provider?: string, model?: string } | null | undefined} right
 * @returns {boolean}
 */
export function isSameModel(left, right) {
  return left !== null && left !== undefined
    && right !== null && right !== undefined
    && left.provider === right.provider
    && left.model === right.model;
}

/**
 * Read the user's raw effort choice from a selection request.
 * `undefined` means the UI's "provider default" row; null is our stored marker.
 * @param {{ reasoningEffort?: string } | null | undefined} selection
 * @returns {string | null}
 */
export function rawEffort(selection) {
  return typeof selection?.reasoningEffort === 'string' && selection.reasoningEffort.length > 0
    ? selection.reasoningEffort
    : DEFAULT_EFFORT;
}

/** Return a copy without the `reasoningEffort` property. */
export function withoutEffort(selection) {
  const { reasoningEffort: _discarded, ...rest } = selection;
  return rest;
}

/**
 * Validate one durable effort value.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeEffort(value) {
  if (value === DEFAULT_EFFORT) return DEFAULT_EFFORT;
  if (typeof value !== 'string' || !EFFORT_RE.test(value)) {
    throw new TypeError(`invalid reasoning effort: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Validate and detach a complete durable state document.
 * Accepts the object stored in the profile storage domain and the JSON shape
 * documented in the README.
 * @param {unknown} value
 * @returns {{ version: 1, preferences: Record<string, string | null> }}
 */
export function parseState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('EffortKeeper state must be an object');
  }
  if (value.version !== STATE_VERSION) {
    throw new TypeError(`unsupported EffortKeeper state version: ${String(value.version)}`);
  }
  const source = value.preferences;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('EffortKeeper preferences must be an object');
  }
  const preferences = Object.create(null);
  for (const [key, effort] of Object.entries(source)) {
    if (DANGEROUS_KEYS.has(key)) throw new TypeError(`unsafe preference key: ${key}`);
    if (key.length === 0 || key.length > MAX_KEY_LENGTH || !key.includes(KEY_SEPARATOR)) {
      throw new TypeError(`invalid preference key: ${JSON.stringify(key)}`);
    }
    preferences[key] = normalizeEffort(effort);
  }
  return Object.freeze({
    version: STATE_VERSION,
    preferences: Object.freeze(preferences),
  });
}

/** Return an empty state document. */
export function createState() {
  return Object.freeze({
    version: STATE_VERSION,
    preferences: Object.freeze(Object.create(null)),
  });
}

/**
 * In-memory preference store. Writes are synchronous; persistence is owned by
 * the host bridge so the selection path never has to touch storage directly.
 */
export class PreferenceStore {
  /** @param {unknown} [state] */
  constructor(state = createState()) {
    const parsed = parseState(state);
    /** @type {Map<string, string | null>} */
    this.values = new Map(Object.entries(parsed.preferences));
  }

  /** @param {string} provider @param {string} model */
  get(provider, model) {
    return this.values.get(modelKey(provider, model));
  }

  /** @param {string} provider @param {string} model */
  has(provider, model) {
    return this.values.has(modelKey(provider, model));
  }

  /** @param {string} provider @param {string} model @param {string | null} effort */
  set(provider, model, effort) {
    const key = modelKey(provider, model);
    const normalized = normalizeEffort(effort);
    if (this.values.get(key) === normalized && this.values.has(key)) return false;
    this.values.set(key, normalized);
    return true;
  }

  /** @param {string} provider @param {string} model */
  delete(provider, model) {
    return this.values.delete(modelKey(provider, model));
  }

  get size() {
    return this.values.size;
  }

  /** Stable, detached durable document. */
  snapshot() {
    const preferences = Object.create(null);
    for (const key of [...this.values.keys()].sort()) {
      preferences[key] = this.values.get(key);
    }
    return {
      version: STATE_VERSION,
      preferences,
    };
  }
}

/**
 * Decide what a model switch should do with a saved preference.
 *
 * Cases:
 *  - no saved preference -> keep native model default;
 *  - explicit Default (null) -> remove any effort the native model row added;
 *  - saved effort still advertised -> restore it;
 *  - saved effort no longer advertised -> fall back, never send it;
 *  - the native call already carries an explicit non-default effort -> honour
 *    that user intent instead of overwriting it.
 *
 * @param {object} input
 * @param {{ provider: string, model: string, reasoningEffort?: string } | null | undefined} input.previous
 * @param {{ provider: string, model: string, reasoningEffort?: string }} input.request
 * @param {string | null | undefined} input.preference
 * @param {{ reasoning?: { efforts?: Array<{ id: string }>, defaultEffort?: string } } | undefined} input.modelInfo
 * @returns {{ action: 'pass' | 'restore' | 'honour-explicit', request: object, reason: string }}
 */
export function decideModelSwitch({ previous, request, preference, modelInfo }) {
  if (preference === undefined) {
    return { action: 'pass', request, reason: 'no-preference' };
  }

  const efforts = modelInfo?.reasoning?.efforts;
  const defaultEffort = modelInfo?.reasoning?.defaultEffort;

  if (preference === DEFAULT_EFFORT) {
    if (request.reasoningEffort === undefined) {
      return { action: 'pass', request, reason: 'already-default' };
    }
    return {
      action: 'restore',
      request: withoutEffort(request),
      reason: 'explicit-default',
    };
  }

  if (efforts === undefined) {
    return { action: 'pass', request, reason: 'unknown-capabilities' };
  }
  if (!efforts.some((effort) => effort?.id === preference)) {
    return { action: 'pass', request, reason: 'unsupported-effort' };
  }

  if (request.reasoningEffort === preference) {
    return { action: 'pass', request, reason: 'already-selected' };
  }

  // Native model rows pass the model's default effort, not a user's effort
  // choice. Only an effort different from that default is unambiguous intent.
  if (request.reasoningEffort !== undefined
    && request.reasoningEffort !== defaultEffort
    && request.reasoningEffort !== preference) {
    return { action: 'honour-explicit', request, reason: 'explicit-effort' };
  }

  return {
    action: 'restore',
    request: { ...request, reasoningEffort: preference },
    reason: 'restored-preference',
  };
}

/**
 * Describes which persisted value an unchanged-model effort selection should
 * store. `null` denotes the user's explicit provider-default choice.
 * @param {{ reasoningEffort?: string }} request
 */
export function effortToRemember(request) {
  return rawEffort(request);
}

/**
 * True when a selection request carries the same effective raw effort as the
 * current selection. A native model default may be materialised in either.
 * @param {{ reasoningEffort?: string } | null | undefined} previous
 * @param {{ reasoningEffort?: string } | null | undefined} next
 */
export function sameRawEffort(previous, next) {
  return rawEffort(previous) === rawEffort(next);
}
