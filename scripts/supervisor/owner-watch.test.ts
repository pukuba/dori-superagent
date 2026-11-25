import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { groupId } from "../../src/runtime/group.ts";
import { check } from "./check.ts";
import { healthy, Machine } from "./machine.ts";
import { ALERT_GAP_MS, OWNER_WAIT_MS, STUCK_MS } from "./owner-watch.ts";
import type { Paths } from "./sys.ts";

let home: string;
let p: Paths;
let m: Machine;
const MIN = 60_000;

/** The owner's message arrived `ago` ms before the machine's clock; undefined `ago` means yena has replied. */
const ownerWaiting = (ago: number | undefined, where = "Slack C1 thread 1.2") => {
  mkdirSync(join(home, "state"), { recursive: true });
  const w = ago === undefined ? { repliedAt: m.clock } : { since: m.clock - ago, where };
  writeFileSync(join(home, "state", "owner-wait.json"), JSON.stringify(w));
};
const alerts = () => m.calls.filter((c) => c[0] === "/bin/bash");
const alertText = () => readFileSync(join(home, "supervisor", "alert.txt"), "utf8");
const leadRuns = () => m.ran("run").filter((c) => c.includes("dori.role=lead"));

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

  test("a lead whose screen shows a provider limit is reported and never relaunched", async () => {
    m.screens.set("t1", "Error: You've hit your org's monthly spend limit (rate_limit)");
    ownerWaiting(OWNER_WAIT_MS);
    await check(m.sys, p);
    expect(alertText()).toContain("rate limit");
    m.clock += STUCK_MS + MIN;
    await check(m.sys, p);
    expect(leadRuns()).toEqual([]);
    expect(m.ran("kill").some((c) => c[2] === "t1")).toBe(false);
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
    for (let i = 0; i < 5; i++) {
      m.screens.set("t1", `working ${i}m`);
      await check(m.sys, p);
      m.clock += STUCK_MS / 2;
    }
    expect(leadRuns()).toEqual([]);
  });
});
