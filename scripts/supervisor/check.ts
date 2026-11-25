import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groupId } from "../../src/runtime/group.ts";
import type { Paths, Sys } from "./sys.ts";
import {
  alive,
  close,
  groupTerms,
  handoffFile,
  hcUp,
  launch,
  listeners,
  processes,
  ROLES,
  type Role,
  type Term,
  treeOf,
} from "./world.ts";

/** A relaunched session gets this long to start its agent before it counts as dead. */
export const GRACE_MS = 3 * 60_000;
/** A live terminal with no agent in it is replaced only after it stayed that way this long (a person may be restarting it). */
export const AGENTLESS_MS = 2 * 60_000;
/** The lead is asked to re-arm missing listeners at most this often. */
export const NUDGE_EVERY_MS = 10 * 60_000;
/** A restart-host run is in progress while its marker is younger than this; checks leave the sessions alone meanwhile. */
export const RESTART_WINDOW_MS = 6 * 60_000;
const LOCK_STALE_MS = 10 * 60_000;
const OK_LOG_EVERY_MS = 60 * 60_000;

type State = {
  launched: Partial<Record<Role, number>>;
  agentless: Partial<Record<Role, number>>;
  nudgedAt?: number;
  lastSummary?: string;
  lastLogAt?: number;
};

const dir = (p: Paths): string => join(p.home, "supervisor");
export const restartMarker = (p: Paths): string => join(dir(p), "restarting");
export const pauseFile = (p: Paths): string => join(dir(p), "paused");

const said = (sys: Sys, line: string, code: number): number => {
  sys.log(line);
  return code;
};

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};

function setRole(p: Paths, role: Role, address: string): void {
  const file = join(p.home, "roles.json");
  writeFileSync(
    file,
    `${JSON.stringify({ ...readJson<Record<string, string>>(file, {}), [role]: `hc:${address}` }, null, 2)}\n`,
  );
}

function writeHandoff(p: Paths, why: string, sys: Sys): void {
  const note = join(p.home, "restart-handoff.md");
  const extra = existsSync(note) ? readFileSync(note, "utf8").trim() : "";
  if (extra) renameSync(note, `${note}.used`);
  const monitors = listeners(p)
    .map(
      (l, i) =>
        `${i + 2}. Arm a PERSISTENT monitor (${l.kind} inbound): command \`${l.command}\`, filter ^(INBOUND|WARN|ERR).`,
    )
    .join("\n");
  const text = readFileSync(join(p.repo, "prompts", "supervisor-handoff.md"), "utf8")
    .replaceAll("{{time}}", new Date(sys.now()).toISOString())
    .replaceAll("{{reason}}", why)
    .replaceAll("{{monitors}}", monitors || "2. No inbound listener credentials are configured in this home.")
    .replaceAll("{{home}}", p.home)
    .replaceAll("{{repo}}", p.repo)
    .replaceAll("{{note}}", extra ? `\nNote left by the session that asked for the restart:\n${extra}\n` : "");
  writeFileSync(handoffFile(p), text);
}

