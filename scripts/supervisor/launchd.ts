import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { check, restartMarker } from "./check.ts";
import type { Paths, Sys } from "./sys.ts";

export const SUPERVISOR_LABEL = "dev.dori.supervisor";
export const RESTART_LABEL = "dev.dori.restart-host";
const MAIN = join(import.meta.dir, "main.ts");
const HOLDER_WAIT_S = 120;

const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A launchd job running this script; secrets never go in it, the listeners source the home's env files themselves. */
export function plist(p: Paths, label: string, args: readonly string[], extra: string, log: string): string {
  const path = [
    dirname(p.bun),
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const env = { PATH: path.join(":"), HOME: homedir(), DORI_HOME: p.home, SHELL: p.shell };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[p.bun, MAIN, ...args].map((a) => `<string>${esc(a)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
    .map(([k, v]) => `<key>${k}</key><string>${esc(v)}</string>`)
    .join("")}</dict>
<key>WorkingDirectory</key><string>${esc(p.repo)}</string>
<key>StandardOutPath</key><string>${esc(log)}</string>
<key>StandardErrorPath</key><string>${esc(log)}</string>
${extra}
</dict></plist>
`;
}

const domain = async (sys: Sys): Promise<string> => `gui/${(await sys.run(["id", "-u"])).out.trim()}`;
const logFile = (name: string): string => join(homedir(), "Library", "Logs", name);

async function load(sys: Sys, label: string, file: string): Promise<void> {
  const gui = await domain(sys);
  await sys.run(["launchctl", "bootout", `${gui}/${label}`]);
  const r = await sys.run(["launchctl", "bootstrap", gui, file]);
  if (r.code !== 0) throw new Error(`launchctl bootstrap ${file} failed: ${r.err || r.out}`);
}

/** Installs and loads the LaunchAgent that runs \`check\` at login and every 60 seconds, surviving reboots and host restarts. */
export async function install(sys: Sys, p: Paths): Promise<number> {
  const file = join(homedir(), "Library", "LaunchAgents", `${SUPERVISOR_LABEL}.plist`);
  mkdirSync(dirname(file), { recursive: true });
  const extra =
    "<key>RunAtLoad</key><true/>\n<key>StartInterval</key><integer>60</integer>\n<key>ProcessType</key><string>Background</string>";
  writeFileSync(file, plist(p, SUPERVISOR_LABEL, ["check"], extra, logFile("dori-supervisor.log")));
  await load(sys, SUPERVISOR_LABEL, file);
  sys.log(`INSTALLED ${file} (log ~/Library/Logs/dori-supervisor.log)`);
  return 0;
}

export async function uninstall(sys: Sys): Promise<number> {
  const file = join(homedir(), "Library", "LaunchAgents", `${SUPERVISOR_LABEL}.plist`);
  await sys.run(["launchctl", "bootout", `${await domain(sys)}/${SUPERVISOR_LABEL}`]);
  if (existsSync(file)) rmSync(file);
  sys.log(`UNINSTALLED ${SUPERVISOR_LABEL}`);
  return 0;
}

/**
 * Schedules the host restart in a one-shot launchd job, so it runs outside the hc process tree it is about to end:
 * the caller (the lead) dies with Herdr Core, the job does not, and it brings the lead back when the core is up.
 */
export async function scheduleRestart(
  sys: Sys,
  p: Paths,
  o: { core: boolean; delayS: number; note?: string },
): Promise<number> {
  mkdirSync(join(p.home, "supervisor"), { recursive: true });
  if (o.note) writeFileSync(join(p.home, "restart-handoff.md"), `${o.note}\n`);
  const file = join(p.home, "supervisor", `${RESTART_LABEL}.plist`);
  const args = ["restart-run", "--delay", String(o.delayS), ...(o.core ? ["--core"] : [])];
  writeFileSync(file, plist(p, RESTART_LABEL, args, "<key>RunAtLoad</key><true/>", logFile("dori-restart-host.log")));
  await load(sys, RESTART_LABEL, file);
  sys.log(
    `SCHEDULED host restart (${o.core ? "hc core" : "Herdr Core app"}) in ${o.delayS}s from launchd job ${RESTART_LABEL}; the supervisor relaunches the lead after it`,
  );
  return 0;
}

const holderPid = async (sys: Sys): Promise<number | undefined> => {
  const r = await sys.run(["hc", "server", "status", "--json"]);
  try {
    const pid = (JSON.parse(r.out) as { holder?: { pid?: unknown } }).holder?.pid;
    return r.code === 0 && typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
};
const running = async (sys: Sys, pid: number): Promise<boolean> =>
  (await sys.run(["kill", "-0", String(pid)])).code === 0;

/** The job body: restart the Herdr Core app (the terminal holder macOS grants apply to) or the core, wait, then supervise. */
export async function restartRun(sys: Sys, p: Paths, o: { core: boolean; delayS: number }): Promise<number> {
  sys.log(`RESTART start in ${o.delayS}s (${o.core ? "core" : "app"})`);
  await sys.sleep(o.delayS * 1000);
  writeFileSync(restartMarker(p), String(sys.now()));
  try {
    if (o.core) {
      const r = await sys.run(["hc", "server", "restart"]);
      sys.log(`RESTART hc server restart exit=${r.code} ${(r.err || r.out).trim()}`);
    } else {
      const old = await holderPid(sys);
      if (old !== undefined) {
        await sys.run(["kill", "-TERM", String(old)]);
        for (let i = 0; i < 30 && (await running(sys, old)); i++) await sys.sleep(1000);
        if (await running(sys, old)) await sys.run(["kill", "-KILL", String(old)]);
        sys.log(`RESTART holder pid ${old} stopped`);
      }
      let now = await holderPid(sys);
      for (let i = 0; i < HOLDER_WAIT_S / 2 && now === undefined; i++) {
        if (i === 20)
          await sys.run(["open", join(homedir(), ".local", "share", "herdr-core", "active", "Herdr Core.app")]);
        await sys.sleep(2000);
        now = await holderPid(sys);
      }
      sys.log(now === undefined ? "RESTART ERR no terminal holder came back" : `RESTART holder back as pid ${now}`);
    }
  } finally {
    rmSync(restartMarker(p), { force: true });
  }
  const code = await check(sys, p, {
    reason: "the host was restarted on purpose with restart-host",
    duringRestart: true,
  });
  sys.log(`RESTART done check exit=${code}`);
  return code;
}
