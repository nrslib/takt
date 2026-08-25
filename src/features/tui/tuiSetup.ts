/**
 * Everything a mounted view needs once a workflow and a mode are chosen.
 *
 * Building these is a side-effecting job (session init, prompt loading, image
 * store ownership), so the orchestrator prepares them and the React tree only
 * consumes them.
 */

import type { SessionContext } from '../interactive/aiCaller.js';

/**
 * How the session's own provider and model read on screen. Taken from the
 * context the session was built with, so what is shown is what will be called —
 * there is no second resolution behind the display.
 *
 * A model is not always resolved: some providers are called without one and use
 * whatever the provider itself defaults to, and there is nothing to show then.
 */
export function describeSessionModel(ctx: SessionContext): string {
  return ctx.model === undefined ? ctx.providerType : `${ctx.providerType}/${ctx.model}`;
}
