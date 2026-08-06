import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { kvLinkKey } from "@urlgen/shared";
import { expect, it } from "vitest";

import worker from "./index.js";

it("resolves a KV hit to a 302", async () => {
  await env.LINKS.put(kvLinkKey("smoke01"), JSON.stringify({ u: "https://example.com/", s: "active" }));

  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://short.test/smoke01"), env, ctx);
  await waitOnExecutionContext(ctx);

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://example.com/");
});
