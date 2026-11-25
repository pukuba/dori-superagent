import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { groupId } from "../../src/runtime/group.ts";
import { check } from "./check.ts";
import { healthy, Machine } from "./machine.ts";
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
  healthy(m);
  writeFileSync(
    join(home, "roles.json"),
    JSON.stringify({ lead: "hc:t1", duty: "hc:t2", "duty-loop": "hc:t3", "hourly-loop": "hc:t4" }),
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("supervisor guards", () => {
  test("a home dori would run on herdr, or a role registered on herdr, never gets hc sessions", async () => {
    m.terms.clear();
    m.sys = { ...m.sys, env: { DORI_RUNTIME: "herdr" } };
    await check(m.sys, p);
    expect(m.logs.at(-1)).toStartWith("SKIP this home runs on herdr");
    m.sys = { ...m.sys, env: { HERDR_PANE_ID: "w1:p1", PATH: "" } };
    await check(m.sys, p);
    expect(m.logs.at(-1)).toStartWith("SKIP this home runs on herdr");
    m.sys = { ...m.sys, env: { DORI_RUNTIME: "hc" } };
    writeFileSync(join(home, "roles.json"), JSON.stringify({ lead: "herdr:w1:p1" }));
    await check(m.sys, p);
    expect(m.ran("run").filter((c) => c.includes("dori.role=lead"))).toEqual([]);
    expect(m.logs.at(-1)).toContain("WARN lead is registered on herdr:w1:p1, not hc");
  });

  test("a restart note with $' or $& reaches the handoff verbatim", async () => {
    mkdirSync(join(home, "supervisor"));
    writeFileSync(join(home, "supervisor", "restart-note.md"), "run printf $'a\\tb' then $& and $$");
    m.clock = Date.now();
    m.terms.delete("t1");
    await check(m.sys, p);
    expect(readFileSync(join(home, "supervisor", "handoff-lead.md"), "utf8")).toContain(
      "run printf $'a\\tb' then $& and $$",
    );
  });
});
