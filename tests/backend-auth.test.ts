import { test } from "node:test";
import assert from "node:assert/strict";
import { authenticate, requireAdmin } from "../server/auth.js";
test("development authentication grants access only on loopback", async () => {
  const old = process.env.BARISTA_DEV_AUTH;
  process.env.BARISTA_DEV_AUTH = "true";
  try {
    const identity = await authenticate({
      ip: "127.0.0.1",
      headers: {},
    } as any);
    assert.ok(identity.roles.includes("Labels.Admin"));
    await assert.rejects(
      authenticate({ ip: "10.10.10.10", headers: {} } as any),
    );
  } finally {
    if (old === undefined) delete process.env.BARISTA_DEV_AUTH;
    else process.env.BARISTA_DEV_AUTH = old;
  }
});
test("administrator authorization is enforced independently of sign-in", () => {
  assert.throws(
    () => requireAdmin({ id: "user", roles: ["Labels.User"] }),
    /Administrator/,
  );
  requireAdmin({ id: "admin", roles: ["Labels.Admin"] });
});
