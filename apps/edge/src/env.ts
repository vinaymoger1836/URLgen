/** The Worker's bindings. Configured in `wrangler.toml`; secrets via `wrangler secret put`. */

export interface Env {
  /** `l:<slug>` -> compact link blob. See `kvLinkValueSchema` in @urlgen/shared. */
  LINKS: KVNamespace;
  /** Origin API base, used only on a KV miss. */
  ORIGIN_API_BASE: string;
  /**
   * Shared secret for `/internal/resolve`. Optional in the type because a missing
   * binding is a deployment fault the Worker must survive, not crash on — a KV hit
   * still redirects without it.
   */
  INTERNAL_API_TOKEN?: string;
}
