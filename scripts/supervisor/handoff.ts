import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restartNote, supervisorDir } from "./state.ts";
import type { Paths, Sys } from "./sys.ts";
import { handoffFile, listeners } from "./world.ts";

/** A restart-host note is passed on only while it is this fresh. */
const NOTE_FRESH_MS = 30 * 60_000;

/**
 * Writes the relaunched lead's first prompt: why it is back, the listeners to arm, and a fresh restart note. Returns the
 * step that retires the note, for the caller to run once the launch succeeded, so a failed launch keeps it for the next.
 */
export function writeHandoff(p: Paths, why: string, sys: Sys): () => void {
  const note = restartNote(p);
  const fresh = existsSync(note) && sys.now() - statSync(note).mtimeMs < NOTE_FRESH_MS;
  const extra = fresh ? readFileSync(note, "utf8").trim() : "";
  const retire = (): void => {
    if (existsSync(note)) renameSync(note, `${note}.used`);
  };
  const monitors = listeners(p)
    .map(
      (l, i) =>
        `${i + 2}. Arm a PERSISTENT monitor (${l.kind} inbound): command \`${l.command}\`, filter ^(INBOUND|WARN|ERR).`,
    )
    .join("\n");
  const text = readFileSync(join(p.repo, "prompts", "supervisor-handoff.md"), "utf8")
    .replaceAll("{{time}}", () => new Date(sys.now()).toISOString())
    .replaceAll("{{reason}}", () => why)
    .replaceAll("{{monitors}}", () => monitors || "2. No inbound listener credentials are configured in this home.")
    .replaceAll("{{home}}", () => p.home)
    .replaceAll("{{repo}}", () => p.repo)
    .replaceAll("{{note}}", () => (extra ? `\nNote left by the session that asked for the restart:\n${extra}\n` : ""));
  writeFileSync(handoffFile(p), text);
  return retire;
}

/** Tells the owner once, over Telegram when this home has it, that a role keeps failing to start. Never throws. */
export async function alertOwner(sys: Sys, p: Paths, text: string): Promise<string> {
  const env = join(p.home, "telegram.env");
  if (!existsSync(env)) return "no telegram.env to alert through";
  const file = join(supervisorDir(p), "alert.txt");
  writeFileSync(file, text);
  const dir = join(p.repo, "skills", "dori-mode", "scripts");
  const script = `. "$1"; cd "$2" && bun src/cli.ts send telegram --to "$DORI_TELEGRAM_OWNER_ID" --text "$(cat "$3")"`;
  const r = await sys.run(["/bin/bash", "-c", script, "alert", env, dir, file]);
  return r.code === 0 ? "alerted the owner on Telegram" : `alert failed (exit ${r.code})`;
}
