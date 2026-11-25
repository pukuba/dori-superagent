import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Inbound } from "./slack-inbound.ts";
import type { TgInbound } from "./telegram-inbound.ts";

/**
 * `<stateDir>/owner-wait.json`: since when the owner's oldest unanswered message has waited, and where it was sent. The
 * inbound listeners start the wait, `dori send` ends it, and the supervisor alerts the owner when it runs too long.
 */
type Said = { readonly at: number; readonly where: string; readonly text: string };
type OwnerWait = {
  readonly since?: number;
  readonly where?: string;
  /** What the owner wrote during this wait (the last KEEP messages), for the supervisor to replay after a limit. */
  readonly messages?: readonly Said[];
  readonly repliedAt?: number;
};

const KEEP = 10;

const fileOf = (stateDir: string): string => join(stateDir, "owner-wait.json");

const load = (file: string): OwnerWait => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as OwnerWait;
  } catch {
    return {};
  }
};

const save = (file: string, w: OwnerWait): void => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(w));
  renameSync(tmp, file);
};

/** The owner wrote: a wait starts unless one is running (the oldest unanswered message counts), and the text is kept. */
export const ownerSpoke = (stateDir: string, where: string, text: string, now: number = Date.now()): void => {
  const file = fileOf(stateDir);
  const w = load(file);
  const messages = [...(w.since === undefined ? [] : (w.messages ?? [])), { at: now, where, text: text.slice(0, 500) }];
  save(file, { since: w.since ?? now, where: w.where ?? where, messages: messages.slice(-KEEP) });
};

/** yena posted a message: whatever the owner was waiting on has an answer. */
export const yenaReplied = (stateDir: string, now: number = Date.now()): void =>
  save(fileOf(stateDir), { repliedAt: now });

/** Where a Slack line from the owner was sent, or undefined when it is not the owner's (or no owner id is configured). */
export const slackOwnerWhere = (i: Inbound, ownerId: string | undefined): string | undefined =>
  ownerId && i.user === ownerId && i.source !== "unread"
    ? `Slack ${i.channel}${i.threadTs ? ` thread ${i.threadTs}` : ""}`
    : undefined;

/** A new Telegram DM from the owner; edits and group topics do not start a wait. */
export const telegramOwnerWhere = (i: TgInbound, ownerId: number): string | undefined =>
  i.kind === "message" && i.source === "dm" && i.from === ownerId ? "Telegram DM" : undefined;
