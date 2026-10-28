/**
 * Host-side EffortKeeper bridge.
 *
 * DSH exposes one authoritative `sessionController.selectModel` entry point.
 * Both the composer model menu and the `/model` popup ultimately call it. The
 * bridge decorates that method (and restores the original on unload), so a
 * model switch is rewritten before it reaches the Host, in the same request:
 *
 *   user selects Sonnet -> bridge finds "high" -> one native selectModel call
 *
 * This avoids a second RPC, a visible wrong-effort frame, and feedback loops.
 */
import {
  DEFAULT_EFFORT,
  PreferenceStore,
  decideModelSwitch,
  effortToRemember,
  isSameModel,
  parseState,
  rawEffort,
  sameRawEffort,
} from './core.js';

const BRIDGE = Symbol.for('dsh-effort-keeper.bridge.v1');
const DOMAIN_NAME = 'effort_keeper';
const STATE_KEY = 'singleton';

/**
 * Build a storage-domain spec without importing zod/schemastery. The storage
 * domain only requires `parse` on a table/global schema; keeping it local lets
 * the plugin install without any npm dependency.
 */
function createDomainSpec() {
  const stateSchema = {
    parse(value) {
      return parseState(value);
    },
    safeParse(value) {
      try {
        return { success: true, data: parseState(value) };
      } catch (error) {
        return { success: false, error };
      }
    },
  };
  return {
    name: DOMAIN_NAME,
    version: 1,
    layout: 'single',
    tables: {},
    global: {
      schema: stateSchema,
      initial: { version: 1, preferences: {} },
    },
  };
}

/**
 * Open the official durable domain. Returns null when the deployment lacks the
 * storage form or the domain cannot be opened; the in-memory store still works.
 * @param {any} ctx
 * @param {string} log
 */
async function openPreferenceDomain(ctx, log) {
  if (typeof ctx.storageDomain?.open !== 'function') {
    log('warn', 'ctx.storageDomain is unavailable; preferences will be in-memory only');
    return null;
  }
  try {
    const domain = await ctx.storageDomain.open(createDomainSpec());
    return domain;
  } catch (error) {
    log('warn', `could not open storage domain ${DOMAIN_NAME}: ${String(error)}`);
    return null;
  }
}

/** Read the durable state, tolerating a missing/empty domain. */
async function loadState(domain, log) {
  if (domain === null) return undefined;
  try {
    const state = domain.global?.get?.();
    return state === undefined ? undefined : state;
  } catch (error) {
    log('warn', `could not read preferences: ${String(error)}`);
    return undefined;
  }
}

/**
 * The live bridge. It owns the in-memory preference store, the serialized
 * write chain, and the one installed method decorator.
 */
export class EffortKeeperBridge {
  /**
   * @param {any} ctx Cordis context
   * @param {any} service sessionController service
   * @param {any} domain opened storage domain or null
   * @param {PreferenceStore} store
   * @param {(level: string, message: string) => void} log
   */
  constructor(ctx, service, domain, store, log) {
    this.ctx = ctx;
    this.service = service;
    this.domain = domain;
    this.store = store;
    this.log = log;
    this.writeChain = Promise.resolve();
    this.disposed = false;
    this.internalSessions = new Set();
    this.restoredSessions = new Set();
    this.stats = { restores: 0, saves: 0, unsupported: 0, failures: 0 };
    this.wrapper = null;
    this.previousOwnDescriptor = undefined;
    this.original = service.selectModel;
    this.timers = new Set();
  }

  /** Install (or replace) the bridge slot on the service. */
  install() {
    const existing = this.service[BRIDGE];
    this.previousOwnDescriptor = Object.getOwnPropertyDescriptor(this.service, 'selectModel');
    const original = existing?.original ?? this.original;
    this.original = original;

    if (existing === undefined) {
      const bridge = this;
      this.wrapper = function effortKeeperSelectModel(request) {
        const current = bridge.service[BRIDGE];
        if (current === undefined) return original.call(bridge.service, request);
        return current.handle(request, (nextRequest) => original.call(bridge.service, nextRequest));
      };
      try {
        this.service[BRIDGE] = this;
        this.service.selectModel = this.wrapper;
      } catch (error) {
        delete this.service[BRIDGE];
        throw new Error(`effort-keeper: cannot decorate sessionController.selectModel: ${String(error)}`);
      }
    } else {
      // Hot reload: keep the existing wrapper, point it at this newer bridge,
      // and inherit the descriptor that predates the wrapper.
      this.wrapper = existing.wrapper;
      this.previousOwnDescriptor = existing.previousOwnDescriptor;
      this.service[BRIDGE] = this;
    }
    return this;
  }

