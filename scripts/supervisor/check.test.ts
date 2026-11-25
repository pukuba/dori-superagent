import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { groupId } from "../../src/runtime/group.ts";
import { AGENTLESS_MS, BACKOFF_MS, check, GRACE_MS, MAX_STREAK } from "./check.ts";
import { NUDGE_EVERY_MS } from "./listeners.ts";
import { AGENT, healthy, Machine } from "./machine.ts";
import type { Paths } from "./sys.ts";

let home: string;
let p: Paths;
let m: Machine;
const roles = () => JSON.parse(readFileSync(join(home, "roles.json"), "utf8")) as Record<string, string>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dori-sup-"));
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
  writeFileSync(
    join(home, "roles.json"),
    JSON.stringify({ lead: "hc:t1", duty: "hc:t2", "duty-loop": "hc:t3", "hourly-loop": "hc:t4" }),
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("supervisor check", () => {
  test("a healthy harness is left alone", async () => {
    expect(await check(m.sys, p)).toBe(0);
    expect(m.ran("run")).toEqual([]);
    expect(m.logs.at(-1)).toStartWith("OK lead=hc:t1");
  });

  test("a lost lead pane is relaunched once with a handoff, and the next pass does not open a second lead", async () => {
    m.terms.delete("t1");
    await check(m.sys, p, { reason: "test" });
    const runs = m.ran("run");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain(`dori.role=lead`);
    const sent = m.ran("send")[0]!;
    expect(sent.at(-1)).toContain("handoff-lead.md");
    expect(readFileSync(join(home, "supervisor", "handoff-lead.md"), "utf8")).toContain("test; no live lead terminal");
    expect(roles()["lead"]).toBe(`hc:${sent[2]}`);
    m.clock += 60_000; // the new pane is up but its agent is still starting
    await check(m.sys, p);
    expect(m.ran("run")).toHaveLength(1);
  });

  test("a live lead registered under a dead ref is re-registered, not relaunched", async () => {
    writeFileSync(join(home, "roles.json"), JSON.stringify({ ...roles(), lead: "hc:t9" }));
    await check(m.sys, p);
    expect(m.ran("run")).toEqual([]);
    expect(roles()["lead"]).toBe("hc:t1");
  });

  test("a lead terminal whose agent exited is replaced only after it stays agentless", async () => {
    m.procs = m.procs.filter((pr) => pr.pid !== 11);
    await check(m.sys, p);
    expect(m.ran("run")).toEqual([]);
    m.clock += AGENTLESS_MS + 1;
    await check(m.sys, p);
    expect(m.ran("kill").some((c) => c[2] === "t1")).toBe(true);
    expect(m.ran("run")).toHaveLength(1);
  });

  test("missing listeners make one nudge to the lead per cooldown; orphans outside the group are stopped", async () => {
    writeFileSync(join(home, "telegram.env"), "");
    const listener = "bun src/cli.ts inbound telegram --loop 1";
    m.procs.push({ pid: 499, ppid: 1, cmd: `/bin/bash -c . '${home}/telegram.env'; cd x && ${listener}` });
    m.procs.push({ pid: 500, ppid: 499, cmd: listener });
    m.procs.push({
      pid: 601,
      ppid: 1,
      cmd: "/bin/bash -c . '/other/home/telegram.env'; cd x && bun src/cli.ts inbound telegram --loop 1",
    });
    m.procs.push({ pid: 602, ppid: 601, cmd: listener });
    m.procs.push({ pid: 700, ppid: 1, cmd: "-zsh" });
    m.procs.push({ pid: 701, ppid: 700, cmd: listener });
    await check(m.sys, p);
    const killed = m.calls.filter((c) => c[0] === "kill").map((c) => c[1]);
    expect(killed.sort()).toEqual(["499", "500"]);
    const nudges = () => m.calls.filter((c) => c.includes("send") && c.includes("lead"));
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]!.join(" ")).toContain("inbound telegram --loop 1");
    m.clock += NUDGE_EVERY_MS - 1;
    await check(m.sys, p);
    expect(nudges()).toHaveLength(1);
    m.procs.push({ pid: 12, ppid: 11, cmd: "bun src/cli.ts inbound telegram --loop 1" });
    m.procs = m.procs.filter((pr) => pr.pid !== 500 && pr.pid !== 499);
    m.clock += GRACE_MS;
    await check(m.sys, p);
    expect(nudges()).toHaveLength(1);
  });

  test("an agent whose prompt quotes a listener command is not a listener; a stale restart note is not passed on", async () => {
    writeFileSync(join(home, "telegram.env"), "");
    mkdirSync(join(home, "supervisor"));
    writeFileSync(join(home, "supervisor", "restart-note.md"), "old note");
    m.clock = Date.now() + 31 * 60_000;
    m.terms.delete("t1");
    await check(m.sys, p);
    expect(readFileSync(join(home, "supervisor", "handoff-lead.md"), "utf8")).not.toContain("old note");
    const lead = [...m.terms.entries()].find(([, t]) => t.labels["dori.role"] === "lead")!;
    m.procs.push({
      pid: lead[1].pid + 1,
      ppid: lead[1].pid,
      cmd: `${AGENT} "... bun src/cli.ts inbound telegram --loop 1 ..."`,
    });
    m.clock += GRACE_MS + 1;
    await check(m.sys, p);
    expect(m.calls.filter((c) => c.includes("send") && c.includes("lead"))).toHaveLength(1);
  });

  test("a relaunched lead gets its prompt rendered into the home, with {{dori}} filled", async () => {
    m.terms.delete("t1");
    await check(m.sys, p);
    const cmd = m.ran("send")[0]!.at(-1)!;
    expect(cmd).toContain(join(home, "prompts", "lead.md"));
    const rendered = readFileSync(join(home, "prompts", "lead.md"), "utf8");
    expect(rendered).toContain("DORI_HOME=h bun cli.ts start");
    expect(rendered).not.toContain("{{dori}}");
  });

  test("a stale lock is taken over; a fresh one makes the pass stand down", async () => {
    mkdirSync(join(home, "supervisor", "lock"), { recursive: true });
    m.clock = Date.now();
    await check(m.sys, p);
    expect(m.logs.at(-1)).toStartWith("BUSY");
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(join(home, "supervisor", "lock"), old, old);
    await check(m.sys, p);
    expect(m.logs.at(-1)).toStartWith("OK");
    expect(existsSync(join(home, "supervisor", "lock"))).toBe(false);
  });

  test("a lead whose agent never starts backs off after MAX_STREAK relaunches and alerts the owner once", async () => {
    writeFileSync(join(home, "telegram.env"), "");
    m.terms.delete("t1");
    for (let i = 0; i < MAX_STREAK; i++) {
      await check(m.sys, p);
      m.clock += GRACE_MS + 1;
      await check(m.sys, p);
      m.clock += AGENTLESS_MS + 1;
    }
    const leadRuns = () => m.ran("run").filter((c) => c.includes("dori.role=lead"));
    expect(leadRuns()).toHaveLength(MAX_STREAK);
    expect(m.calls.filter((c) => c[0] === "/bin/bash")).toHaveLength(1);
    await check(m.sys, p);
    m.clock += AGENTLESS_MS + 1;
    await check(m.sys, p);
    expect(leadRuns()).toHaveLength(MAX_STREAK);
    m.clock += BACKOFF_MS; // after the backoff, the stuck terminal still gets its agentless wait before it is replaced
    await check(m.sys, p);
    m.clock += AGENTLESS_MS + 1;
    await check(m.sys, p);
    expect(leadRuns().length).toBeGreaterThan(MAX_STREAK);
  });

  test("a pause file stops every repair", async () => {
    m.terms.delete("t1");
    mkdirSync(join(home, "supervisor"));
    writeFileSync(join(home, "supervisor", "paused"), "");
    await check(m.sys, p);
    expect(m.calls).toEqual([]);
  });
});
