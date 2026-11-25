/**
 * Slack Socket Mode inbound: @mentions of the bot and DMs to it arrive within seconds, which the poll path cannot see
 * with a bot token (`client.counts` answers `not_allowed_token_type`). The app token opens a WebSocket URL through
 * `apps.connections.open`; every envelope is acked by its `envelope_id`, and the socket is reopened after a `disconnect`,
 * a drop or a silence longer than `idleMs` (a half-open connection never closes), with backoff when it fails.
 */
import type { Clock } from "../run.ts";
import { type Http, MessengerError } from "./http.ts";
import { Slack } from "./slack.ts";
import type { Inbound } from "./slack-inbound.ts";

export type SocketHandlers = { readonly onMessage: (data: string) => void; readonly onClose: () => void };
export type SocketLike = { readonly send: (data: string) => void; readonly close: () => void };
export type OpenSocket = (url: string, handlers: SocketHandlers) => SocketLike;

export type SocketModeOptions = {
  readonly http: Http;
  readonly clock: Clock;
  readonly appToken: string;
  readonly open: OpenSocket;
  readonly selfUserId: string;
  readonly emit: (i: Inbound) => void | Promise<void>;
  /** True when a channel message calls the bot by name (see `nameCaller`); absent = only @mentions count. */
  readonly callsMe?: (text: string) => boolean;
  /** True when the bot has posted in this channel thread (the thread ledger); absent = no thread follow-ups. */
  readonly watchedThread?: (channel: string, rootTs: string) => Promise<boolean>;
  readonly ready: () => void;
  readonly warn: (message: string) => void;
  readonly base?: string;
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number };
  /** No frame for this long reopens the socket quietly (default 10 minutes). */
  readonly idleMs?: number;
  /** Calls `fn` after `ms` and returns its cancel; injectable for tests. */
  readonly timer?: (fn: () => void, ms: number) => () => void;
  readonly signal?: AbortSignal;
};

/**
 * Why this process must not open Socket Mode: a lane (DORI_LANE set) would add a second connection for the same app, and
 * Slack gives each event to only one connection, so the lead would silently miss some.
 */
export const laneRefusal = (env: Readonly<Record<string, string | undefined>>): string | undefined =>
  env["DORI_LANE"]
    ? `inbound slack --socket runs in the lead only (DORI_LANE=${env["DORI_LANE"]}): a second Socket Mode connection takes events away from the lead's`
    : undefined;

