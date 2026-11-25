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
/** Replays are never sent closer together than this: not after one whose turn hit the limit again, nor after a HELD one. */
export const REPLAY_GAP_MS = 5 * 60_000;
/**
 * The provider's own limit error (as on 2026-11-25: "You've hit your org's monthly spend limit … (rate_limit)"), looked
 * for only in the last TAIL_LINES of the screen: words like "rate limit" in ordinary output must not count.
 */
const LIMIT =
  /\(rate_limit\)|hit your [\w' ]*limit|usage limit (has been |was )?reached|\/usage-credits|session limit resets/i;
const TAIL_LINES = 20;

/** Where the skill keeps owner-wait.json, resolved as its CLI does: DORI_STATE_DIR, the config's stateDir, ~/.dori/state. */
function stateDirOf(env: Sys["env"]): string {
  const home = env["HOME"] || homedir();
  const config = env["DORI_CONFIG"] ?? join(home, ".dori", "config.json");
  const raw = env["DORI_STATE_DIR"] ?? readJson<{ stateDir?: string }>(config, {}).stateDir ?? "~/.dori/state";
  return raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
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

const limitShown = (screen: string): boolean =>
  LIMIT.test(
    screen
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-TAIL_LINES)
      .join("\n"),
  );

const minutes = (ms: number): number => Math.floor(ms / 60_000);

type OwnerWait = {
  since?: number;
  where?: string;
  messages?: readonly { at: number; where: string; text: string }[];
};
type Watch = NonNullable<State["owner"]>;

/**
 * The limit is no longer on the lead's screen but the owner still waits: the turns that failed under it consumed his
 * messages, so they go back into the lead's inbox. If the limit shows again afterwards (the replayed turn failed too),
 * the next clear replays again. DELIVERED or QUEUED counts as sent; HELD may have arrived, so like a failure it is only
 * retried after REPLAY_GAP_MS, which bounds a possible duplicate to one per gap.
 */
async function replay(sys: Sys, p: Paths, o: Watch, w: OwnerWait, since: number, now: number): Promise<string> {
  const lines = (w.messages ?? []).map(
    (m) => `- ${new Date(m.at).toISOString()} ${m.where}: ${JSON.stringify(m.text)}`,
  );
  const text = `[missed during limit] Your screen no longer shows the provider limit, but these messages from the owner arrived while your turns were failing and are still unanswered (waiting since ${new Date(since).toISOString()}). Answer him now where he wrote:\n${lines.join("\n") || `- (text not recorded) ${w.where ?? ""}`}`;
  const r = await sys.run([p.bun, join(p.repo, "src", "cli.ts"), "send", "lead", "--text", text], {
    DORI_HOME: p.home,
  });
  o.replayTriedAt = now;
  const reply = `${r.out}\n${r.err}`;
  if (!/^(DELIVERED|QUEUED) /m.test(reply))
    return `WARN replay of missed owner messages failed (exit ${r.code}): ${reply.trim().split("\n")[0] ?? ""}`;
  o.replayedFor = since;
  o.replayAt = now;
  return `REPLAY ${(w.messages ?? []).length} owner message(s) missed during a provider limit to the lead`;
}

/**
 * The owner wrote (Slack or Telegram) and yena has not answered where he wrote. While the wait is open the lead's screen
 * is read every pass: a provider limit on it is remembered, and once it is gone the missed messages are replayed. Past
 * OWNER_WAIT_MS the owner hears it on Telegram, rate-limited. The lead is never relaunched from here: an idle lead and a
 * wedged one look alike on screen, so replacing it is left to the owner.
 */
export async function watchOwner(
  sys: Sys,
  p: Paths,
  st: State,
  lead: Term | undefined,
  now: number,
): Promise<string[]> {
  const w = readJson<OwnerWait>(join(stateDirOf(sys.env), "owner-wait.json"), {});
  if (w.since === undefined) return [];
  st.owner ??= {};
  const o = st.owner;
  const since = w.since;
  const waited = now - since;
  const where = w.where ?? "a messenger";
  const screen = lead ? await screenOf(sys, lead.address) : undefined;
  const limited = screen !== undefined && limitShown(screen);
  const actions: string[] = [];
  if (limited) {
    o.limitedFor = since;
    o.limitAt = now;
  } else if (lead && screen !== undefined && o.limitedFor === since) {
    const due = o.replayTriedAt === undefined || now - o.replayTriedAt >= REPLAY_GAP_MS;
    const owed = o.replayedFor !== since || (o.limitAt ?? 0) > (o.replayAt ?? 0);
    if (due && owed) actions.push(await replay(sys, p, o, w, since, now));
  }
  if (waited < OWNER_WAIT_MS) return actions;
  actions.unshift(`WARN the owner has waited on yena since ${new Date(since).toISOString()} (${where})`);
  if (o.alertedFor !== since && (o.alertAt === undefined || now - o.alertAt >= ALERT_GAP_MS)) {
    const why = limited
      ? " 예나 화면에 사용량/요청 한도(rate limit) 메시지가 떠 있어서, 한도가 풀릴 때까지는 대답을 못 할 수 있어. 풀리면 놓친 메시지를 다시 넘겨줄게."
      : " 세션은 살아 있는데 대답이 없어. 확인이 필요하면 Slack이나 터미널에서 예나를 봐줘.";
    const text = `[dori supervisor] 예나가 대답을 안 하고 있어. 오빠가 ${where}에 보낸 메시지에 ${minutes(waited)}분째 답이 없어.${why} 로그: ~/Library/Logs/dori-supervisor.log`;
    const result = await alertOwner(sys, p, text);
    if (result.startsWith("alerted")) {
      o.alertedFor = since;
      o.alertAt = now;
    }
    actions.push(
      `ALERT owner unanswered for ${minutes(waited)}m${limited ? " (lead shows a provider limit)" : ""}: ${result}`,
    );
  }
  return actions;
}
