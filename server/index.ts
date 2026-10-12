import { createApp } from "./app.js";
const { app } = createApp();
const host = process.env.BARISTA_HOST ?? "127.0.0.1";
if (
  process.env.BARISTA_DEV_AUTH === "true" &&
  !["127.0.0.1", "::1"].includes(host)
)
  throw new Error("Development authentication requires a loopback server bind");
await app.listen({ host, port: Number(process.env.PORT ?? 3001) });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
