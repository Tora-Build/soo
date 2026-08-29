/**
 * Sooth Question Format (SQF) — Parser & Generator
 *
 * Encodes/decodes structured market metadata in the on-chain `question` string.
 * See docs/spec/sqf.md for the full spec.
 */

export interface SQFRule {
  description?: string;
  [key: string]: string | undefined;
}

export interface SQFData {
  question: string;
  /** Creator-supplied icon: an https image URL (or a legacy emoji from
   *  earlier markets). Capped hard — it shares the question's 300-byte
   *  on-chain budget. */
  icon?: string;
  rule: SQFRule;
  event?: string;
  category?: string;
  meta?: Record<string, string>;
}

/**
 * Parse a § formatted question string into structured data.
 */
export function parseSQF(raw: string): SQFData {
  const result: SQFData = { question: "", rule: {} };

  // Sections are delimited by § markers, NOT by newlines. The line-based
  // reader treated a single-line envelope — "§question Will X? §category
  // others", which is what several on-chain markets actually carry — as one
  // enormous tag, so the question parsed as empty and its card rendered
  // blank. Splitting on the marker reads both shapes: the tag is the word
  // after §, the body is everything up to the next §.
  const sections: { tag: string; lines: string[] }[] = [];
  const SECTION_RE = /§(?!§)([a-zA-Z]+)/g;
  const marks: Array<{ tag: string; start: number; end: number }> = [];
  for (let m = SECTION_RE.exec(raw); m; m = SECTION_RE.exec(raw)) {
    marks.push({
      tag: m[1].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (let i = 0; i < marks.length; i += 1) {
    const body = raw.slice(
      marks[i].end,
      i + 1 < marks.length ? marks[i + 1].start : undefined,
    );
    sections.push({
      tag: marks[i].tag,
      lines: body
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    });
  }

  for (const section of sections) {
    switch (section.tag) {
      case "question":
        result.question = section.lines.join(" ");
        break;

      case "rule": {
        const descLines: string[] = [];
        for (const line of section.lines) {
          const colonIdx = line.indexOf(":");
          if (
            colonIdx > 0 &&
            !line.startsWith("http") &&
            /^[a-z][a-z0-9-]*:/.test(line)
          ) {
            const key = line.slice(0, colonIdx).trim();
            const value = line.slice(colonIdx + 1).trim();
            result.rule[key] = value;
          } else {
            descLines.push(line);
          }
        }
        if (descLines.length > 0) {
          result.rule.description = descLines.join(" ");
        }
        break;
      }

      case "event":
        result.event = section.lines[0] || "";
        break;

      case "icon": {
        // An https image URL, or a short emoji from markets created before
        // URLs were supported. Capped at 200 bytes: the section shares the
        // question's 300-byte on-chain budget, and a field that accepts
        // arbitrary text is a second question field. Over-long values are
        // DISCARDED, never truncated — half a URL is not an icon.
        const raw = (section.lines[0] || "").trim();
        if (!raw || new TextEncoder().encode(raw).length > 200) break;
        if (/^https:\/\//i.test(raw) || !raw.includes("://")) {
          result.icon = raw;
        }
        break;
      }
      case "category":
        result.category = section.lines[0] || "";
        break;

      case "meta": {
        result.meta = {};
        for (const line of section.lines) {
          const colonIdx = line.indexOf(":");
          if (colonIdx > 0) {
            result.meta[line.slice(0, colonIdx).trim()] = line
              .slice(colonIdx + 1)
              .trim();
          }
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Generate a § formatted question string from structured data.
 */
export function generateSQF(data: SQFData): string {
  const lines: string[] = [];

  // §question
  lines.push("§question");
  lines.push(data.question);

  // §rule
  if (data.rule && Object.keys(data.rule).length > 0) {
    lines.push("§rule");
    if (data.rule.description) {
      lines.push(data.rule.description);
    }
    for (const [key, value] of Object.entries(data.rule)) {
      if (key !== "description" && value !== undefined) {
        lines.push(`${key}:${value}`);
      }
    }
  }

  // §event
  if (data.event) {
    lines.push("§event");
    lines.push(data.event);
  }

  // §icon
  if (data.icon?.trim()) {
    lines.push("§icon");
    lines.push(data.icon.trim());
  }

  // §category
  if (data.category) {
    lines.push("§category");
    lines.push(data.category);
  }

  // §meta
  if (data.meta && Object.keys(data.meta).length > 0) {
    lines.push("§meta");
    for (const [key, value] of Object.entries(data.meta)) {
      lines.push(`${key}:${value}`);
    }
  }

  return lines.join("\n");
}

/**
 * Extract just the human-readable question from a § formatted string.
 * Falls back to the raw string if no §question tag found.
 */
/** Parse SQF if present, otherwise return plain question with empty metadata */
export function parseSQFSafe(raw: string): SQFData {
  if (raw.includes("§question")) return parseSQF(raw);
  return { question: raw, rule: {} };
}
