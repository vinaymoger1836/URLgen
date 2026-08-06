/**
 * Tells `cloudflare:test` what this Worker's bindings look like, so `env` in a
 * test is typed rather than `{}`.
 *
 * `wrangler types` would generate this file. It is written by hand instead so
 * that `env.ts` stays the one definition of the binding shape and the two cannot
 * disagree.
 */

import type { Env as WorkerEnv } from "./env.js";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges into the ambient `Cloudflare.Env`; the members come from the extends clause.
    interface Env extends WorkerEnv {}
  }
}
