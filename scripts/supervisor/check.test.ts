import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { groupId } from "../../src/runtime/group.ts";
import { AGENTLESS_MS, check, GRACE_MS, NUDGE_EVERY_MS } from "./check.ts";
import type { Paths, RunResult, Sys } from "./sys.ts";

type T = { pid: number; labels: Record<string, string> };
type P = { pid: number; ppid: number; cmd: string };

/** A scripted machine: hc terminals, a process table, and every command the supervisor ran. */
class Machine {
  terms = new Map<string, T>();
  procs: P[] = [];
  calls: string[][] = [];
  logs: string[] = [];
  clock = 1_000_000;
  next = 100;
  sys: Sys = {
    run: async (argv) => this.run(argv),
    now: () => this.clock,
    sleep: async () => {},
    log: (l) => void this.logs.push(l),
  };
  constructor(readonly group: string) {}
  term(address: string, role: string, pid: number, agentCmd?: string): void {
    this.terms.set(address, { pid, labels: { "dori.group": this.group, "dori.role": role } });
    this.procs.push({ pid, ppid: 1, cmd: "/bin/zsh" });
    if (agentCmd) this.procs.push({ pid: pid + 1, ppid: pid, cmd: agentCmd });
  }
  ran = (word: string): string[][] => this.calls.filter((c) => c.includes(word));
  private run(argv: readonly string[]): RunResult {
    this.calls.push([...argv]);
    const ok = (out: unknown): RunResult => ({
      code: 0,
      out: typeof out === "string" ? out : JSON.stringify(out),
      err: "",
    });
    const [a, b, c] = argv;
    if (a === "ps") return ok(this.procs.map((p) => `${p.pid} ${p.ppid} ${p.cmd}`).join("\n"));
    if (a === "kill") return ok("");
    if (a !== "hc") return ok("DELIVERED lead");
    if (b === "server") return ok({});
    if (b === "ls") return ok({ terminals: [...this.terms.keys()].map((address) => ({ address, state: "live" })) });
    if (b === "get") return ok({ ...this.terms.get(c!), address: c });
    if (b === "kill" || b === "rm") {
      this.terms.delete(c!);
      return ok({});
    }
    if (b === "run") {
      const labels: Record<string, string> = {};
      argv.forEach((v, i) => {
        if (argv[i - 1] === "--label") labels[v.split("=")[0]!] = v.split("=")[1]!;
      });
      const address = `t${(this.next++).toString(36)}`;
      this.terms.set(address, { pid: this.next * 10, labels });
      return ok({ address });
    }
    return ok({});
  }
}

let home: string;
let p: Paths;
let m: Machine;
const AGENT = "/bun /x/senpi/dist/bundle/cli.js --append-system-prompt lead.md";
const roles = () => JSON.parse(readFileSync(join(home, "roles.json"), "utf8")) as Record<string, string>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dori-sup-"));
  p = { home, repo: resolve(import.meta.dir, "..", ".."), bun: "/bin/bun", agentCmd: "omo", shell: "/bin/zsh" };
  m = new Machine(groupId(home));
  m.term("t1", "lead", 10, AGENT);
  m.term("t2", "duty", 20, AGENT);
  m.term("t3", "duty-loop", 30, "bun /r/src/cli.ts duty --interval 60");
  m.term("t4", "hourly-loop", 40, "bun /r/src/cli.ts loop");
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
    m.procs.push({ pid: 500, ppid: 1, cmd: "bun src/cli.ts inbound telegram --loop 1" });
    m.procs.push({
      pid: 499,
      ppid: 1,
      cmd: "/bin/bash -c . telegram.env; cd x && bun src/cli.ts inbound telegram --loop 1",
    });
    await check(m.sys, p);
    expect(m.calls).toContainEqual(["kill", "500"]);
    const nudges = () => m.calls.filter((c) => c.includes("send") && c.includes("lead"));
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]!.join(" ")).toContain("inbound telegram --loop 1");
    m.clock += NUDGE_EVERY_MS - 1;
    await check(m.sys, p);
    expect(nudges()).toHaveLength(1);
    m.procs.push({ pid: 12, ppid: 11, cmd: "bun src/cli.ts inbound telegram --loop 1" });
    m.procs = m.procs.filter((pr) => pr.pid !== 500);
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

  test("a pause file stops every repair", async () => {
    m.terms.delete("t1");
    mkdirSync(join(home, "supervisor"));
    writeFileSync(join(home, "supervisor", "paused"), "");
    await check(m.sys, p);
    expect(m.calls).toEqual([]);
  });
});