/** One supervision pass under a lock: hc up, each role alive and registered, the lead's listeners armed. 0 = fine or repaired. */
export async function check(
  sys: Sys,
  p: Paths,
  opts: { reason?: string; duringRestart?: boolean } = {},
): Promise<number> {
  mkdirSync(dir(p), { recursive: true });
  if (existsSync(pauseFile(p))) return said(sys, "PAUSED (remove supervisor/paused or run resume)", 0);
  const marker = restartMarker(p);
  if (!opts.duringRestart && existsSync(marker) && sys.now() - statSync(marker).mtimeMs < RESTART_WINDOW_MS)
    return said(sys, "RESTARTING host restart in progress, leaving sessions alone", 0);
  const lock = join(dir(p), "lock");
  try {
    mkdirSync(lock);
  } catch {
    if (sys.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return said(sys, "BUSY another check holds the lock", 0);
  }
  try {
    return await pass(sys, p, opts.reason);
  } finally {
    rmdirSync(lock);
  }
}

async function pass(sys: Sys, p: Paths, reason: string | undefined): Promise<number> {
  const runtime = readJson<{ runtime?: string }>(join(p.home, "config.json"), {}).runtime;
  if (runtime !== undefined && runtime !== "hc")
    return said(sys, `SKIP runtime is ${runtime}; the supervisor handles hc`, 0);
  if (!(await hcUp(sys))) {
    sys.log("REPAIR hc core is down: hc server start");
    await sys.run(["hc", "server", "start"]);
    for (let i = 0; i < 30 && !(await hcUp(sys)); i++) await sys.sleep(2000);
    if (!(await hcUp(sys))) return said(sys, "ERR hc core did not come up", 1);
  }
  const stateFile = join(dir(p), "state.json");
  const st = readJson<State>(stateFile, { launched: {}, agentless: {} });
  const group = groupId(p.home);
  const terms = await groupTerms(sys, group);
  const procs = await processes(sys);
  const roles = readJson<Record<string, string>>(join(p.home, "roles.json"), {});
  const now = sys.now();
  const actions: string[] = [];
  let lead: Term | undefined;
  for (const role of ROLES) {
    const mine = terms.filter((t) => t.labels["dori.role"] === role);
    const live = mine.filter((t) => alive(t, role, procs));
    if (live.length > 0) {
      const keep = live.find((t) => roles[role] === `hc:${t.address}`) ?? live[0]!;
      if (roles[role] !== `hc:${keep.address}`) {
        setRole(p, role, keep.address);
        actions.push(`REREGISTER ${role}=hc:${keep.address} (was ${roles[role] ?? "-"})`);
      }
      if (live.length > 1)
        actions.push(`WARN ${live.length} live ${role} sessions: ${live.map((t) => t.address).join(" ")}`);
      if (role === "lead") lead = keep;
      delete st.agentless[role];
      continue;
    }
    const launchedAt = st.launched[role];
    if (launchedAt !== undefined && now - launchedAt < GRACE_MS && mine.length > 0) {
      actions.push(`WAIT ${role} starting in ${mine.map((t) => t.address).join(" ")}`);
      continue;
    }
    if (mine.length > 0) {
      st.agentless[role] ??= now;
      const since = st.agentless[role];
      if (now - since < AGENTLESS_MS) {
        actions.push(
          `WAIT ${role} terminal ${mine.map((t) => t.address).join(" ")} has no agent since ${new Date(since).toISOString()}`,
        );
        continue;
      }
      for (const t of mine) await close(sys, t.address);
    }
    const why =
      mine.length > 0
        ? `its terminal ${mine.map((t) => `hc:${t.address}`).join(" ")} had no agent running for ${Math.round((now - st.agentless[role]!) / 1000)}s`
        : `no live ${role} terminal (registered as ${roles[role] ?? "-"})`;
    if (role === "lead") writeHandoff(p, reason ? `${reason}; ${why}` : why, sys);
    const address = await launch(sys, p, group, role);
    setRole(p, role, address);
    st.launched[role] = now;
    delete st.agentless[role];
    actions.push(`RELAUNCH ${role}=hc:${address} (${why})`);
  }
  actions.push(...(await tendListeners(sys, p, st, terms, procs, lead, now)));
  writeFileSync(stateFile, `${JSON.stringify(st)}\n`);
  const summary =
    actions.length > 0 ? actions.join("; ") : `OK ${ROLES.map((r) => `${r}=${roles[r] ?? "-"}`).join(" ")}`;
  if (actions.length > 0 || summary !== st.lastSummary || now - (st.lastLogAt ?? 0) > OK_LOG_EVERY_MS) {
    sys.log(summary);
    st.lastSummary = summary;
    st.lastLogAt = now;
    writeFileSync(stateFile, `${JSON.stringify(st)}\n`);
  }
  return 0;
}

/** Listeners belong to the lead: orphans outside every group terminal are stopped, missing ones are asked for. */
async function tendListeners(
  sys: Sys,
  p: Paths,
  st: State,
  terms: readonly Term[],
  procs: Parameters<typeof alive>[2],
  lead: Term | undefined,
  now: number,
): Promise<string[]> {
  const out: string[] = [];
  const inGroup = treeOf(
    procs,
    terms.map((t) => t.pid),
  );
  const leadTree = lead ? treeOf(procs, [lead.pid]) : new Set<number>();
  const missing: string[] = [];
  for (const l of listeners(p)) {
    const all = procs.filter((pr) => l.match.test(pr.cmd));
    const orphans = all.filter((pr) => !inGroup.has(pr.pid));
    for (const o of orphans) await sys.run(["kill", String(o.pid)]);
    if (orphans.length > 0) out.push(`KILL orphaned ${l.kind} listener pid ${orphans.map((o) => o.pid).join(" ")}`);
    if (!all.some((pr) => leadTree.has(pr.pid))) missing.push(l.kind);
  }
  const fresh = st.launched.lead !== undefined && now - st.launched.lead < GRACE_MS;
  if (!lead || fresh || missing.length === 0) {
    if (missing.length === 0) delete st.nudgedAt;
    return out;
  }
  if (st.nudgedAt !== undefined && now - st.nudgedAt < NUDGE_EVERY_MS) return out;
  const cmds = listeners(p)
    .filter((l) => missing.includes(l.kind))
    .map((l) => `- \`${l.command}\``)
    .join("\n");
  const text = `[SUPERVISOR] Your inbound listener(s) ${missing.join(", ")} are not running under this session, so messages from the owner are not reaching you. Arm each as a PERSISTENT monitor now (filter ^(INBOUND|WARN|ERR)) and do not reply to this message:\n${cmds}`;
  const r = await sys.run([p.bun, join(p.repo, "src", "cli.ts"), "send", "lead", "--text", text], {
    DORI_HOME: p.home,
  });
  st.nudgedAt = now;
  out.push(`NUDGE lead to arm ${missing.join(",")}: ${(r.out || r.err).trim().split("\n")[0] ?? r.code}`);
  return out;
}
