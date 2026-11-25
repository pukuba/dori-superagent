import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ownerSpoke, slackOwnerWhere, telegramOwnerWhere, yenaReplied } from "../src/messenger/owner-wait.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const wait = (dir: string) => JSON.parse(readFileSync(join(dir, "owner-wait.json"), "utf8")) as Record<string, unknown>;

test("the oldest unanswered owner message starts the wait; a reply ends it", () => {
  const state = withState();
  try {
    ownerSpoke(state.dir, "Slack C1", 1000);
    ownerSpoke(state.dir, "Telegram DM", 2000);
    expect(wait(state.dir)).toEqual({ since: 1000, where: "Slack C1" });
    yenaReplied(state.dir, 3000);
    expect(wait(state.dir)).toEqual({ repliedAt: 3000 });
    ownerSpoke(state.dir, "Telegram DM", 4000);
    expect(wait(state.dir)["since"]).toBe(4000);
  } finally {
    state.done();
  }
});

test("only the configured owner's Slack lines and the owner's new Telegram DMs count", () => {
  const slack = { source: "own-thread", channel: "C1", ts: "2.0", threadTs: "1.0", user: "UOWNER" } as const;
  expect(slackOwnerWhere(slack, "UOWNER")).toBe("Slack C1 thread 1.0");
  expect(slackOwnerWhere({ ...slack, source: "threads-view", threadTs: undefined }, "UOWNER")).toBe("Slack C1");
  expect(slackOwnerWhere({ ...slack, user: "UOTHER" }, "UOWNER")).toBeUndefined();
  expect(slackOwnerWhere(slack, undefined)).toBeUndefined();
  const tg = { kind: "message", source: "dm", chat: 7, updateId: 1, from: 7 } as const;
  expect(telegramOwnerWhere(tg, 7)).toBe("Telegram DM");
  expect(telegramOwnerWhere({ ...tg, kind: "edit" }, 7)).toBeUndefined();
  expect(telegramOwnerWhere({ ...tg, source: "topic" }, 7)).toBeUndefined();
  expect(telegramOwnerWhere({ ...tg, from: 8 }, 7)).toBeUndefined();
});

test("send telegram ends the owner's wait, except the supervisor's alert (DORI_NOT_A_REPLY=1)", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const send = (...env: string[]) =>
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
          "7",
          "--text",
          "hi",
        ],
        { timeoutMs: 20_000 },
      );
    ownerSpoke(state.dir, "Telegram DM", 1000);
    expect((await send("DORI_NOT_A_REPLY=1")).code).toBe(0);
    expect(wait(state.dir)["since"]).toBe(1000);
    expect((await send()).code).toBe(0);
    expect(wait(state.dir)["since"]).toBeUndefined();
    expect(existsSync(join(state.dir, "fetch.jsonl"))).toBe(true);
  } finally {
    state.done();
  }
});
