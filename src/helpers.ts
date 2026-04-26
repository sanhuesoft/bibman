import { App, TFile } from "obsidian";

/**
 * Reads the raw frontmatter of `file` and wraps the scalar value of each
 * listed field in double quotes if it isn't already quoted.
 */
export async function quoteFields(app: App, file: TFile, fields: string[]): Promise<void> {
  const content = await app.vault.read(file);
  if (!content.startsWith("---")) return;
  const closingIdx = content.indexOf("\n---", 3);
  if (closingIdx === -1) return;
  const fieldSet = new Set(fields);
  let changed = false;
  const newHeader = content.slice(0, closingIdx).replace(
    /^([a-zA-Z_][a-zA-Z0-9_-]*): (.+)$/gm,
    (match, key: string, val: string) => {
      if (!fieldSet.has(key)) return match;
      const trimmed = val.trim();
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
      )
        return match;
      const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      changed = true;
      return `${key}: "${escaped}"`;
    },
  );
  if (changed) {
    await app.vault.modify(file, newHeader + content.slice(closingIdx));
  }
}

/**
 * Converts a full name to APA short format: "Last, F." or "Last, F. M."
 * Handles both "First Last" and "Last, First" input forms.
 */
export function formatAuthorApa(name: string): string {
  const trimmed = name.trim();
  let last: string;
  let givenParts: string[];

  if (trimmed.includes(",")) {
    const commaIdx = trimmed.indexOf(",");
    last = trimmed.slice(0, commaIdx).trim();
    givenParts = trimmed.slice(commaIdx + 1).trim().split(/\s+/).filter(Boolean);
  } else {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0]!;
    last = parts[parts.length - 1]!;
    givenParts = parts.slice(0, -1);
  }

  const initials = givenParts.map((p) => `${p[0]!.toUpperCase()}.`).join(" ");
  return initials ? `${last}, ${initials}` : last;
}

/** Strips spaces and hyphens from a raw ISBN string. */
export function normalizeIsbn(raw: string): string {
  return raw.trim().replace(/[\s-]/g, "");
}

/** Strips any prefix/URL and returns the bare DOI (e.g. "10.1016/j.xcrm…"). */
export function normalizeDoi(raw: string): string {
  const s = raw.trim();
  const urlMatch = s.match(/(?:https?:\/\/(?:dx\.)?doi\.org\/)(\S+)/i);
  if (urlMatch) return urlMatch[1]!;
  const prefixMatch = s.match(/^doi:\s*(\S+)/i);
  if (prefixMatch) return prefixMatch[1]!;
  return s;
}
