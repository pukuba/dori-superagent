import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groupId } from "../../src/runtime/group.ts";
import { alertOwner, writeHandoff } from "./handoff.ts";
import { tendListeners } from "./listeners.ts";
import { pauseFile, readJson, restartMarker, type State, supervisorDir } from "./state.ts";
import type { Paths, Sys } from "./sys.ts";
import { alive, close, groupTerms, hcUp, launch, processes, ROLES, type Role, type Term } from "./world.ts";

/** A relaunched session gets this long to start its agent before it counts as dead. */
export const GRACE_MS = 3 * 60_000;
/** A live terminal with no agent in it is replaced only after it stayed that way this long (a person may be restarting it). */
export const AGENTLESS_MS = 2 * 60_000;
/** After this many relaunches in a row whose agent never came up, the role backs off and the owner is alerted once. */
export const MAX_STREAK = 3;
export const BACKOFF_MS = 30 * 60_000;
/** A restart-host run is in progress while its marker is younger than this; checks leave the sessions alone meanwhile. */
export const RESTART_WINDOW_MS = 10 * 60_000;
const LOCK_STALE_MS = 10 * 60_000;
/** How long (2s steps) the restart job waits for a scheduled pass to release the lock. */
const LOCK_WAIT_TRIES = 90;
/** The same summary line is logged again at most this often. */
const OK_LOG_EVERY_MS = 60 * 60_000;

const said = (sys: Sys, line: string, code: number): number => {
  sys.log(line);
  return code;
};

function setRole(p: Paths, role: Role, address: string): void {
  const file = join(p.home, "roles.json");
  const roles = { ...readJson<Record<string, string>>(file, {}), [role]: `hc:${address}` };
  writeFileSync(file, `${JSON.stringify(roles, null, 2)}\n`);
}

/** One supervision pass under a lock: hc up, each role alive and registered, the lead's listeners armed. 0 = fine or repaired. */
export async function check(
  sys: Sys,
  p: Paths,
  opts: { reason?: string; duringRestart?: boolean } = {},
): Promise<number> {
  mkdirSync(supervisorDir(p), { recursive: true });
  if (existsSync(pauseFile(p))) return said(sys, "PAUSED (remove supervisor/paused or run resume)", 0);
  const marker = restartMarker(p);
  if (!opts.duringRestart && existsSync(marker) && sys.now() - statSync(marker).mtimeMs < RESTART_WINDOW_MS)
    return said(sys, "RESTARTING host restart in progress, leaving sessions alone", 0);
  const lock = join(supervisorDir(p), "lock");
  const token = `${process.pid}-${sys.now()}`;
  // The restart job waits for a scheduled pass to finish instead of giving up, so its reason reaches the new lead.
  let held = takeLock(lock, token, sys);
  for (let i = 0; !held && opts.duringRestart && i < LOCK_WAIT_TRIES; i++) {
    await sys.sleep(2000);
    held = takeLock(lock, token, sys);
  }
  // The restart job must not report success when it never got to relaunch the lead with its reason.
  if (!held) return said(sys, "BUSY another check holds the lock", opts.duringRestart ? 1 : 0);
  try {
    return await pass(sys, p, opts.reason);
  } finally {
    releaseLock(lock, token);
  }
}

/** Removes the lock only while it is still this pass's: a pass that outlived LOCK_STALE_MS may have lost it. */
function releaseLock(lock: string, token: string): void {
  try {
    if (readFileSync(join(lock, "owner"), "utf8") === token) rmSync(lock, { recursive: true });
  } catch {
    // already taken over or gone: not ours to remove
  }
}

/**
 * mkdir is the lock. A stale one is moved aside under a unique name (rename is atomic, so two passes cannot both move
 * the same lock) and mkdir is retried; only the pass whose mkdir succeeds proceeds. A lock that vanishes mid-look is retried.
 */
function takeLock(lock: string, token: string, sys: Sys): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(lock);
      try {
        writeFileSync(join(lock, "owner"), token);
      } catch {
        // an ownerless lock would block every pass until it went stale: undo it
        rmSync(lock, { recursive: true, force: true });
        return false;
      }
      return true;
    } catch {
      let age: number;
      try {
        age = sys.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age < LOCK_STALE_MS) return false;
      const aside = `${lock}.stale-${process.pid}-${sys.now()}`;
      try {
        renameSync(lock, aside);
        rmSync(aside, { recursive: true });
      } catch {
        // another pass moved it first; the next mkdir decides
      }
    }
  }
  return false;
}

