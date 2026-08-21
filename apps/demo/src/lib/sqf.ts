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

  const sections: { tag: string; lines: string[] }[] = [];
  let current: { tag: string; lines: string[] } | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("§") && !trimmed.startsWith("§§")) {
      const tag = trimmed.slice(1).toLowerCase();
      current = { tag, lines: [] };
      sections.push(current);
    } else if (current && trimmed) {
      current.lines.push(trimmed);
    }
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