  /** Remove the decorator and release storage, unless a newer bridge owns it. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    const ownsSlot = this.service[BRIDGE] === this;
    if (ownsSlot) {
      delete this.service[BRIDGE];
      if (this.service.selectModel === this.wrapper) {
        if (this.previousOwnDescriptor !== undefined) {
          Object.defineProperty(this.service, 'selectModel', this.previousOwnDescriptor);
        } else {
          delete this.service.selectModel;
        }
      }
    }
    await this.writeChain.catch(() => {});
    if (this.domain !== null) {
      try {
        await this.domain.close?.();
      } catch (error) {
        this.log('warn', `domain close failed: ${String(error)}`);
      }
    }
  }

  /**
   * The decorated call.
   * @param {{ sessionId: string, provider: string, model: string, reasoningEffort?: string }} request
   * @param {(request: any) => Promise<any>} invoke
   */
  async handle(request, invoke) {
    try {
      const sessionId = request?.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return await invoke(request);
      }
      if (this.internalSessions.has(sessionId)) {
        // Plugin-initiated restore: the preference is already durable. Never
        // re-save it or reinterpret the call as a user action.
        return await invoke(request);
      }

      const previous = this.currentSelection(sessionId);
      const sameModel = isSameModel(previous, request);

      if (!sameModel) {
        return await this.handleModelSwitch(request, invoke);
      }

      const changed = !sameRawEffort(previous, request);
      const result = await invoke(request);
      if (changed) {
        await this.remember(request.provider, request.model, effortToRemember(request));
      }
      return result;
    } catch (error) {
      this.stats.failures += 1;
      throw error;
    }
  }

  /** Rewrite a model switch in the same native call. */
  async handleModelSwitch(request, invoke) {
    const preference = this.store.get(request.provider, request.model);
    if (preference === undefined) {
      // First visit to this model: preserve DSH's own default and remember
      // nothing. A later explicit effort choice creates the preference.
      return await invoke(request);
    }

    let modelInfo;
    try {
      modelInfo = await this.ctx.llm.resolveModelInfo(request.provider, request.model);
    } catch (error) {
      this.log('debug', `capability lookup failed for ${request.provider}/${request.model}: ${String(error)}`);
    }

    const decision = decideModelSwitch({ previous: this.currentSelection(request.sessionId), request, preference, modelInfo });
    if (decision.reason === 'unsupported-effort') {
      this.stats.unsupported += 1;
      this.log('debug', `saved effort "${String(preference)}" is no longer advertised by ${request.provider}/${request.model}; keeping DSH default`);
    } else if (decision.action === 'restore') {
      this.stats.restores += 1;
      this.log('debug', `restoring ${request.provider}/${request.model} effort ${String(preference)}`);
    } else if (decision.reason === 'unknown-capabilities') {
      this.stats.unsupported += 1;
      this.log('debug', `cannot verify saved effort for ${request.provider}/${request.model}; keeping DSH default`);
    }

    const result = await invoke(decision.request);
    if (decision.action === 'honour-explicit') {
      await this.remember(request.provider, request.model, effortToRemember(request));
    }
    return result;
  }

  /** Persist one explicit user choice. */
  async remember(provider, model, effort) {
    const changed = this.store.set(provider, model, effort);
    if (!changed) return;
    this.stats.saves += 1;
    this.log('debug', `remember ${provider}/${model} = ${effort === DEFAULT_EFFORT ? 'default' : effort}`);
    if (this.domain === null) return;
    const snapshot = this.store.snapshot();
    this.writeChain = this.writeChain
      .then(async () => {
        await this.domain.global.set(snapshot);
      })
      .catch((error) => {
        this.stats.failures += 1;
        this.log('warn', `failed to persist preferences: ${String(error)}`);
      });
    await this.writeChain;
  }

  /** Read the live projected selection, or the native default for a new session. */
  currentSelection(sessionId) {
    try {
      const agent = this.ctx.agents.get(sessionId);
      if (agent !== undefined) {
        const state = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection');
        const projected = state?.pending ?? state?.lastUsed;
        if (projected !== undefined && projected !== null) return projected;
      }
    } catch (error) {
      this.log('debug', `selection projection unavailable for ${sessionId}: ${String(error)}`);
    }
    return this.ctx.agentDefaultModel?.currentSelection?.();
  }

  /** True for a session without a committed turn. */
  isBlank(agent) {
    if (agent === undefined) return false;
    if (agent.session?.header?.origin === 'subagent' || agent.session?.header?.parentSession !== undefined) return false;
    try {
      const meta = this.ctx.sessionProjections.stateOf(agent.session, 'sessionListMetadata');
      if (typeof meta?.blank === 'boolean') return meta.blank;
    } catch {
      // Fall through to the event scan.
    }
    try {
      return !agent.session.snapshotEvents().some((event) => event.type === 'turn/start');
    } catch {
      return false;
    }
  }

  /**
   * Apply a saved effort to a newly-created blank session. This is separate
   * from switch interception because no model switch happens on creation.
   */
  async restoreForAgent(agent) {
    if (this.disposed || agent === undefined || this.restoredSessions.has(agent.id)) return;
    if (!this.isBlank(agent)) return;
    this.restoredSessions.add(agent.id);
    const current = this.currentSelection(agent.id);
    if (current === null || current === undefined
      || typeof current.provider !== 'string' || typeof current.model !== 'string') return;
    const preference = this.store.get(current.provider, current.model);
    if (preference === undefined) return;
    if (preference === DEFAULT_EFFORT && rawEffort(current) === DEFAULT_EFFORT) return;
    if (preference !== DEFAULT_EFFORT && rawEffort(current) === preference) return;

    if (preference !== DEFAULT_EFFORT) {
      try {
        const info = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
        if (!info.reasoning?.efforts?.some((effort) => effort.id === preference)) {
          this.stats.unsupported += 1;
          this.log('debug', `new session keeps DSH default: saved effort ${preference} is not advertised by ${current.provider}/${current.model}`);
          return;
        }
      } catch (error) {
        this.stats.unsupported += 1;
        this.log('debug', `new session capability lookup failed: ${String(error)}`);
        return;
      }
    }

    const request = {
      sessionId: agent.id,
      provider: current.provider,
      model: current.model,
      ...preference === DEFAULT_EFFORT ? {} : { reasoningEffort: preference },
    };
    this.internalSessions.add(agent.id);
    try {
      await this.service.selectModel(request);
      this.stats.restores += 1;
      this.log('debug', `new session ${agent.id} restored ${current.provider}/${current.model} effort ${String(preference)}`);
    } catch (error) {
      this.stats.failures += 1;
      this.log('debug', `new session restore failed for ${current.provider}/${current.model}: ${String(error)}`);
    } finally {
      this.internalSessions.delete(agent.id);
    }
  }

  /** Restore live blank sessions that existed before this plugin mounted. */
  async restoreExisting() {
    let agents;
    try {
      agents = this.ctx.agents.list();
    } catch {
      return;
    }
    await Promise.all(agents.map((agent) => this.restoreForAgent(agent).catch((error) => {
      this.stats.failures += 1;
      this.log('warn', `existing-session restore failed: ${String(error)}`);
    })));
  }

  /** Schedule a restore after `agent/created` has finished its synchronous setup. */
  scheduleRestore(agent) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.restoreForAgent(agent).catch((error) => {
        this.stats.failures += 1;
        this.log('warn', `scheduled new-session restore failed: ${String(error)}`);
      });
    }, 0);
    this.timers.add(timer);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  /** Diagnostic snapshot for the status route and tests. */
  status() {
    return {
      ok: true,
      version: 1,
      persistence: this.domain === null ? 'memory' : 'storage-domain',
      preferences: this.store.snapshot(),
      stats: { ...this.stats },
      restoredSessions: this.restoredSessions.size,
    };
  }
}

/**
 * Open storage, create the bridge, install the decorator, and wire lifecycle.
 * @param {any} ctx
 */
export async function installEffortKeeper(ctx) {
  const log = (level, message) => {
    const logger = ctx.logger;
    const write = logger?.[level];
    if (typeof write === 'function') write.call(logger, `effort-keeper: ${message}`);
  };

  const service = ctx.sessionController;
  if (service === undefined || typeof service.selectModel !== 'function') {
    throw new Error('effort-keeper: sessionController.selectModel is unavailable');
  }

  const domain = await openPreferenceDomain(ctx, log);
  const persisted = await loadState(domain, log);
  const store = new PreferenceStore(persisted);
  const bridge = new EffortKeeperBridge(ctx, service, domain, store, log).install();

  ctx.effect(() => () => bridge.dispose(), 'effort-keeper: selectModel decorator and storage');
  ctx.on('agent/created', ({ agent }) => bridge.scheduleRestore(agent));

  await bridge.restoreExisting();
  return bridge;
}