type SlackEvent = {
  readonly type?: string;
  readonly channel?: string;
  readonly channel_type?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly subtype?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly text?: string;
};
type Envelope = {
  readonly type?: string;
  readonly envelope_id?: string;
  readonly reason?: string;
  readonly payload?: { readonly event?: SlackEvent };
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What counts as calling the bot by name: one of `names`, case-insensitive, optionally followed by a Korean vocative or
 * honorific (야, 아, 씨, 님), with no letter, digit or `_` right before it or right after it. So "예나야 이거 봐",
 * "예나씨!", "yena, look" and "hey @yena" call it; "예나는 귀엽다" and "예나가 했어" (a particle: talking about it, not
 * to it), "명예나" and "yenatech" do not. A bare name with a space after it ("예나 귀엽다") still counts. Slack's
 * `<...>` tokens (links, user and channel mentions) are blanked first, so a name inside a URL is not a call.
 */
export const nameCaller = (names: readonly string[]): ((text: string) => boolean) => {
  const alts = names
    .map((n) => n.trim())
    .filter((n) => n !== "")
    .map(escapeRegExp);
  if (alts.length === 0) return () => false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.join("|")})(?:야|아|씨|님)?(?![\\p{L}\\p{N}_])`, "iu");
  return (text) => re.test(text.replace(/<[^>]*>/g, " "));
};

const inChannel = (e: SlackEvent): boolean =>
  e.type === "message" && (e.channel_type === "channel" || e.channel_type === "group");

/** A message a human wrote (not this bot, another bot, or an edit, join or other subtype), with what a line needs. */
const fromHuman = (
  e: SlackEvent | undefined,
  selfUserId: string,
): (SlackEvent & { channel: string; ts: string; user: string }) | undefined => {
  if (!e || !e.channel || !e.ts || !e.user) return undefined;
  if (e.subtype !== undefined || e.bot_id !== undefined || e.user === selfUserId) return undefined;
  return e as SlackEvent & { channel: string; ts: string; user: string };
};

export const inboundFromEvent = (
  event: SlackEvent | undefined,
  selfUserId: string,
  callsMe?: (text: string) => boolean,
): Inbound | undefined => {
  const e = fromHuman(event, selfUserId);
  if (!e) return undefined;
  const source =
    e.type === "app_mention"
      ? "mention"
      : e.type === "message" && e.channel_type === "im"
        ? "dm"
        : inChannel(e) && callsMe?.(e.text ?? "")
          ? "namecall"
          : undefined;
  if (!source) return undefined;
  return { source, channel: e.channel, ts: e.ts, threadTs: e.thread_ts, user: e.user, text: e.text };
};

/** A human reply inside a channel thread: an `own-thread` line once the caller finds the bot has posted there. */
export const threadReplyFromEvent = (event: SlackEvent | undefined, selfUserId: string): Inbound | undefined => {
  const e = fromHuman(event, selfUserId);
  if (!e || !inChannel(e) || !e.thread_ts || e.thread_ts === e.ts) return undefined;
  return { source: "own-thread", channel: e.channel, ts: e.ts, threadTs: e.thread_ts, user: e.user, text: e.text };
};

/**
 * One sink for the socket and the poll path in the same process: a message (channel+ts) is emitted once. It never moves a
 * thread's `seenTs` in the ledger: only the poll walk does, so a reply the socket missed (a reconnect gap) is still found.
 */
export const inboundSink = (print: (i: Inbound) => void, cap = 5_000): ((i: Inbound) => Promise<void>) => {
  const seen = new Set<string>();
  return async (i) => {
    if (i.ts) {
      const k = `${i.channel}:${i.ts}`;
      if (seen.has(k)) return;
      seen.add(k);
      if (seen.size > cap) seen.delete(seen.values().next().value as string);
    }
    print(i);
  };
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const runSlackSocket = async (o: SocketModeOptions): Promise<void> => {
  const appSlack = new Slack(o.http, o.clock, { token: o.appToken }, o.base);
  const backoff = o.backoff ?? { baseMs: 1_000, maxMs: 60_000 };
  const idleMs = o.idleMs ?? 10 * 60_000;
  const timer =
    o.timer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  let failures = 0;
  let greeted = false;
  let quiet = false;
  const wait = async (why: string) => {
    const ms = Math.min(backoff.maxMs, backoff.baseMs * 2 ** failures);
    failures++;
    o.warn(`slack socket ${why}; reconnecting in ${Math.round(ms / 1000)}s`);
    await o.clock.sleep(ms);
  };

  while (!o.signal?.aborted) {
    let url: string;
    try {
      url = String((await appSlack.call("apps.connections.open", {}))["url"] ?? "");
      if (!url) throw new MessengerError("slack apps.connections.open: no url", 200);
    } catch (e) {
      await wait(message(e));
      continue;
    }
    const end = await new Promise<"disconnect" | "closed">((resolve) => {
      let done = false;
      let sock: SocketLike | undefined;
      let cancelIdle = () => {};
      const finish = (why: "disconnect" | "closed") => {
        if (done) return;
        done = true;
        cancelIdle();
        o.signal?.removeEventListener("abort", abort);
        resolve(why);
      };
      const abort = () => {
        sock?.close();
        finish("closed");
      };
      o.signal?.addEventListener("abort", abort, { once: true });
      const armIdle = () => {
        cancelIdle();
        cancelIdle = timer(() => {
          quiet = true;
          finish("disconnect");
          sock?.close();
        }, idleMs);
      };
      const onMessage = (data: string) => {
        if (done) return;
        armIdle();
        let env: Envelope;
        try {
          env = JSON.parse(data) as Envelope;
        } catch {
          o.warn(`slack socket: unreadable frame ${data.slice(0, 80)}`);
          return;
        }
        if (env.envelope_id) sock?.send(JSON.stringify({ envelope_id: env.envelope_id }));
        if (env.type === "hello") {
          failures = 0;
          if (!greeted) o.ready();
          else if (!quiet) o.warn("slack socket reconnected");
          greeted = true;
          quiet = false;
        } else if (env.type === "disconnect") {
          o.warn(`slack socket disconnect (${env.reason ?? "no reason"}); reconnecting`);
          finish("disconnect");
          sock?.close();
        } else if (env.type === "events_api") {
          const event = env.payload?.event;
          const i = inboundFromEvent(event, o.selfUserId, o.callsMe);
          const reply = i || !o.watchedThread ? undefined : threadReplyFromEvent(event, o.selfUserId);
          const watched = o.watchedThread;
          const emitted = i
            ? Promise.resolve(o.emit(i))
            : reply && watched
              ? watched(reply.channel, reply.threadTs as string).then((yes) => (yes ? o.emit(reply) : undefined))
              : undefined;
          emitted?.catch((e: unknown) => o.warn(`slack socket emit: ${message(e)}`));
        }
      };
      try {
        sock = o.open(url, { onMessage, onClose: () => finish("closed") });
      } catch (e) {
        o.warn(`slack socket open: ${message(e)}`);
        finish("closed");
        return;
      }
      armIdle();
      if (o.signal?.aborted) abort();
    });
    if (o.signal?.aborted) return;
    if (end === "closed") await wait("closed");
  }
};
