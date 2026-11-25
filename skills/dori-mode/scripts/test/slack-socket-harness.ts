import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import type { Inbound } from "../src/messenger/slack-inbound.ts";
import {
  type OpenSocket,
  runSlackSocket,
  type SocketHandlers,
  type SocketModeOptions,
} from "../src/messenger/slack-socket.ts";

export const SELF = "U_YENA";
export const BOT = "B_YENA";

export type FakeSocket = { url: string; h: SocketHandlers; sent: string[]; closed: boolean };

export const harness = (openFailures = 0, extra: Partial<SocketModeOptions> = {}) => {
  const sockets: FakeSocket[] = [];
  const waiters: (() => void)[] = [];
  const opens: string[] = [];
  let failures = openFailures;
  const http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    opens.push(String(req.headers?.["Authorization"]));
    if (failures-- > 0)
      return { status: 200, headers: {}, body: JSON.stringify({ ok: false, error: "internal_error" }) };
    return { status: 200, headers: {}, body: JSON.stringify({ ok: true, url: `wss://fake/${opens.length}` }) };
  };
  const open: OpenSocket = (url, h) => {
    const s: FakeSocket = { url, h, sent: [], closed: false };
    sockets.push(s);
    for (const w of waiters.splice(0)) w();
    return {
      send: (d) => s.sent.push(d),
      close: () => {
        if (s.closed) return;
        s.closed = true;
        queueMicrotask(() => h.onClose());
      },
    };
  };
  const socket = (n: number): Promise<FakeSocket> =>
    new Promise((resolve) => {
      const check = () => {
        const s = sockets[n - 1];
        if (s) resolve(s);
        else waiters.push(check);
      };
      check();
    });
  const slept: number[] = [];
  const emitted: Inbound[] = [];
  const emitWaiters: (() => void)[] = [];
  const emittedCount = (n: number): Promise<void> =>
    new Promise((resolve) => {
      const check = () => (emitted.length >= n ? resolve() : emitWaiters.push(check));
      check();
    });
  const warned: string[] = [];
  let readies = 0;
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const timer = (fn: () => void, ms: number) => {
    const t = { fn, ms, live: true };
    timers.push(t);
    return () => {
      t.live = false;
    };
  };
  const fireIdle = () => {
    for (const t of timers.filter((x) => x.live)) t.fn();
  };
  const abort = new AbortController();
  const run = runSlackSocket({
    http,
    clock: { now: () => 0, sleep: async (ms: number) => void slept.push(ms) },
    appToken: "xapp-test",
    open,
    selfUserId: SELF,
    emit: (i) => {
      emitted.push(i);
      for (const w of emitWaiters.splice(0)) w();
    },
    ready: () => void readies++,
    warn: (m) => void warned.push(m),
    base: "https://slack.test/api",
    timer,
    signal: abort.signal,
    ...extra,
  });
  const stop = async () => {
    abort.abort();
    await run;
  };
  return { socket, opens, slept, emitted, emittedCount, warned, readies: () => readies, stop, timers, fireIdle };
};

export const frame = (s: FakeSocket, value: object) => s.h.onMessage(JSON.stringify(value));
export const event = (s: FakeSocket, id: string, e: object) =>
  frame(s, { type: "events_api", envelope_id: id, payload: { event: e } });
