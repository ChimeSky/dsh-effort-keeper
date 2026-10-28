/**
 * EffortKeeper host entry.
 *
 * The plugin has no client half: it decorates the one Host method both native
 * model pickers call, so the existing DSH selector remains the UI.
 */
import { installEffortKeeper } from './lib/bridge.js';

/** Cordis row id; must stay stable so profile patches can target it. */
export const name = 'effort-keeper';

/**
 * Required native services. `storageDomain` is the official Host persistence
 * seam; the others are the public model/session services the bridge reads and
 * decorates. `webServer` is optional and attached below.
 */
export const inject = [
  'agents',
  'agentDefaultModel',
  'llm',
  'sessionController',
  'sessionProjections',
  'storageDomain',
];

/**
 * @param {any} ctx Cordis Host context
 */
export async function apply(ctx) {
  const bridge = await installEffortKeeper(ctx);

  // Optional diagnostics endpoint. It exposes only provider/model keys and
  // effort ids (never credentials, prompts, or message content). Absent in
  // headless compositions, where there is no web server.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/effort-keeper/status',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405);
          response.end();
          return;
        }
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify(bridge.status()));
      },
    }), 'effort-keeper: status route');
  });
}
