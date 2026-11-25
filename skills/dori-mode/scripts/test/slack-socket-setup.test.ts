import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { formatSlackInbound } from "../src/messenger/slack-inbound.ts";
import { inboundSink, laneRefusal } from "../src/messenger/slack-socket.ts";
import { laneTokenEnv, slackAppToken, TokenFileError } from "../src/slack-token.ts";
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

test("the sink prints a message once across the socket and the poll", async () => {
  const printed: string[] = [];
  const sink = inboundSink((i) => printed.push(formatSlackInbound(i)));
  await sink({ source: "dm", channel: "D1", ts: "200.1", threadTs: "100.1", user: "U_OWNER", text: "reply" });
  await sink({ source: "own-thread", channel: "D1", ts: "200.1", threadTs: "100.1", user: "U_OWNER", text: "reply" });
  expect(printed).toEqual(['INBOUND dm D1 100.1 200.1 U_OWNER "reply"']);
});

test("the app token file gets the owner-only and home checks and names its own variable when refused", () => {
  const home = join(state.dir, "app-home");
  const config = join(home, "config.json");
  mkdirSync(home, { recursive: true });
  const file = join(home, "slack-app-token");
  writeFileSync(file, "xapp-1-secret\n");
  chmodSync(file, 0o600);
  const uid = process.getuid?.();
  const read = (env: Record<string, string>) => slackAppToken(env, "darwin", uid, config);
  expect(read({ DORI_SLACK_APP_TOKEN_FILE: file })).toBe("xapp-1-secret");
  expect(read({ DORI_SLACK_APP_TOKEN: "xapp-raw" })).toBeUndefined();
  const other = join(state.dir, "other-app-token");
  writeFileSync(other, "xapp-other\n");
  chmodSync(other, 0o600);
  expect(() => read({ DORI_SLACK_APP_TOKEN_FILE: other })).toThrow(
    /^DORI_SLACK_APP_TOKEN_FILE .* is outside this home/,
  );
  expect(read({ DORI_SLACK_APP_TOKEN_FILE: other, DORI_SLACK_TOKEN_FILE_OUTSIDE_HOME: "1" })).toBe("xapp-other");
  chmodSync(file, 0o644);
  expect(() => read({ DORI_SLACK_APP_TOKEN_FILE: file })).toThrow(TokenFileError);
  expect(() => read({ DORI_SLACK_APP_TOKEN_FILE: file })).toThrow(
    /^DORI_SLACK_APP_TOKEN_FILE .* is open to group or others/,
  );
  expect(read({})).toBeUndefined();
});

test("a lane gets DORI_SLACK_APP_TOKEN_FILE emptied, and --socket refuses to run in a lane", () => {
  const home = join(state.dir, "lane-home");
  mkdirSync(home, { recursive: true });
  const config = join(home, "config.json");
  const app = { DORI_SLACK_APP_TOKEN_FILE: join(home, "slack-app-token") };
  expect(laneTokenEnv(app, config)).toEqual({ DORI_SLACK_APP_TOKEN_FILE: "" });
  writeFileSync(join(home, "slack-token"), "xoxb-1\n");
  expect(laneTokenEnv({}, config)["DORI_SLACK_APP_TOKEN_FILE"]).toBe("");
  expect(laneRefusal({ DORI_LANE: "fix-x" })).toMatch(
    /^inbound slack --socket runs in the lead only \(DORI_LANE=fix-x\)/,
  );
  expect(laneRefusal({})).toBeUndefined();
});
