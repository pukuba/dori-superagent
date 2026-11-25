import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

import { formatSlackInbound } from "../src/messenger/slack-inbound.ts";
import { inboundSink, nameCaller } from "../src/messenger/slack-socket.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { withState } from "./fakes.ts";
import { BOT, event, frame, harness, SELF } from "./slack-socket-harness.ts";

const state = withState();
afterAll(() => state.done());

test("every envelope is acked by its id; app_mention and a human DM become INBOUND lines, the rest are dropped", async () => {
  const h = harness();
  const s = await h.socket(1);
  expect(s.url).toBe("wss://fake/1");
  expect(h.opens).toEqual(["Bearer xapp-test"]);
  frame(s, { type: "hello" });
  expect(h.readies()).toBe(1);
  event(s, "e1", { type: "app_mention", channel: "C1", user: "U_OWNER", ts: "10.1", text: "<@U_YENA> status?" });
  event(s, "e2", { type: "message", channel_type: "im", channel: "D1", user: "U_OWNER", ts: "11.1", text: "hi" });
  event(s, "e3", { type: "message", channel_type: "im", channel: "D1", user: SELF, ts: "12.1", text: "mine" });
  event(s, "e4", { type: "message", channel_type: "im", channel: "D1", user: "U_X", bot_id: "B9", ts: "13.1" });
  event(s, "e5", {
    type: "message",
    channel_type: "im",
    channel: "D1",
    user: "U_OWNER",
    subtype: "message_changed",
    ts: "14.1",
  });
  event(s, "e6", {
    type: "message",
    channel_type: "channel",
    channel: "C1",
    user: "U_OWNER",
    ts: "15.1",
    text: "no tag",
  });
  event(s, "e7", { type: "app_mention", channel: "C1", user: "U_Z", bot_id: BOT, ts: "16.1", text: "self loop" });
  expect(s.sent.map((d) => JSON.parse(d).envelope_id)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
  expect(h.emitted.map(formatSlackInbound)).toEqual([
    'INBOUND mention C1 - 10.1 U_OWNER "<@U_YENA> status?"',
    'INBOUND dm D1 - 11.1 U_OWNER "hi"',
  ]);
  await h.stop();
});

test("a name call is a vocative or bare name, not a name inside a word, after a particle, or inside a Slack link", () => {
  const calls = nameCaller(["예나", "yena"]);
  for (const yes of [
    "예나야 이거 봐",
    "예나씨 있어?",
    "예나님!",
    "예나 뭐해",
    "그치 예나?",
    "Yena, look",
    "hey @yena",
    "YENA",
  ])
    expect([yes, calls(yes)]).toEqual([yes, true]);
  for (const no of [
    "예나는 귀엽다",
    "예나가 했어",
    "명예나",
    "yenatech is down",
    "myyena",
    "see <https://yena.example/x>",
    "",
  ])
    expect([no, calls(no)]).toEqual([no, false]);
  expect(nameCaller([])("예나야")).toBe(false);
  expect(nameCaller(["도리"])("도리야")).toBe(true);
});

test("a human channel message that calls the bot by name is a namecall line; others, bots, self and edits are dropped", async () => {
  const h = harness(0, { callsMe: nameCaller(["예나", "yena"]) });
  const s = await h.socket(1);
  frame(s, { type: "hello" });
  const msg = (id: string, e: object) =>
    event(s, id, { type: "message", channel_type: "channel", channel: "C1", ...e });
  msg("n1", { user: "U_OWNER", ts: "20.1", text: "예나야 이거 봐" });
  msg("n2", { user: "U_OWNER", ts: "21.1", text: "예나는 귀엽다" });
  msg("n3", { user: "U_OWNER", ts: "22.1", text: "lunch?" });
  msg("n4", { user: SELF, ts: "23.1", text: "예나야" });
  msg("n5", { user: "U_X", bot_id: "B9", ts: "24.1", text: "예나야" });
  msg("n6", { user: "U_OWNER", subtype: "message_changed", ts: "25.1", text: "예나야" });
  event(s, "n7", { type: "message", channel_type: "group", channel: "G1", user: "U_OWNER", ts: "26.1", text: "yena?" });
  expect(h.emitted.map(formatSlackInbound)).toEqual([
    'INBOUND namecall C1 - 20.1 U_OWNER "예나야 이거 봐"',
    'INBOUND namecall G1 - 26.1 U_OWNER "yena?"',
  ]);
  await h.stop();
});

test("a message that both @mentions and names the bot is printed once, whichever event comes first", async () => {
  const h = harness(0, { callsMe: nameCaller(["예나"]) });
  const s = await h.socket(1);
  frame(s, { type: "hello" });
  const text = "<@U_YENA> 예나야 상태?";
  event(s, "m1", { type: "message", channel_type: "channel", channel: "C1", user: "U_OWNER", ts: "30.1", text });
  event(s, "m2", { type: "app_mention", channel: "C1", user: "U_OWNER", ts: "30.1", text });
  const printed: string[] = [];
  const sink = inboundSink((i) => printed.push(formatSlackInbound(i)));
  for (const i of h.emitted) await sink(i);
  expect(h.emitted.map((i) => i.source)).toEqual(["namecall", "mention"]);
  expect(printed).toEqual([`INBOUND namecall C1 - 30.1 U_OWNER ${JSON.stringify(text)}`]);
  await h.stop();
});

test("a reply in a channel thread the bot posted in arrives without the name; other threads stay quiet", async () => {
  const ledgerFile = join(state.dir, "threads.json");
  const ledger = new ThreadLedger(ledgerFile);
  await ledger.list();
  // Recorded by another process (`dori send`) after this one loaded the ledger.
  await new ThreadLedger(ledgerFile).record("C1", "40.1", "40.2");
  const h = harness(0, { callsMe: nameCaller(["예나"]), watchedThread: (c, r) => ledger.has(c, r) });
  const s = await h.socket(1);
  frame(s, { type: "hello" });
  const reply = (id: string, e: object) =>
    event(s, id, { type: "message", channel_type: "channel", channel: "C1", user: "U_OWNER", ...e });
  reply("t1", { ts: "41.1", thread_ts: "99.1", text: "not yours" });
  reply("t2", { ts: "42.1", thread_ts: "40.1", text: "그거 다시 해줘" });
  reply("t3", { ts: "43.1", thread_ts: "40.1", user: "U_X", bot_id: "B9", text: "bot" });
  await h.emittedCount(1);
  expect(h.emitted.map(formatSlackInbound)).toEqual(['INBOUND own-thread C1 40.1 42.1 U_OWNER "그거 다시 해줘"']);
  await h.stop();
});
