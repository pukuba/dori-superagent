import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ownerSpoke, slackOwnerLine, telegramOwnerLine, yenaReplied } from "../src/messenger/owner-wait.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const wait = (dir: string) => JSON.parse(readFileSync(join(dir, "owner-wait.json"), "utf8")) as Record<string, unknown>;
const slackC1 = { where: "Slack C1", target: "slack:C1" };
const tgDm = { where: "Telegram DM", target: "telegram:7" };

test("the oldest unanswered message starts the wait; targets and the last 10 texts are kept", () => {
  const state = withState();
  try {
    ownerSpoke(state.dir, slackC1, "왜 대답안함", 1000);
    ownerSpoke(state.dir, tgDm, "x".repeat(600), 2000);
    expect(wait(state.dir)).toEqual({
      since: 1000,
      where: "Slack C1",
      targets: ["slack:C1", "telegram:7"],
      messages: [
        { at: 1000, where: "Slack C1", text: "왜 대답안함" },
        { at: 2000, where: "Telegram DM", text: "x".repeat(500) },
      ],
    });
    for (let i = 0; i < 12; i++) ownerSpoke(state.dir, slackC1, `m${i}`, 3000 + i);
    expect((wait(state.dir)["messages"] as unknown[]).length).toBe(10);
  } finally {
    state.done();
  }
});

test("only a post where the owner wrote ends the wait; a post anywhere else leaves it open", () => {
  const state = withState();
  try {
    ownerSpoke(state.dir, slackC1, "hi?", 1000);
    yenaReplied(state.dir, "slack:C-OTHER", 2000);
    yenaReplied(state.dir, "telegram:7", 2000);
    expect(wait(state.dir)["since"]).toBe(1000);
    yenaReplied(state.dir, "slack:C1", 3000);
    expect(wait(state.dir)).toEqual({ repliedAt: 3000 });
    ownerSpoke(state.dir, tgDm, "again", 4000);
    expect(wait(state.dir)).toMatchObject({ since: 4000, targets: ["telegram:7"] });
  } finally {
    state.done();
  }
});

test("a stale lock left by a dead writer is taken over", () => {
  const state = withState();
  try {
    const lock = join(state.dir, "owner-wait.json.lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    ownerSpoke(state.dir, slackC1, "hi?", 1000);
    expect(wait(state.dir)["since"]).toBe(1000);
  } finally {
    state.done();
  }
});

test("only the configured owner's Slack lines and the owner's new Telegram DMs count", () => {
  const slack = { source: "own-thread", channel: "C1", ts: "2.0", threadTs: "1.0", user: "UOWNER" } as const;
  expect(slackOwnerLine(slack, "UOWNER")).toEqual({ where: "Slack C1 thread 1.0", target: "slack:C1" });
  expect(slackOwnerLine({ ...slack, source: "threads-view", threadTs: undefined }, "UOWNER")?.where).toBe("Slack C1");
  expect(slackOwnerLine({ ...slack, user: "UOTHER" }, "UOWNER")).toBeUndefined();
  expect(slackOwnerLine(slack, undefined)).toBeUndefined();
  const tg = { kind: "message", source: "dm", chat: 7, updateId: 1, from: 7 } as const;
  expect(telegramOwnerLine(tg, 7)).toEqual({ where: "Telegram DM", target: "telegram:7" });
  expect(telegramOwnerLine({ ...tg, kind: "edit" }, 7)).toBeUndefined();
  expect(telegramOwnerLine({ ...tg, source: "topic" }, 7)).toBeUndefined();
  expect(telegramOwnerLine({ ...tg, from: 8 }, 7)).toBeUndefined();
});

test("send telegram to the owner's chat ends his wait; another chat or the supervisor's alert does not", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const send = (to: string, ...env: string[]) =>
      run(
        [
          "env",
          `DORI_CONFIG=${config}`,
          `DORI_STATE_DIR=${state.dir}`,
          "DORI_TELEGRAM_TOKEN=123:not-a-real-token",
          `DORI_TEST_FETCH_LOG=${join(state.dir, "fetch.jsonl")}`,
          ...env,
          process.execPath,
          "--preload",
          join(import.meta.dir, "record-fetch.ts"),
          join(import.meta.dir, "../src/cli.ts"),
          "send",
          "telegram",
          "--to",
          to,
          "--text",
          "hi",
        ],
        { timeoutMs: 20_000 },
      );
    ownerSpoke(state.dir, tgDm, "hi?", 1000);
    expect((await send("7", "DORI_NOT_A_REPLY=1")).code).toBe(0);
    expect((await send("8")).code).toBe(0);
    expect(wait(state.dir)["since"]).toBe(1000);
    expect((await send("7")).code).toBe(0);
    expect(wait(state.dir)["since"]).toBeUndefined();
  } finally {
    state.done();
  }
});
