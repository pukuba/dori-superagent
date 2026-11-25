import { expect, test } from "bun:test";
import { main } from "./main.ts";
import type { Paths, Sys } from "./sys.ts";

test("the launchd commands refuse off macOS and touch nothing", async () => {
  const calls: string[][] = [];
  const logs: string[] = [];
  const sys: Sys = {
    run: async (argv) => {
      calls.push([...argv]);
      return { code: 0, out: "", err: "" };
    },
    now: () => 0,
    sleep: async () => {},
    log: (l) => void logs.push(l),
  };
  const p: Paths = {
    home: "/nonexistent",
    repo: "/r",
    bun: "/bin/bun",
    agentCmd: "omo",
    shell: "/bin/sh",
    doriCmd: "dori",
  };
  for (const cmd of ["install", "uninstall", "restart-host", "restart-run"])
    expect(await main([cmd], sys, p, "linux")).toBe(2);
  expect(calls).toEqual([]);
  expect(logs.every((l) => l.startsWith("REFUSED"))).toBe(true);
});
