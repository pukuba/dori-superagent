export const isSlackNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((n) => typeof n === "string" && n.trim() !== "");

/** DORI_SLACK_NAMES="예나,yena": comma-separated; unset or blank keeps the config's list. */
export const envSlackNames = (value: string | undefined): string[] | undefined => {
  const names = (value ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  return names.length > 0 ? names : undefined;
};
