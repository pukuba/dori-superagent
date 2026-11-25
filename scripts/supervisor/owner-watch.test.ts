import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { groupId } from "../../src/runtime/group.ts";
import { check } from "./check.ts";
import { healthy, Machine } from "./machine.ts";
import { ALERT_GAP_MS, OWNER_WAIT_MS, REPLAY_GAP_MS, STUCK_MS } from "./owner-watch.ts";
import type { Paths } from "./sys.ts";

let home: string;
let p: Paths;
let m: Machine;
const MIN = 60_000;
const LIMIT_LINE =
  "Error: You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 12:30am (Asia/Seoul) (rate_limit)";

/** The owner's message arrived `ago` ms before the machine's clock; undefined `ago` means yena has replied. */
const ownerWaiting = (ago: number | undefined, where = "Slack C1 thread 1.2") => {
  mkdirSync(join(home, "state"), { recursive: true });
  const w =
    ago === undefined
      ? { repliedAt: m.clock }
      : { since: m.clock - ago, where, messages: [{ at: m.clock - ago, where, text: "너 왜 사라짐" }] };
  writeFileSync(join(home, "state", "owner-wait.json"), JSON.stringify(w));
};
const alerts = () => m.calls.filter((c) => c[0] === "/bin/bash");
const alertText = () => readFileSync(join(home, "supervisor", "alert.txt"), "utf8");
const leadRuns = () => m.ran("run").filter((c) => c.includes("dori.role=lead"));
const replays = () => m.calls.filter((c) => c.includes("send") && (c.at(-1) ?? "").startsWith("[missed during limit]"));
const pass = async (screen?: string, step = MIN) => {
  if (screen !== undefined) m.screens.set("t1", screen);
  await check(m.sys, p);
  m.clock += step;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dori-owner-"));
  p = {
    home,
    repo: resolve(import.meta.dir, "..", ".."),
    bun: "/bin/bun",
    agentCmd: "omo",
    shell: "/bin/zsh",
    doriCmd: "DORI_HOME=h bun cli.ts",
  };
  m = new Machine(groupId(home));
  m.sys = { ...m.sys, env: { ...m.sys.env, DORI_STATE_DIR: join(home, "state") } };
  healthy(m);
  m.screens.set("t1", "Thought: 1s\n> waiting");
  writeFileSync(join(home, "telegram.env"), "");
  writeFileSync(
    join(home, "roles.json"),
    JSON.stringify({ lead: "hc:t1", duty: "hc:t2", "duty-loop": "hc:t3", "hourly-loop": "hc:t4" }),
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("owner waiting on yena", () => {
  test("no alert before ten minutes, one alert after, through Telegram and marked as not a reply", async () => {
    ownerWaiting(OWNER_WAIT_MS - 1);
    await check(m.sys, p);
    expect(alerts()).toEqual([]);
    m.clock += 2;
    await check(m.sys, p);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.join(" ")).toContain("DORI_NOT_A_REPLY=1 bun src/cli.ts send telegram");
    expect(alertText()).toContain("예나가 대답을 안 하고 있어");
    expect(alertText()).toContain("Slack C1 thread 1.2");
    m.clock += 5 * MIN;
    await check(m.sys, p);
    expect(alerts()).toHaveLength(1);
    expect(m.logs.join("\n")).toContain("WARN the owner has waited on yena");
  });

  test("the wait file is found where the CLI keeps it: DORI_CONFIG's stateDir", async () => {
    const config = join(home, "cfg.json");
    writeFileSync(config, JSON.stringify({ stateDir: join(home, "state") }));
    m.sys = { ...m.sys, env: { DORI_RUNTIME: "hc", DORI_CONFIG: config, HOME: join(home, "nohome") } };
    ownerWaiting(OWNER_WAIT_MS);
    await check(m.sys, p);
    expect(alerts()).toHaveLength(1);
  });

  test("a reply ends the wait; a later wait is alerted only after the rate-limit gap", async () => {
    ownerWaiting(OWNER_WAIT_MS);
    await check(m.sys, p);
    expect(alerts()).toHaveLength(1);
    ownerWaiting(undefined);
    m.clock += MIN;
    await check(m.sys, p);
    ownerWaiting(OWNER_WAIT_MS); // a new wait, already ten minutes old
    await check(m.sys, p);
    expect(alerts()).toHaveLength(1);
    m.clock += ALERT_GAP_MS;
    ownerWaiting(OWNER_WAIT_MS + ALERT_GAP_MS);
    await check(m.sys, p);
    expect(alerts()).toHaveLength(2);
  });

  test("a lead whose screen ends in the provider's limit error is reported and never relaunched", async () => {
    ownerWaiting(OWNER_WAIT_MS);
    await pass(`some output\n${LIMIT_LINE}\n> `);
    expect(alertText()).toContain("rate limit");
    m.clock += STUCK_MS;
    await pass();
    expect(leadRuns()).toEqual([]);
    expect(m.ran("kill").some((c) => c[2] === "t1")).toBe(false);
  });

  test("'rate limit' in ordinary output, or a limit error scrolled far up, does not shield a frozen lead", async () => {
    const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    ownerWaiting(OWNER_WAIT_MS);
    await pass(`${LIMIT_LINE}\n${filler}\nhandle the rate limit and quota (429) in retry.ts\n> `, STUCK_MS + MIN);
    await pass();
    expect(m.ran("kill").some((c) => c[2] === "t1")).toBe(true);
    expect(leadRuns()).toHaveLength(1);
    expect(replays()).toEqual([]);
  });

  test("a lead whose screen stays frozen while the owner waits is replaced once, with why in its handoff", async () => {
    ownerWaiting(OWNER_WAIT_MS);
    await check(m.sys, p);
    m.clock += STUCK_MS - 1;
    await check(m.sys, p);
    expect(leadRuns()).toEqual([]);
    m.clock += 1;
    await check(m.sys, p);
    expect(m.ran("kill").some((c) => c[2] === "t1")).toBe(true);
    expect(leadRuns()).toHaveLength(1);
    expect(readFileSync(join(home, "supervisor", "handoff-lead.md"), "utf8")).toContain("the owner waited");
    const lead = [...m.terms.entries()].find(([, t]) => t.labels["dori.role"] === "lead")!;
    m.procs.push({ pid: lead[1].pid + 1, ppid: lead[1].pid, cmd: "/bun /x/senpi/dist/bundle/cli.js" });
    m.clock += STUCK_MS * 2;
    await check(m.sys, p);
    expect(leadRuns()).toHaveLength(1);
  });

  test("a lead whose screen keeps changing is left alone", async () => {
    ownerWaiting(OWNER_WAIT_MS);
    for (let i = 0; i < 5; i++) await pass(`working ${i}m`, STUCK_MS / 2);
    expect(leadRuns()).toEqual([]);
  });

  test("once the limit is off the screen, the missed messages go back to the lead; a HELD send is retried", async () => {
    ownerWaiting(OWNER_WAIT_MS);
    await pass(LIMIT_LINE);
    expect(replays()).toEqual([]);
    m.sendReply = { code: 3, out: "HELD lead: delivery may or may not have reached the pane" };
    await pass("> idle");
    expect(replays()).toHaveLength(1);
    m.sendReply = { code: 0, out: "DELIVERED lead" };
    await pass("> idle");
    expect(replays()).toHaveLength(2);
    const text = replays()[1]!.at(-1)!;
    expect(text).toStartWith("[missed during limit]");
    expect(text).toContain("너 왜 사라짐");
    await pass("> idle");
    expect(replays()).toHaveLength(2);
    expect(m.logs.join("\n")).toContain("REPLAY 1 owner message(s)");
  });

  test("a replay whose turn hit the limit again is repeated after the limit clears, not sooner than the gap", async () => {
    ownerWaiting(OWNER_WAIT_MS);
    await pass(LIMIT_LINE);
    await pass("> idle");
    expect(replays()).toHaveLength(1);
    await pass(`[missed during limit] ...\n${LIMIT_LINE}`);
    await pass("> idle again");
    expect(replays()).toHaveLength(1); // within REPLAY_GAP_MS of the first replay
    m.clock += REPLAY_GAP_MS;
    await pass("> idle again");
    expect(replays()).toHaveLength(2);
  });

  test("a limit that comes and goes inside the first ten minutes is still replayed, before any alert", async () => {
    ownerWaiting(MIN);
    await pass(LIMIT_LINE);
    await pass("> idle");
    expect(replays()).toHaveLength(1);
    expect(alerts()).toEqual([]);
  });

  test("a wait that never hit a limit is not replayed", async () => {
    ownerWaiting(OWNER_WAIT_MS);
    for (let i = 0; i < 3; i++) await pass(`working ${i}`);
    expect(replays()).toEqual([]);
  });
});
