import { App, Notice, TFile } from "obsidian";
import { BIBLIO_FOLDER } from "./constants";

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

/**
 * Converts a citation key into a human-readable label.
 *
 * Recognised patterns (year = 4 digits + optional lowercase letter):
 *   AuthorYYYY           → "Author (YYYY)"
 *   Author1.Author2YYYY  → "Author1 & Author2 (YYYY)"
 *   Author.etalYYYY      → "Author et al. (YYYY)"
 *
 * Any key that doesn't end with a 4-digit year is returned as-is.
 */
export function formatCiteLabel(key: string): string {
  const m = key.match(/^(.+?)(\d{4}[a-z]?)$/);
  if (!m) return key;

  const authorPart = m[1]!;
  const year = m[2]!;

  const dotIdx = authorPart.indexOf(".");
  if (dotIdx !== -1) {
    const first = authorPart.slice(0, dotIdx);
    const second = authorPart.slice(dotIdx + 1);
    if (second.toLowerCase() === "etal") {
      return `${first} et al. (${year})`;
    }
    if (second.length > 0) {
      return `${first} & ${second} (${year})`;
    }
  }

  return `${authorPart} (${year})`;
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

/**
 * Extracts the last name from an author string.
 * Handles "LastName, F. M." format (returns part before comma)
 * and "First Last" format (returns last word).
 */
export function extractLastName(authorStr: string): string {
  const trimmed = authorStr.trim();
  if (trimmed.includes(",")) {
    return trimmed.slice(0, trimmed.indexOf(",")).trim();
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1]! : trimmed;
}

/**
 * Builds a citation key from a list of author strings and a year.
 * 1 author  → LastNameYear
 * 2 authors → LastName1LastName2Year
 * 3+ authors → LastName1etalYear
 */
export function buildCiteKey(authors: string[], year: number | string): string {
  const y = String(year);
  if (authors.length === 0) return y;
  if (authors.length === 1) return extractLastName(authors[0]!) + y;
  if (authors.length === 2)
    return extractLastName(authors[0]!) + extractLastName(authors[1]!) + y;
  return extractLastName(authors[0]!) + ".etal" + y;
}

/**
 * Moves `file` to `BIBLIO_FOLDER` and, if authors and year are provided,
 * renames it to the citation key. Both operations are done in a single
 * `renameFile` call so the file is never in an intermediate state.
 *
 * If a file with the target name already exists, a sequential lowercase
 * letter suffix is appended (a, b, c, …).
 *
 * Does nothing if the file is already at the correct path.
 */
export async function moveAndRenameFileByCiteKey(
  app: App,
  file: TFile,
  authors: string[],
  year: number | string | null | undefined,
): Promise<void> {
  // Determine the target basename (cite key or keep current name)
  const baseName =
    year && authors.length > 0 ? buildCiteKey(authors, year) : file.basename;

  // Find a free name inside BIBLIO_FOLDER
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let finalName = baseName;
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? baseName : baseName + alphabet[i - 1]!;
    const candidatePath = `${BIBLIO_FOLDER}/${candidate}.md`;
    const existing = app.vault.getAbstractFileByPath(candidatePath);
    if (!existing || existing === file) {
      finalName = candidate;
      break;
    }
    if (i >= alphabet.length) {
      new Notice(`Bibman: no se pudo encontrar un nombre libre para "${baseName}".`);
      return;
    }
  }

  const newPath = `${BIBLIO_FOLDER}/${finalName}.md`;
  if (file.path === newPath) return; // already in the right place

  try {
    await app.fileManager.renameFile(file, newPath);
  } catch {
    new Notice(`Bibman: no se pudo mover/renombrar la nota a "${finalName}".`);
  }
}
