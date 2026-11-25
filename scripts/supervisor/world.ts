import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shq } from "../../src/delivery.ts";
import type { Paths, Sys } from "./sys.ts";

export const ROLES = ["lead", "duty", "duty-loop", "hourly-loop"] as const;
export type Role = (typeof ROLES)[number];
export type Term = {
  readonly address: string;
  readonly pid: number;
  readonly labels: Readonly<Record<string, string>>;
};
export type Proc = { readonly pid: number; readonly ppid: number; readonly cmd: string };
export type Listener = { readonly kind: string; readonly match: RegExp; readonly command: string };

const OMO = /senpi\/dist|omo-ai|(^|[/\s])omo(\s|$)/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
/** The agent `agentCmd` starts, by the basename of its first word, plus omo's own processes (it runs as bun + senpi). */
export function agentPattern(agentCmd: string): RegExp {
  const word = agentCmd.trim().split(/\s+/)[0] ?? "omo";
  const base = escapeRe(word.split("/").at(-1) ?? word);
  return new RegExp(`${OMO.source}|(^|[/\\s])${base}(\\s|$)`);
}
/** What must run under a role's terminal for it to count as alive: the agent, or the loop's own dori command. */
const LOOPS: Readonly<Record<"duty-loop" | "hourly-loop", RegExp>> = {
  "duty-loop": /cli\.ts duty\b/,
  "hourly-loop": /cli\.ts loop\b/,
};
const NAMES: Readonly<Record<Role, string>> = {
  lead: "dori",
  duty: "duty",
  "duty-loop": "duty-loop",
  "hourly-loop": "hourly-loop",
};

const json = (text: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export async function hcUp(sys: Sys): Promise<boolean> {
  return (await sys.run(["hc", "server", "status", "--json"])).code === 0;
}

/**
 * Live local terminals carrying this home's dori.group label, with their root pid and labels. undefined when hc could not
 * say: a failed or garbled `ls` or `get` must never read as "no terminals", or every role would be opened a second time.
 */
export async function groupTerms(sys: Sys, group: string): Promise<Term[] | undefined> {
  const listed = await sys.run(["hc", "ls", "--json"]);
  const ls = json(listed.out);
  if (listed.code !== 0 || !Array.isArray(ls["terminals"])) return undefined;
  const out: Term[] = [];
  for (const row of ls["terminals"] as Record<string, unknown>[]) {
    const address = row["address"];
    if (typeof address !== "string" || address.includes("/") || row["state"] !== "live") continue;
    const fetched = await sys.run(["hc", "get", address, "--json"]);
    if (fetched.code !== 0) return undefined;
    const got = json(fetched.out);
    const labels = (got["labels"] ?? {}) as Record<string, string>;
    if (labels["dori.group"] === group && typeof got["pid"] === "number")
      out.push({ address, pid: got["pid"], labels });
  }
  return out;
}

/** The process table, or undefined when ps failed: an empty table would make every live terminal look agentless. */
export async function processes(sys: Sys): Promise<Proc[] | undefined> {
  const ps = await sys.run(["ps", "-axo", "pid=,ppid=,command="]);
  if (ps.code !== 0) return undefined;
  const out: Proc[] = [];
  for (const line of ps.out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! });
  }
  return out;
}

/** Every pid at or below one of the roots. */
export function treeOf(procs: readonly Proc[], roots: readonly number[]): Set<number> {
  const seen = new Set(roots);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs)
      if (seen.has(p.ppid) && !seen.has(p.pid)) {
        seen.add(p.pid);
        grew = true;
      }
  }
  return seen;
}

export function alive(t: Term, role: Role, procs: readonly Proc[], agentCmd: string): boolean {
  const tree = treeOf(procs, [t.pid]);
  const want = role === "lead" || role === "duty" ? agentPattern(agentCmd) : LOOPS[role];
  return procs.some((p) => p.pid !== t.pid && tree.has(p.pid) && want.test(p.cmd));
}

/** The inbound listeners this home has credentials for, each as the monitor command the lead arms. */
export function listeners(p: Paths): Listener[] {
  const dir = join(p.repo, "skills", "dori-mode", "scripts");
  const spec = [
    { kind: "telegram", args: "inbound telegram --loop 1" },
    { kind: "slack", args: "inbound slack --socket" },
  ];
  return spec
    .filter((s) => existsSync(join(p.home, `${s.kind}.env`)))
    .map((s) => ({
      kind: s.kind,
      // Anchored on the listener program itself: an agent whose prompt quotes this command must not count as one.
      match: new RegExp(`^\\S*bun src/cli\\.ts ${s.args.split(" ").slice(0, 2).join(" ")}\\b`),
      command: `. ${shq(join(p.home, `${s.kind}.env`))}; cd ${shq(dir)} && bun src/cli.ts ${s.args}`,
    }));
}

/** Renders the repo's prompt into the home on every launch, exactly as \`dori up\` does, so a relaunch carries today's rules. */
function promptFile(p: Paths, name: string): string {
  const out = join(p.home, "prompts", name);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, readFileSync(join(p.repo, "prompts", name), "utf8").replaceAll("{{dori}}", p.doriCmd));
  return out;
}

export const handoffFile = (p: Paths): string => join(p.home, "supervisor", "handoff-lead.md");

/** The command typed into a role's fresh shell: the same programs \`dori up\` starts, the lead with its handoff as first prompt. */
export function startCommand(p: Paths, role: Role): string {
  const dori = p.doriCmd;
  switch (role) {
    case "lead":
      return `${p.agentCmd} --append-system-prompt ${shq(promptFile(p, "lead.md"))} "$(cat ${shq(handoffFile(p))})"`;
    case "duty":
      return `${p.agentCmd} --append-system-prompt ${shq(promptFile(p, "duty.md"))}`;
    case "duty-loop":
      return `${dori} duty --interval 60`;
    case "hourly-loop":
      return `${dori} loop`;
  }
}

/** Opens the role's terminal the way \`dori up\` does (labels, env, the user's shell), starts its program, returns the address. */
export async function launch(sys: Sys, p: Paths, group: string, role: Role): Promise<string> {
  const name = NAMES[role];
  const env = role === "lead" ? [] : [`DORI_HOME=${p.home}`];
  const argv = (named: boolean) => [
    "hc",
    "run",
    "--json",
    "--bg",
    "--no-parent",
    "--no-notify",
    "--cwd",
    p.repo,
    "--label",
    `dori.group=${group}`,
    "--label",
    `dori.role=${role}`,
    "--label",
    `dori.name=${name}`,
    ...(named ? ["--name", name] : []),
    "--",
    "env",
    ...env,
    p.shell,
  ];
  let r = await sys.run(argv(true));
  if (r.code !== 0) r = await sys.run(argv(false));
  const address = json(r.out)["address"];
  if (r.code !== 0 || typeof address !== "string") throw new Error(`hc run for ${role} failed: ${r.err || r.out}`);
  // Same argv as the harness's own start(): `--` keeps a command starting with "-" from being read as a flag.
  const sent = await sys.run(["hc", "send", address, "--", startCommand(p, role)]);
  if (sent.code !== 0) throw new Error(`hc send to ${address} failed: ${sent.err || sent.out}`);
  return address;
}

/** Kill, then remove, retrying the remove while the terminal is still finishing (as the harness's own close does). */
export async function close(sys: Sys, address: string): Promise<void> {
  await sys.run(["hc", "kill", address]);
  for (let i = 0; i < 5 && (await sys.run(["hc", "rm", address])).code !== 0; i++) await sys.sleep(200);
}
