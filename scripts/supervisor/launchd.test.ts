import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { groupId } from "../../src/runtime/group.ts";
import { restartRun } from "./launchd.ts";
import { Machine } from "./machine.ts";
import type { Paths } from "./sys.ts";

let home: string;
let p: Paths;
let m: Machine;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dori-sup-"));
  p = {
    home,
    repo: resolve(import.meta.dir, "..", ".."),
    bun: "/bin/bun",
    agentCmd: "omo",
    shell: "/bin/zsh",
    doriCmd: "dori",
  };
  m = new Machine(groupId(home));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("restart-host job", () => {
  test("waits for a scheduled pass to release the lock instead of giving up", async () => {
    mkdirSync(join(home, "supervisor", "lock"), { recursive: true });
    writeFileSync(join(home, "supervisor", "lock", "owner"), "scheduled-pass");
    m.clock = Date.now();
    m.terms.clear();
    let sleeps = 0;
    m.onSleep = () => {
      if (++sleeps === 3) rmSync(join(home, "supervisor", "lock"), { recursive: true });
    };
    expect(await restartRun(m.sys, p, { core: false, delayS: 0 })).toBe(0);
    expect(m.ran("run").filter((c) => c.includes("dori.role=lead"))).toHaveLength(1);
    expect(readFileSync(join(home, "supervisor", "handoff-lead.md"), "utf8")).toContain("restarted on purpose");
  });

  test("restart-run stops the holder, waits for the new one, and relaunches the lead once with the restart reason and note", async () => {
    mkdirSync(join(home, "supervisor"));
    writeFileSync(join(home, "supervisor", "restart-note.md"), "grants were changed");
    m.clock = Date.now();
    m.terms.clear();
    let markerDuringRelaunch = false;
    m.onRun = () => {
      markerDuringRelaunch ||= existsSync(join(home, "supervisor", "restarting"));
    };
    expect(await restartRun(m.sys, p, { core: false, delayS: 0 })).toBe(0);
    expect(m.calls).toContainEqual(["kill", "-TERM", "1000"]);
    expect(m.ran("run").filter((c) => c.includes("dori.role=lead"))).toHaveLength(1);
    const handoff = readFileSync(join(home, "supervisor", "handoff-lead.md"), "utf8");
    expect(handoff).toContain("restarted on purpose with restart-host");
    expect(handoff).toContain("grants were changed");
    expect(markerDuringRelaunch).toBe(true);
    expect(existsSync(join(home, "supervisor", "restarting"))).toBe(false);
    expect(existsSync(join(home, "supervisor", "restart-note.md"))).toBe(false);
  });
});
