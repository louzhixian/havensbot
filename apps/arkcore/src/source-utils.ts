const parseLinkAttributes = (tag: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  const regex = /(\w+)\s*=\s*(".*?"|'.*?'|[^\s>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(tag))) {
    const name = match[1].toLowerCase();
    const raw = match[2];
    const value = raw.replace(/^['"]|['"]$/g, "");
    attrs[name] = value;
  }
  return attrs;
};

const extractFeedLinks = (html: string, baseUrl: string): string[] => {
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];
  const results = new Set<string>();
  for (const tag of tags) {
    const attrs = parseLinkAttributes(tag);
    const rel = attrs.rel ? attrs.rel.toLowerCase() : "";
    const type = attrs.type ? attrs.type.toLowerCase() : "";
    const href = attrs.href;
    if (!href) continue;
    if (!rel.split(/\s+/).includes("alternate")) continue;
    if (!type.includes("rss") && !type.includes("atom") && !type.includes("xml"))
      continue;

    try {
      const resolved = new URL(href, baseUrl).toString();
      results.add(resolved);
    } catch {
      continue;
    }
  }
  return Array.from(results);
};

export const fetchOfficialFeeds = async (inputUrl: string): Promise<string[]> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(inputUrl, {
      method: "GET",
      headers: {
        "User-Agent": "ArkCore/0.1 (+https://example.invalid)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) return [];

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const text = await response.text();
    if (
      contentType.includes("rss") ||
      contentType.includes("atom") ||
      (contentType.includes("xml") && (text.includes("<rss") || text.includes("<feed")))
    ) {
      return [inputUrl];
    }

    if (!contentType.includes("html")) return [];

    return extractFeedLinks(text, inputUrl);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
};

export const parseGithubRepo = (
  inputUrl: string
): { owner: string; repo: string } | null => {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return null;
  }

  if (url.hostname !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
};

export const splitUrlInput = (value: string): string[] => {
  const parts = value
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const cleaned =
      part.startsWith("<") && part.endsWith(">") ? part.slice(1, -1) : part;
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    unique.push(cleaned);
  }
  return unique;
};
