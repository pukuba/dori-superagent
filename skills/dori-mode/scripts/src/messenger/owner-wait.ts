import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Inbound } from "./slack-inbound.ts";
import type { TgInbound } from "./telegram-inbound.ts";

/**
 * `<stateDir>/owner-wait.json`: since when the owner's oldest unanswered message has waited, where he wrote (`targets`,
 * e.g. `slack:C1` or `telegram:7`), and what he wrote. The inbound listeners start the wait, a `dori send` to one of
 * those targets ends it, and the supervisor alerts the owner when it runs too long.
 */
type Said = { readonly at: number; readonly where: string; readonly text: string };
type OwnerWait = {
  readonly since?: number;
  readonly where?: string;
  readonly targets?: readonly string[];
  readonly messages?: readonly Said[];
  readonly repliedAt?: number;
};
export type OwnerLine = { readonly where: string; readonly target: string };

const KEEP = 10;
const LOCK_STALE_MS = 10_000;
const LOCK_TRIES = 200;

const fileOf = (stateDir: string): string => join(stateDir, "owner-wait.json");

const load = (file: string): OwnerWait => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as OwnerWait;
  } catch {
    return {};
  }
};

const save = (file: string, w: OwnerWait): void => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(w));
  renameSync(tmp, file);
};

/** Two listeners and every `dori send` write this file: each read-modify-write holds a mkdir lock (stale after 10s). */
const locked = (file: string, change: (w: OwnerWait) => OwnerWait | undefined): void => {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released between our mkdir and stat: try again at once
      }
      if (age > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      else if (i >= LOCK_TRIES) throw new Error(`${lock} is held by another writer`);
      else Bun.sleepSync(10);
    }
  }
  try {
    const next = change(load(file));
    if (next) save(file, next);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};

/** The owner wrote: a wait starts unless one is running (the oldest unanswered message counts); target and text are kept. */
export const ownerSpoke = (stateDir: string, line: OwnerLine, text: string, now: number = Date.now()): void =>
  locked(fileOf(stateDir), (w) => {
    const open = w.since !== undefined;
    const targets = new Set([...(open ? (w.targets ?? []) : []), line.target]);
    const said = { at: now, where: line.where, text: text.slice(0, 500) };
    return {
      since: w.since ?? now,
      where: w.where ?? line.where,
      targets: [...targets],
      messages: [...(open ? (w.messages ?? []) : []), said].slice(-KEEP),
    };
  });

/** yena posted to `target`: the wait ends only when that is where the owner wrote; a post anywhere else leaves it open. */
export const yenaReplied = (stateDir: string, target: string, now: number = Date.now()): void =>
  locked(fileOf(stateDir), (w) =>
    w.since === undefined || (w.targets ?? []).includes(target) ? { repliedAt: now } : undefined,
  );

/** A Slack line from the owner, or undefined when it is not his (or no owner id is configured). */
export const slackOwnerLine = (i: Inbound, ownerId: string | undefined): OwnerLine | undefined =>
  ownerId && i.user === ownerId && i.source !== "unread"
    ? { where: `Slack ${i.channel}${i.threadTs ? ` thread ${i.threadTs}` : ""}`, target: `slack:${i.channel}` }
    : undefined;

/** A new Telegram DM from the owner; edits and group topics do not start a wait. */
export const telegramOwnerLine = (i: TgInbound, ownerId: number): OwnerLine | undefined =>
  i.kind === "message" && i.source === "dm" && i.from === ownerId
    ? { where: "Telegram DM", target: `telegram:${i.chat}` }
    : undefined;
