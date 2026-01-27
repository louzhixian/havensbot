import { truncate } from "./utils.js";

export const buildBatchReply = (
  title: string,
  summary: string,
  lines: string[]
): string => {
  const shown = lines.slice(0, 20);
  const extra = lines.length - shown.length;
  const body = [
    title,
    summary,
    ...shown,
    extra > 0 ? `...and ${extra} more` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return truncate(body, 1800);
};