async function pass(sys: Sys, p: Paths, reason: string | undefined): Promise<number> {
  const runtime = readJson<{ runtime?: string }>(join(p.home, "config.json"), {}).runtime;
  if (runtime !== undefined && runtime !== "hc")
    return said(sys, `SKIP runtime is ${runtime}; the supervisor handles hc`, 0);
  if (!(await hcUp(sys))) {
    sys.log("REPAIR hc core is down: hc server start");
    // Output to /dev/null: a core that daemonizes must not hold this pass's pipes open.
    await sys.run(["/bin/sh", "-c", "hc server start >/dev/null 2>&1 </dev/null"]);
    for (let i = 0; i < 30 && !(await hcUp(sys)); i++) await sys.sleep(2000);
    if (!(await hcUp(sys))) return said(sys, "ERR hc core did not come up", 1);
  }
  const stateFile = join(supervisorDir(p), "state.json");
  const st = readJson<State>(stateFile, { launched: {}, agentless: {} });
  try {
    return await repair(sys, p, reason, st);
  } finally {
    writeFileSync(stateFile, `${JSON.stringify(st)}\n`);
  }
}

async function repair(sys: Sys, p: Paths, reason: string | undefined, st: State): Promise<number> {
  st.streak ??= {};
  const streak = st.streak;
  const group = groupId(p.home);
  const terms = await groupTerms(sys, group);
  const procs = await processes(sys);
  if (terms === undefined || procs === undefined)
    return said(
      sys,
      `ERR could not read ${terms === undefined ? "hc terminals" : "the process table"}; changing nothing`,
      1,
    );
  const roles = readJson<Record<string, string>>(join(p.home, "roles.json"), {});
  const now = sys.now();
  const actions: string[] = [];
  let lead: Term | undefined;
  // Terminals seen alive by an earlier pass, or opened by this supervisor: only those are ever replaced when agentless.
  const seen = new Set((st.seen ?? []).filter((a) => terms.some((t) => t.address === a)));
  for (const role of ROLES) {
    const mine = terms.filter((t) => t.labels["dori.role"] === role);
    const live = mine.filter((t) => alive(t, role, procs, p.agentCmd));
    for (const t of live) seen.add(t.address);
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
      delete streak[role];
      continue;
    }
    const launchedAt = st.launched[role];
    const waitFor = (streak[role] ?? 0) >= MAX_STREAK ? BACKOFF_MS : GRACE_MS;
    if (launchedAt !== undefined && now - launchedAt < waitFor && (mine.length > 0 || waitFor === BACKOFF_MS)) {
      actions.push(
        waitFor === BACKOFF_MS ? `BACKOFF ${role} after ${streak[role]} failed relaunches` : `WAIT ${role} starting`,
      );
      continue;
    }
    const unknown = mine.filter((t) => !seen.has(t.address));
    if (unknown.length > 0) {
      actions.push(
        `WARN ${role} terminal ${unknown.map((t) => t.address).join(" ")} was never seen running its agent; leaving it alone`,
      );
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
    // Counted before the launch, so a launch that throws still moves the role toward its backoff and the owner's alert.
    st.launched[role] = now;
    delete st.agentless[role];
    streak[role] = (streak[role] ?? 0) + 1;
    try {
      if (role === "lead") writeHandoff(p, reason ? `${reason}; ${why}` : why, sys);
      const address = await launch(sys, p, group, role);
      seen.add(address);
      setRole(p, role, address);
      actions.push(`RELAUNCH ${role}=hc:${address} (${why})`);
    } catch (e) {
      actions.push(`ERR relaunch of ${role} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (streak[role] === MAX_STREAK) {
      const msg = `dori supervisor: the ${role} session was relaunched ${MAX_STREAK} times in a row and its agent never started. It now retries every ${BACKOFF_MS / 60_000} minutes. Last reason: ${why}. Log: ~/Library/Logs/dori-supervisor.log`;
      actions.push(`ERR ${role} keeps failing to start; ${await alertOwner(sys, p, msg)}`);
    }
  }
  st.seen = [...seen];
  actions.push(...(await tendListeners(sys, p, st, terms, procs, lead, now)));
  const summary =
    actions.length > 0 ? actions.join("; ") : `OK ${ROLES.map((r) => `${r}=${roles[r] ?? "-"}`).join(" ")}`;
  if (summary !== st.lastSummary || now - (st.lastLogAt ?? 0) > OK_LOG_EVERY_MS) {
    sys.log(summary);
    st.lastSummary = summary;
    st.lastLogAt = now;
  }
  return 0;
}
