import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/api.ts";

test("bodyless printer deletion omits JSON content type and handles 204", async () => {
  const original = globalThis.fetch;
  let request: RequestInit | undefined;
  globalThis.fetch = async (_url, init) => { request = init; return new Response(null, { status: 204 }); };
  try {
    assert.equal(await api("/printers/local", undefined, "DELETE"), undefined);
    assert.equal(request?.method, "DELETE");
    assert.equal(new Headers(request?.headers).has("Content-Type"), false);
    assert.equal(request?.body, undefined);
  } finally { globalThis.fetch = original; }
});
test("JSON requests retain their body and failures have a visible message", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
    assert.equal(init?.body, '{"name":"printer"}');
    return Response.json({ message: "Unavailable" }, { status: 503 });
  };
  try { await assert.rejects(api("/printers", { name: "printer" }), /Unavailable/); }
  finally { globalThis.fetch = original; }
});
