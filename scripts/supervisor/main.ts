#!/usr/bin/env bun
/**
 * The dori supervisor: keeps the lead, duty, both loops and the lead's inbound listeners alive across Herdr Core / hc
 * restarts, crashes, reboots and lost panes, and restarts the host safely from outside the hc process tree.
 *
 *   main.ts check                     one pass (launchd runs it every 60s)
 *   main.ts install | uninstall       the LaunchAgent dev.dori.supervisor
 *   main.ts pause | resume            stop or resume repairs (a migration, a planned outage)
 *   main.ts restart-host [--text WHY] [--delay S] [--core]
 *                                     restart Herdr Core (or with --core the hc core) from a detached launchd job,
 *                                     then bring the lead back with WHY in its handoff
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { check, pauseFile } from "./check.ts";
import { install, restartRun, scheduleRestart, uninstall } from "./launchd.ts";
import { type Paths, realSys, type Sys } from "./sys.ts";

export const paths = (env: Readonly<Record<string, string | undefined>> = process.env): Paths => ({
  home: resolve(env["DORI_HOME"] || join(homedir(), ".dori")),
  repo: resolve(import.meta.dir, "..", ".."),
  bun: process.execPath,
  agentCmd: env["DORI_AGENT_CMD"] || "omo",
  shell: env["SHELL"] || "/bin/zsh",
});

const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? undefined : argv[i + 1];
};

export async function main(argv: readonly string[], sys: Sys = realSys, p: Paths = paths()): Promise<number> {
  const delayS = Number(flag(argv, "delay") ?? "20");
  const core = argv.includes("--core");
  switch (argv[0]) {
    case "check":
      return check(sys, p);
    case "install":
      return install(sys, p);
    case "uninstall":
      return uninstall(sys);
    case "pause":
      mkdirSync(dirname(pauseFile(p)), { recursive: true });
      writeFileSync(pauseFile(p), `${flag(argv, "text") ?? "paused"}\n`);
      sys.log("PAUSED");
      return 0;
    case "resume":
      rmSync(pauseFile(p), { force: true });
      sys.log("RESUMED");
      return 0;
    case "restart-host": {
      const note = flag(argv, "text");
      return scheduleRestart(sys, p, { core, delayS, ...(note ? { note } : {}) });
    }
    case "restart-run":
      return restartRun(sys, p, { core, delayS });
    default:
      console.log(
        "usage: main.ts check | install | uninstall | pause [--text WHY] | resume | restart-host [--text WHY] [--delay S] [--core]",
      );
      return argv[0] === undefined ? 0 : 64;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
