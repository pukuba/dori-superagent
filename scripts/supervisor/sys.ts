/** Everything the supervisor touches outside its own files, so tests can script the machine. */
export type RunResult = { readonly code: number; readonly out: string; readonly err: string };
export type Sys = {
  readonly run: (argv: readonly string[], env?: Readonly<Record<string, string>>) => Promise<RunResult>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
};

const RUN_TIMEOUT_MS = 60_000;

export const realSys: Sys = {
  run: async (argv, env) => {
    const p = Bun.spawn([...argv], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    const done = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(
      ([out, err, code]): RunResult => ({ code, out, err }),
    );
    // Resolves at the deadline even if a grandchild still holds the pipes, so one stuck call never stalls supervision.
    let timer: Timer | undefined;
    const late = new Promise<RunResult>((resolve) => {
      timer = setTimeout(() => {
        p.kill();
        resolve({ code: 124, out: "", err: `timed out after ${RUN_TIMEOUT_MS / 1000}s: ${argv.join(" ")}` });
      }, RUN_TIMEOUT_MS);
    });
    const result = await Promise.race([done, late]);
    clearTimeout(timer);
    return result;
  },
  now: Date.now,
  sleep: (ms) => Bun.sleep(ms),
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
};

/** Where things live: the dori home, this checkout, the bun binary, the agent command and the shell new terminals run. */
export type Paths = {
  readonly home: string;
  readonly repo: string;
  readonly bun: string;
  readonly agentCmd: string;
  readonly shell: string;
  /** The dori CLI as a shell command (`dori up`'s doriCmd): fills {{dori}} in prompts and runs the loops. */
  readonly doriCmd: string;
};
