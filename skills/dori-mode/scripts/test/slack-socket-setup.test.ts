import { afterAll, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { formatSlackInbound } from "../src/messenger/slack-inbound.ts";
import { inboundSink } from "../src/messenger/slack-socket.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { slackAppToken, TokenFileError } from "../src/slack-token.ts";
import { withState } from "./fakes.ts";

const state = withState();
afterAll(() => state.done());

test("slackNames come from config.json, and DORI_SLACK_NAMES wins over it", async () => {
  const path = join(state.dir, "names-config.json");
  const before = process.env["DORI_SLACK_NAMES"];
  try {
    delete process.env["DORI_SLACK_NAMES"];
    expect((await loadConfig(join(state.dir, "absent.json"), state.dir)).slackNames).toEqual([]);
    writeFileSync(path, JSON.stringify({ slackNames: ["도리"] }));
    expect((await loadConfig(path, state.dir)).slackNames).toEqual(["도리"]);
    process.env["DORI_SLACK_NAMES"] = " 예나 , yena ,";
    expect((await loadConfig(path, state.dir)).slackNames).toEqual(["예나", "yena"]);
    writeFileSync(path, JSON.stringify({ slackNames: "예나" }));
    await expect(loadConfig(path, state.dir)).rejects.toThrow("invalid slackNames");
  } finally {
    if (before === undefined) delete process.env["DORI_SLACK_NAMES"];
    else process.env["DORI_SLACK_NAMES"] = before;
  }
});

test("the sink prints a message once across the socket and the poll, and marks it seen in a watched thread", async () => {
  const ledger = new ThreadLedger(join(state.dir, "sink.json"));
  await ledger.record("D1", "100.1", "100.1");
  const printed: string[] = [];
  const sink = inboundSink((i) => printed.push(formatSlackInbound(i)), ledger);
  await sink({ source: "dm", channel: "D1", ts: "200.1", threadTs: "100.1", user: "U_OWNER", text: "reply" });
  await sink({ source: "own-thread", channel: "D1", ts: "200.1", threadTs: "100.1", user: "U_OWNER", text: "reply" });
  expect(printed).toEqual(['INBOUND dm D1 100.1 200.1 U_OWNER "reply"']);
  expect(await ledger.list()).toEqual([{ channel: "D1", rootTs: "100.1", seenTs: "200.1" }]);
});

test("the app token file gets the owner-only checks and names its own variable when refused", () => {
  const file = join(state.dir, "slack-app-token");
  writeFileSync(file, "xapp-1-secret\n");
  chmodSync(file, 0o600);
  const uid = process.getuid?.();
  expect(slackAppToken({ DORI_SLACK_APP_TOKEN_FILE: file }, "darwin", uid)).toBe("xapp-1-secret");
  chmodSync(file, 0o644);
  expect(() => slackAppToken({ DORI_SLACK_APP_TOKEN_FILE: file }, "darwin", uid)).toThrow(TokenFileError);
  expect(() => slackAppToken({ DORI_SLACK_APP_TOKEN_FILE: file }, "darwin", uid)).toThrow(
    /^DORI_SLACK_APP_TOKEN_FILE .* is open to group or others/,
  );
  expect(slackAppToken({}, "darwin", uid)).toBeUndefined();
});
