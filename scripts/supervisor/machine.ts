import type { RunResult, Sys } from "./sys.ts";

type T = { pid: number; labels: Record<string, string> };
type P = { pid: number; ppid: number; cmd: string };

/** A scripted machine: hc terminals, a process table, and every command the supervisor ran. */
export class Machine {
  terms = new Map<string, T>();
  procs: P[] = [];
  calls: string[][] = [];
  holder: number | undefined = 1000;
  dead = new Set<number>();
  onRun: () => void = () => {};
  /** What `dori send` prints, and whether `hc run` fails. */
  sendReply = { code: 0, out: "DELIVERED lead" };
  runFails = false;
  failing = new Set<string>();
  onLs: () => void = () => {};
  onSleep: () => void = () => {};
  /** What `hc read` shows per terminal address. */
  screens = new Map<string, string>();
  logs: string[] = [];
  clock = 1_000_000;
  next = 100;
  sys: Sys = {
    run: async (argv) => this.run(argv),
    now: () => this.clock,
    sleep: async () => this.onSleep(),
    log: (l) => void this.logs.push(l),
    env: { DORI_RUNTIME: "hc" },
  };
  constructor(readonly group: string) {}
  term(address: string, role: string, pid: number, agentCmd?: string): void {
    this.terms.set(address, { pid, labels: { "dori.group": this.group, "dori.role": role } });
    this.procs.push({ pid, ppid: 1, cmd: "/bin/zsh" });
    if (agentCmd) this.procs.push({ pid: pid + 1, ppid: pid, cmd: agentCmd });
  }
  ran = (word: string): string[][] => this.calls.filter((c) => c.includes(word));
  private run(argv: readonly string[]): RunResult {
    this.calls.push([...argv]);
    const ok = (out: unknown): RunResult => ({
      code: 0,
      out: typeof out === "string" ? out : JSON.stringify(out),
      err: "",
    });
    const [a, b, c] = argv;
    if (this.failing.has(`${a} ${b}`) || (a === "ps" && this.failing.has("ps")))
      return { code: 1, out: "", err: "failed" };
    if (a === "ps") return ok(this.procs.map((p) => `${p.pid} ${p.ppid} ${p.cmd}`).join("\n"));
    if (a === "kill" && b === "-0") return { code: this.dead.has(Number(c)) ? 1 : 0, out: "", err: "" };
    if (a === "kill") {
      if (b === "-TERM" && Number(c) === this.holder) {
        this.dead.add(this.holder);
        this.holder = 2000;
      }
      return ok("");
    }
    if (a !== "hc") return { ...this.sendReply, err: "" };
    if (b === "server") return ok(this.holder === undefined ? {} : { holder: { pid: this.holder } });
    if (b === "ls") this.onLs();
    if (b === "ls") return ok({ terminals: [...this.terms.keys()].map((address) => ({ address, state: "live" })) });
    if (b === "get") return ok({ ...this.terms.get(c!), address: c, cwd: `/work/${c}` });
    if (b === "read") return ok({ complete: true, how: "screen", text: this.screens.get(c!) ?? "" });
    if (b === "kill" || b === "rm") {
      this.terms.delete(c!);
      return ok({});
    }
    if (b === "run") {
      this.onRun();
      if (this.runFails) return { code: 1, out: "", err: "hc: spawn failed" };
      const labels: Record<string, string> = {};
      argv.forEach((v, i) => {
        if (argv[i - 1] === "--label") labels[v.split("=")[0]!] = v.split("=")[1]!;
      });
      const address = `t${(this.next++).toString(36)}`;
      this.terms.set(address, { pid: this.next * 10, labels });
      return ok({ address });
    }
    return ok({});
  }
}

export const AGENT = "/bun /x/senpi/dist/bundle/cli.js --append-system-prompt lead.md";

/** A home with a healthy harness: lead, duty and both loops alive and registered. */
export function healthy(m: Machine): void {
  m.term("t1", "lead", 10, AGENT);
  m.term("t2", "duty", 20, AGENT);
  m.term("t3", "duty-loop", 30, "bun /r/src/cli.ts duty --interval 60");
  m.term("t4", "hourly-loop", 40, "bun /r/src/cli.ts loop");
}
