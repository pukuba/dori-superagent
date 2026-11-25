import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ownerSpoke,
  ownerWaitDone,
  slackOwnerLine,
  telegramOwnerLine,
  yenaReplied,
} from "../src/messenger/owner-wait.ts";
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

test("only a post where the owner wrote, or owner-wait done, ends the wait; a post anywhere else leaves it open", () => {
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
    ownerWaitDone(state.dir, 5000);
    expect(wait(state.dir)).toEqual({ repliedAt: 5000 });
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

test("a send to where the owner wrote ends his wait (Slack by the channel it landed in); elsewhere or the alert does not", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const send = (platform: string, to: string, ...env: string[]) =>
      run(
        [
          "env",
          `DORI_CONFIG=${config}`,
          `DORI_STATE_DIR=${state.dir}`,
          "DORI_TELEGRAM_TOKEN=123:not-a-real-token",
          "DORI_SLACK_TOKEN=xoxb-not-a-real-token",
          `DORI_TEST_FETCH_LOG=${join(state.dir, "fetch.jsonl")}`,
          ...env,
          process.execPath,
          "--preload",
          join(import.meta.dir, "record-fetch.ts"),
          join(import.meta.dir, "../src/cli.ts"),
          "send",
          platform,
          "--to",
          to,
          "--text",
          "hi",
        ],
        { timeoutMs: 20_000 },
      );
    ownerSpoke(state.dir, tgDm, "hi?", 1000);
    expect((await send("telegram", "7", "DORI_NOT_A_REPLY=1")).code).toBe(0);
    expect((await send("telegram", "8")).code).toBe(0);
    expect(wait(state.dir)["since"]).toBe(1000);
    expect((await send("telegram", "7")).code).toBe(0);
    expect(wait(state.dir)["since"]).toBeUndefined();
    // Slack: the owner wrote in his DM (D0WNER); a reply sent to his user id lands there and ends the wait.
    ownerSpoke(state.dir, { where: "Slack D0WNER", target: "slack:D0WNER" }, "hi?", 2000);
    expect((await send("slack", "C-OTHER")).code).toBe(0);
    expect(wait(state.dir)["since"]).toBe(2000);
    expect((await send("slack", "U0WNER")).code).toBe(0);
    expect(wait(state.dir)["since"]).toBeUndefined();
  } finally {
    state.done();
  }
});

test("a send whose reply cannot be recorded still succeeds, with a WARN", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const blocked = join(state.dir, "blocked");
    writeFileSync(blocked, "a file where the state dir should be");
    const r = await run(
      [
        "env",
        `DORI_CONFIG=${config}`,
        `DORI_STATE_DIR=${blocked}`,
        "DORI_TELEGRAM_TOKEN=123:not-a-real-token",
        `DORI_TEST_FETCH_LOG=${join(state.dir, "fetch.jsonl")}`,
        process.execPath,
        "--preload",
        join(import.meta.dir, "record-fetch.ts"),
        join(import.meta.dir, "../src/cli.ts"),
        "send",
        "telegram",
        "--to",
        "7",
        "--text",
        "hi",
      ],
      { timeoutMs: 20_000 },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT 99");
    expect(r.out).toContain("WARN could not record the reply");
  } finally {
    state.done();
  }
});
