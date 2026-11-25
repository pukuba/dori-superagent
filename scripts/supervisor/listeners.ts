import { homedir } from "node:os";
import { join } from "node:path";
import type { State } from "./state.ts";
import type { Paths, Sys } from "./sys.ts";
import { listeners, type Proc, type Term, treeOf } from "./world.ts";

/** The lead is asked to re-arm missing listeners at most this often. */
export const NUDGE_EVERY_MS = 10 * 60_000;
/** A relaunched lead gets this long to arm its listeners before it is nudged. */
const ARM_GRACE_MS = 3 * 60_000;

/**
 * An orphan is stopped only when it is positively this home's and nobody's anymore: a listener whose wrapper shell
 * sources this home's env file and has been reparented to launchd (pid 1), outside every terminal of this group. A
 * listener of another home, one started by hand in a terminal, or one whose wrapper is gone is left alone.
 */
function orphansOf(procs: readonly Proc[], live: readonly Proc[], envFile: string, inGroup: Set<number>): Proc[] {
  const tags = [envFile, envFile.replace(homedir(), "~")];
  const out: Proc[] = [];
  for (const l of live) {
    const wrapper = procs.find((pr) => pr.pid === l.ppid);
    if (wrapper?.ppid !== 1 || inGroup.has(l.pid) || !tags.some((t) => wrapper.cmd.includes(t))) continue;
    out.push(wrapper, l);
  }
  return out;
}

/** Listeners belong to the lead: this home's orphans are stopped, missing ones are asked of the lead. */
export async function tendListeners(
  sys: Sys,
  p: Paths,
  st: State,
  terms: readonly Term[],
  procs: readonly Proc[],
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
    const live = procs.filter((pr) => l.match.test(pr.cmd));
    const orphans = orphansOf(procs, live, join(p.home, `${l.kind}.env`), inGroup);
    for (const o of orphans) await sys.run(["kill", String(o.pid)]);
    if (orphans.length > 0) out.push(`KILL orphaned ${l.kind} listener pids ${orphans.map((o) => o.pid).join(" ")}`);
    if (!live.some((pr) => leadTree.has(pr.pid))) missing.push(l.kind);
  }
  if (missing.length === 0) delete st.nudgedAt;
  const fresh = st.launched.lead !== undefined && now - st.launched.lead < ARM_GRACE_MS;
  if (!lead || fresh || missing.length === 0) return out;
  if (st.nudgedAt !== undefined && now - st.nudgedAt < NUDGE_EVERY_MS) return out;
  const cmds = listeners(p)
    .filter((l) => missing.includes(l.kind))
    .map((l) => `- \`${l.command}\``)
    .join("\n");
  const text = `[SUPERVISOR] Your inbound listener(s) ${missing.join(", ")} are not running under this session, so messages from the owner are not reaching you. Arm each as a PERSISTENT monitor now (filter ^(INBOUND|WARN|ERR)) and do not reply to this message:\n${cmds}`;
  const r = await sys.run([p.bun, join(p.repo, "src", "cli.ts"), "send", "lead", "--text", text], {
    DORI_HOME: p.home,
  });
  const reply = `${r.out}\n${r.err}`;
  // DELIVERED reached the lead. QUEUED waits in its inbox, and sending again would only queue a duplicate, so it
  // also starts the cooldown, but loudly. Anything else (HELD, an error) did not land: the next pass tries again.
  if (/^DELIVERED /m.test(reply)) {
    st.nudgedAt = now;
    out.push(`NUDGE lead to arm ${missing.join(",")}: delivered`);
  } else if (/^QUEUED /m.test(reply)) {
    st.nudgedAt = now;
    out.push(`WARN nudge to arm ${missing.join(",")} is queued in the lead's inbox, not delivered`);
  } else
    out.push(`WARN nudge to arm ${missing.join(",")} failed (exit ${r.code}): ${reply.trim().split("\n")[0] ?? ""}`);
  return out;
}
