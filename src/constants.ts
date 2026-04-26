export const BIBLIO_FOLDER = "Bibliografía";

/**
 * Matches {{{key}}} or {{key}} (with optional :pages).
 * Use a non-capturing alternation so callers can test the full match
 * and examine the first characters to determine whether it's triple.
 */
export const CITATION_SOURCE = String.raw`(?:\{\{\{[^}:]+?(?::[^}]+?)?\}\}\}|\{\{[^}:]+?(?::[^}]+?)?\}\})`;
