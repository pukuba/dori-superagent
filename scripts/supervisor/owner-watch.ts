import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { alertOwner } from "./handoff.ts";
import { readJson, type State } from "./state.ts";
import type { Paths, Sys } from "./sys.ts";
import type { Term } from "./world.ts";

/** The owner is told once a message of theirs has gone this long without a reply from yena. */
export const OWNER_WAIT_MS = 10 * 60_000;
/** At most one such alert this often, however many waits start and end in between. */
export const ALERT_GAP_MS = 30 * 60_000;
/** A lead is relaunched only when its screen stayed the same this long, on top of OWNER_WAIT_MS, with no limit shown. */
export const STUCK_MS = 20 * 60_000;
/** A provider limit on the lead's screen: relaunching cannot help, so the alert says so and the lead is left alone. */
const LIMIT = /rate.?limit|usage limit|spend limit|usage-credits|quota|credit balance/i;

/** The skill's state dir, where the listeners keep owner-wait.json: DORI_STATE_DIR, config.json stateDir, else <home>/state. */
function stateDirOf(p: Paths, env: Sys["env"]): string {
  const raw = env["DORI_STATE_DIR"] ?? readJson<{ stateDir?: string }>(join(p.home, "config.json"), {}).stateDir;
  if (raw === undefined) return join(p.home, "state");
  return raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}

async function screenOf(sys: Sys, address: string): Promise<string | undefined> {
  const r = await sys.run(["hc", "read", address, "--json"]);
  if (r.code !== 0) return undefined;
  try {
    const text = (JSON.parse(r.out) as { text?: unknown }).text;
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

const minutes = (ms: number): number => Math.floor(ms / 60_000);

type OwnerWait = {
  since?: number;
  where?: string;
  messages?: readonly { at: number; where: string; text: string }[];
};

/**
 * The limit is gone but the owner still waits: the turns that failed under it consumed his messages, so they are put
 * back into the lead's inbox once. DELIVERED or QUEUED counts as done; anything else is retried on the next pass.
 */
async function replay(
  sys: Sys,
  p: Paths,
  o: NonNullable<State["owner"]>,
  w: OwnerWait,
  since: number,
): Promise<string> {
  const lines = (w.messages ?? []).map(
    (m) => `- ${new Date(m.at).toISOString()} ${m.where}: ${JSON.stringify(m.text)}`,
  );
  const text = `[missed during limit] Your provider limit has cleared, but these messages from the owner arrived while your turns were failing and are still unanswered (waiting since ${new Date(since).toISOString()}). Answer him now where he wrote:\n${lines.join("\n") || `- (text not recorded) ${w.where ?? ""}`}`;
  const r = await sys.run([p.bun, join(p.repo, "src", "cli.ts"), "send", "lead", "--text", text], {
    DORI_HOME: p.home,
  });
  const reply = `${r.out}\n${r.err}`;
  if (!/^(DELIVERED|QUEUED) /m.test(reply))
    return `WARN replay of missed owner messages failed (exit ${r.code}): ${reply.trim().split("\n")[0] ?? ""}`;
  o.replayedFor = since;
  return `REPLAY ${(w.messages ?? []).length} owner message(s) missed during a provider limit to the lead`;
}

/**
 * The owner wrote (Slack or Telegram) and yena has not posted since: past OWNER_WAIT_MS the owner hears it on Telegram,
 * rate-limited. `stuck` is set, once per wait, when the live lead's screen has not changed for STUCK_MS and shows no
 * provider limit: the caller replaces that lead. A lead that is out of quota is never replaced, only reported.
 */
export async function watchOwner(
  sys: Sys,
  p: Paths,
  st: State,
  lead: Term | undefined,
  now: number,
): Promise<{ actions: string[]; stuck?: string }> {
  const w = readJson<OwnerWait>(join(stateDirOf(p, sys.env), "owner-wait.json"), {});
  st.owner ??= {};
  const o = st.owner;
  if (w.since === undefined || now - w.since < OWNER_WAIT_MS) {
    delete o.screen;
    delete o.screenSince;
    return { actions: [] };
  }
  const waited = now - w.since;
  const where = w.where ?? "a messenger";
  const screen = lead ? await screenOf(sys, lead.address) : undefined;
  const limited = screen !== undefined && LIMIT.test(screen);
  if (screen !== undefined) {
    const hash = createHash("sha256").update(screen).digest("hex");
    if (hash !== o.screen) {
      o.screen = hash;
      o.screenSince = now;
    }
  }
  const actions = [`WARN the owner has waited on yena since ${new Date(w.since).toISOString()} (${where})`];
  if (o.alertedFor !== w.since && (o.alertAt === undefined || now - o.alertAt >= ALERT_GAP_MS)) {
    const why = limited
      ? " 예나 화면에 사용량/요청 한도(rate limit) 메시지가 떠 있어서, 한도가 풀릴 때까지는 대답을 못 할 수 있어."
      : " 계속 화면이 멈춰 있으면 supervisor가 예나 세션을 새로 띄워볼게.";
    const text = `[dori supervisor] 예나가 대답을 안 하고 있어. 오빠가 ${where}에 보낸 메시지에 ${minutes(waited)}분째 답이 없어.${why} 로그: ~/Library/Logs/dori-supervisor.log`;
    const result = await alertOwner(sys, p, text);
    if (result.startsWith("alerted")) {
      o.alertedFor = w.since;
      o.alertAt = now;
    }
    actions.push(
      `ALERT owner unanswered for ${minutes(waited)}m${limited ? " (lead shows a provider limit)" : ""}: ${result}`,
    );
  }
  if (limited) o.limitedFor = w.since;
  else if (lead && screen !== undefined && o.limitedFor === w.since && o.replayedFor !== w.since) {
    actions.push(await replay(sys, p, o, w, w.since));
    return { actions };
  }
  const still = screen !== undefined && o.screenSince !== undefined ? now - o.screenSince : 0;
  if (!lead || limited || o.relaunchedFor === w.since || still < STUCK_MS) return { actions };
  o.relaunchedFor = w.since;
  return {
    actions,
    stuck: `the owner waited ${minutes(waited)} minutes for a reply (${where}) while the lead's screen did not change for ${minutes(still)} minutes`,
  };
}
