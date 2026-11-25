import { appendFileSync } from "node:fs";

// Preloaded into a CLI process by send-cli.test.ts: every request is appended to $DORI_TEST_FETCH_LOG and answered
// the way Telegram (or, for chat.postMessage, Slack) answers a successful call, so no request leaves the machine.
const log = process.env["DORI_TEST_FETCH_LOG"] ?? "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  appendFileSync(
    log,
    `${JSON.stringify({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : null })}\n`,
  );
  if (String(input).endsWith("/chat.postMessage")) {
    // Slack posts a message sent to a user id into that user's DM channel, and answers with that channel.
    const to = String((JSON.parse(String(init?.body)) as { channel?: string }).channel);
    const channel = to.startsWith("U") ? `D${to.slice(1)}` : to;
    return new Response(JSON.stringify({ ok: true, channel, ts: "1795600000.000100" }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
}) as typeof fetch;
