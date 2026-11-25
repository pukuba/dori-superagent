import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./sys.ts";
import type { Role } from "./world.ts";

/** What one pass leaves for the next: launches, agentless sightings, failed-relaunch streaks, the last nudge and log line. */
export type State = {
  launched: Partial<Record<Role, number>>;
  agentless: Partial<Record<Role, number>>;
  /** Relaunches in a row whose agent never came up; cleared when the role is seen alive. */
  streak?: Partial<Record<Role, number>>;
  /** Addresses seen running their agent, or opened by the supervisor; only these are replaced when agentless. */
  seen?: string[];
  /** Where each role last ran, so a relaunch opens in the same directory `dori up` was given. */
  cwd?: Partial<Record<Role, string>>;
  nudgedAt?: number;
  /** The owner-wait watch: the wait last alerted and when, the wait whose lead was replaced, the lead's screen and since when. */
  owner?: { alertedFor?: number; alertAt?: number; relaunchedFor?: number; screen?: string; screenSince?: number };
  lastSummary?: string;
  lastLogAt?: number;
};

export const supervisorDir = (p: Paths): string => join(p.home, "supervisor");
export const restartMarker = (p: Paths): string => join(supervisorDir(p), "restarting");
export const pauseFile = (p: Paths): string => join(supervisorDir(p), "paused");
/** What restart-host was asked to pass on; used once, and only while it is fresh. */
export const restartNote = (p: Paths): string => join(supervisorDir(p), "restart-note.md");

export const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};
