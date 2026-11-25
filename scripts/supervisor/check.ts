import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groupId } from "../../src/runtime/group.ts";
import { tendListeners } from "./listeners.ts";
import { pauseFile, readJson, restartMarker, restartNote, type State, supervisorDir } from "./state.ts";
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
} from "./world.ts";

/** A relaunched session gets this long to start its agent before it counts as dead. */
export const GRACE_MS = 3 * 60_000;
/** A live terminal with no agent in it is replaced only after it stayed that way this long (a person may be restarting it). */
export const AGENTLESS_MS = 2 * 60_000;
/** After this many relaunches in a row whose agent never came up, the role backs off and the owner is alerted once. */
export const MAX_STREAK = 3;
export const BACKOFF_MS = 30 * 60_000;
/** A restart-host run is in progress while its marker is younger than this; checks leave the sessions alone meanwhile. */
export const RESTART_WINDOW_MS = 6 * 60_000;
const LOCK_STALE_MS = 10 * 60_000;
const NOTE_FRESH_MS = 30 * 60_000;
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

function writeHandoff(p: Paths, why: string, sys: Sys): void {
  const note = restartNote(p);
  const fresh = existsSync(note) && sys.now() - statSync(note).mtimeMs < NOTE_FRESH_MS;
  const extra = fresh ? readFileSync(note, "utf8").trim() : "";
  if (existsSync(note)) renameSync(note, `${note}.used`);
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

/** Tells the owner once, over Telegram when this home has it, that a role keeps failing to start. Never throws. */
async function alertOwner(sys: Sys, p: Paths, text: string): Promise<string> {
  const env = join(p.home, "telegram.env");
  if (!existsSync(env)) return "no telegram.env to alert through";
  const file = join(supervisorDir(p), "alert.txt");
  writeFileSync(file, text);
  const dir = join(p.repo, "skills", "dori-mode", "scripts");
  const script = `. "$1"; cd "$2" && bun src/cli.ts send telegram --to "$DORI_TELEGRAM_OWNER_ID" --text "$(cat "$3")"`;
  const r = await sys.run(["/bin/bash", "-c", script, "alert", env, dir, file]);
  return r.code === 0 ? "alerted the owner on Telegram" : `alert failed (exit ${r.code})`;
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
  if (!takeLock(lock, sys)) return said(sys, "BUSY another check holds the lock", 0);
  try {
    return await pass(sys, p, opts.reason);
  } finally {
    rmdirSync(lock);
  }
}

/** mkdir is the lock; a stale one is removed and taken over, and only the pass whose mkdir succeeds proceeds. */
function takeLock(lock: string, sys: Sys): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      return true;
    } catch {
      if (attempt > 0 || sys.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
      rmdirSync(lock);
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
    await sys.run(["hc", "server", "start"]);
    for (let i = 0; i < 30 && !(await hcUp(sys)); i++) await sys.sleep(2000);
    if (!(await hcUp(sys))) return said(sys, "ERR hc core did not come up", 1);
  }
  const stateFile = join(supervisorDir(p), "state.json");
  const st = readJson<State>(stateFile, { launched: {}, agentless: {} });
  st.streak ??= {};
  const streak = st.streak;
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
    streak[role] = (streak[role] ?? 0) + 1;
    actions.push(`RELAUNCH ${role}=hc:${address} (${why})`);
    if (streak[role] === MAX_STREAK) {
      const msg = `dori supervisor: the ${role} session was relaunched ${MAX_STREAK} times in a row and its agent never started. It now retries every ${BACKOFF_MS / 60_000} minutes. Last reason: ${why}. Log: ~/Library/Logs/dori-supervisor.log`;
      actions.push(`ERR ${role} keeps failing to start; ${await alertOwner(sys, p, msg)}`);
    }
  }
  actions.push(...(await tendListeners(sys, p, st, terms, procs, lead, now)));
  const summary =
    actions.length > 0 ? actions.join("; ") : `OK ${ROLES.map((r) => `${r}=${roles[r] ?? "-"}`).join(" ")}`;
  if (actions.length > 0 || summary !== st.lastSummary || now - (st.lastLogAt ?? 0) > OK_LOG_EVERY_MS) {
    sys.log(summary);
    st.lastSummary = summary;
    st.lastLogAt = now;
  }
  writeFileSync(stateFile, `${JSON.stringify(st)}\n`);
  return 0;
}
