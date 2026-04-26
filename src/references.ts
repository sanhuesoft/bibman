import { Editor, Notice } from "obsidian";

// ════════════════════════════════════════════════════════════════════════════
// [EXPERIMENTAL] Convert parenthetical citations → bibman syntax
//
// To remove this feature entirely:
//   1. Delete this whole file.
//   2. Remove the "Update references" addCommand block in main.ts onload().
// ════════════════════════════════════════════════════════════════════════════

/**
 * Converts inline citations from the legacy format
 *   word (Key).
 *   word (Key, pages).
 * to the bibman format
 *   word. {{Key}}
 *   word. {{Key:pages}}
 *
 * Returns the transformed string and the number of replacements made.
 *
 * The key is expected to match: one capital letter, then letters
 * (including accented), then a 4-digit year, optionally followed by
 * a single lowercase letter — e.g. García2020, Smith1999b.
 *
 * Handled formats:
 *   " (Key)."                    →  ". {{Key}}"
 *   " (Key, pages)."             →  ". {{Key:pages}}"
 *   " (Author, year)."           →  ". {{AuthorYear}}"
 *   " (Author, year, pages)."    →  ". {{AuthorYear:pages}}"
 *   ". ^[Key]"                   →  ". {{Key}}"
 *   ". ^[Key, pages]"            →  ". {{Key:pages}}"
 *   ". ^[Author, year]"          →  ". {{AuthorYear}}"
 *   ". ^[Author, year, pages]"   →  ". {{AuthorYear:pages}}"
 *   " ([[Author, year]])."       →  ". {{AuthorYear}}"
 *   " ([[Author, year, pages]])."→  ". {{AuthorYear:pages}}"
 */
export function convertParentheticalCitations(
  content: string,
): { result: string; count: number } {
  const KEY = String.raw`[A-ZÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑ][A-Za-záéíóúÁÉÍÓÚàèìòùäëïöüñÑ\w]*\d{4}[a-z]?`;
  // Author-only part (no trailing digits): used for "Autor, año" split format
  const AUTHOR = String.raw`[A-ZÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑ][A-Za-záéíóúÁÉÍÓÚàèìòùäëïöüñÑ]+`;

  // Format 1: <space>(Key). or <space>(Key, pages).
  const reParens = new RegExp(
    String.raw`[ \t]\((${KEY})(?:,\s*([^)]+?))?\)\.`,
    "g",
  );

  // Format 2: . ^[Key] or . ^[Key, pages]
  const reFootnote = new RegExp(
    String.raw`\. \^\[(${KEY})(?:,\s*([^\]]+?))?\]`,
    "g",
  );

  // Format 4: . ^[Author, year] or . ^[Author, year, pages]
  const reFootnoteAuthorYear = new RegExp(
    String.raw`\. \^\[(${AUTHOR}),\s*(\d{4}[a-z]?)(?:,\s*([^\]]+?))?\]`,
    "g",
  );

  // Format 3: (Autor, año). or (Autor, año, páginas).
  // Distinguishable from Format 1 because the key has no year attached.
  const reAuthorYear = new RegExp(
    String.raw`[ \t]\((${AUTHOR}),\s*(\d{4}[a-z]?)(?:,\s*([^)]+?))?\)\.`,
    "g",
  );

  // Format 5: <space>([[Author, year]]). or <space>([[Author, year, pages]]).
  const reWikiAuthorYear = new RegExp(
    String.raw`[ \t]\(\[\[(${AUTHOR}),\s*(\d{4}[a-z]?)(?:,\s*([^\]]+?))?\]\]\)\.`,
    "g",
  );

  const replacer = (_match: string, key: string, pages: string | undefined): string =>
    pages ? `. {{${key}:${pages.trim()}}}` : `. {{${key}}}`;

  let count = 0;
  const countingReplacer = (match: string, key: string, pages: string | undefined): string => {
    count++;
    return replacer(match, key, pages);
  };

  // Formats 3, 4 & 5 need their own replacer to merge author + year into the key
  const authorYearReplacer = (
    _match: string,
    author: string,
    year: string,
    pages: string | undefined,
  ): string => {
    count++;
    const key = `${author}${year}`;
    return pages ? `. {{${key}:${pages.trim()}}}` : `. {{${key}}}`;
  };

  const step1 = content.replace(reFootnoteAuthorYear, authorYearReplacer);
  const step2 = step1.replace(reAuthorYear, authorYearReplacer);
  const step3 = step2.replace(reWikiAuthorYear, authorYearReplacer);
  const step4 = step3.replace(reParens, countingReplacer);
  const result = step4.replace(reFootnote, countingReplacer);
  return { result, count };
}

export function runUpdateReferences(editor: Editor): void {
  const content = editor.getValue();
  const { result, count } = convertParentheticalCitations(content);
  if (count === 0) {
    new Notice("Bibman: no se encontraron referencias para convertir.");
    return;
  }
  editor.setValue(result);
  new Notice(
    `Bibman: ${count} referencia${count !== 1 ? "s" : ""} convertida${count !== 1 ? "s" : ""}.`,
  );
}
