import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestTriggerInfo,
  TFile,
} from "obsidian";
import type { BibmanPlugin } from "./main";
import { BIBLIO_FOLDER } from "./constants";
import type { BibSuggestion } from "./types";

export class BibCiteSuggest extends EditorSuggest<BibSuggestion> {
  readonly plugin: BibmanPlugin;
  _keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(app: App, plugin: BibmanPlugin) {
    super(app);
    this.plugin = plugin;

    // Intercept Tab in capture phase so we can confirm the suggestion
    // with cursor-before-}} behaviour before Obsidian swallows the key.
    this._keydownHandler = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !this.context) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chooser = (this as any).chooser as
        | { values: BibSuggestion[]; selectedItem: number }
        | undefined;
      if (!chooser) return;
      const item = chooser.values?.[chooser.selectedItem];
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      if ("create" in item) {
        this._createAndInsert(item.name, true);
      } else if ("placeholder" in item) {
        this._insert(item.name, true);
      } else {
        this._insert(item.basename, true);
      }
      this.close();
    };
    document.addEventListener("keydown", this._keydownHandler, true);
  }

  /** Remove the keydown listener. Call from BibmanPlugin.onunload(). */
  destroy(): void {
    if (this._keydownHandler) {
      document.removeEventListener("keydown", this._keydownHandler, true);
      this._keydownHandler = null;
    }
  }

  /** Shared insert logic. tabMode=true → cursor before }}, false → after }} */
  private _insert(basename: string, tabMode: boolean): void {
    const ctx = this.context as unknown as {
      start: { line: number; ch: number };
      end: { line: number; ch: number };
      editor: Editor;
    } | null;
    if (!ctx) return;
    const editor = ctx.editor;

    const prefix = editor.getRange(ctx.start, ctx.end);
    const isTriple = prefix.startsWith("{{{");
    const insertText = isTriple ? `{{{${basename}}}}` : `{{${basename}}}`;
    const closingLen = isTriple ? 3 : 2;

    // Detect auto-paired closing braces already present after the cursor
    const lineText = editor.getLine(ctx.end.line);
    const afterCursor = lineText.slice(ctx.end.ch);
    const trailingMatch = afterCursor.match(/^(}+)/);
    const extra = trailingMatch ? Math.min(trailingMatch[1]!.length, closingLen) : 0;
    const replaceEnd = extra > 0 ? { line: ctx.end.line, ch: ctx.end.ch + extra } : ctx.end;

    const cursorCh = tabMode
      ? ctx.start.ch + insertText.length - closingLen  // before }}
      : ctx.start.ch + insertText.length;              // after }}

    editor.replaceRange(insertText, ctx.start, replaceEnd);
    try {
      editor.setCursor({ line: ctx.start.line, ch: cursorCh });
    } catch (_e) {
      try {
        // @ts-ignore
        editor.setCursor(ctx.start.line, cursorCh);
      } catch (err) {
        console.debug("setCursor fallback failed", err);
      }
    }
    this.plugin.recordUsage(basename);
  }

  /** Creates the file in Bibliografía if absent, then immediately inserts the citation. */
  private _createAndInsert(name: string, tabMode: boolean): void {
    const useBiblio = this.plugin.settings.moveNewNoteToBiblio;
    const path = useBiblio ? `${BIBLIO_FOLDER}/${name}.md` : `${name}.md`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    const openFile = (file: TFile) =>
      void this.app.workspace.getLeaf("tab").openFile(file);
    if (!(existing instanceof TFile)) {
      void this.app.vault.create(path, "").then(openFile);
    } else {
      openFile(existing);
    }
    this._insert(name, tabMode);
  }

  onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    _file: TFile | null,
  ): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line).slice(0, cursor.ch);
    const triple = line.match(/\{\{\{([^}]*)$/);
    if (triple) {
      const startCh = triple.index ?? 0;
      return {
        start: { line: cursor.line, ch: startCh },
        end: cursor,
        query: triple[1] ?? "",
      };
    }
    const m = line.match(/\{\{([^}]*)$/);
    if (!m) return null;
    const startCh = m.index ?? 0;
    return {
      start: { line: cursor.line, ch: startCh },
      end: cursor,
      query: m[1] ?? "",
    };
  }

  getSuggestions(context: { query?: string }): BibSuggestion[] {
    const q = (context.query ?? "").toLowerCase().trim();
    const folderPrefix = `${BIBLIO_FOLDER}/`;
    const recentlyUsed = this.plugin.recentlyUsed;

    const files = this.app.vault.getFiles().filter(
      (f) =>
        f.path.normalize().startsWith(folderPrefix.normalize()) &&
        f.extension === "md",
    );

    const sortByRecency = (a: TFile, b: TFile) => {
      const ta = recentlyUsed.get(a.basename) ?? 0;
      const tb = recentlyUsed.get(b.basename) ?? 0;
      if (tb !== ta) return tb - ta;
      return a.basename.localeCompare(b.basename);
    };

    const existingBasenames = new Set(files.map((f) => f.basename.toLowerCase()));
    const placeholderSuggestions: BibSuggestion[] = [];
    for (const key of this.plugin.placeholderKeys) {
      const kl = key.toLowerCase();
      if (existingBasenames.has(kl)) continue;
      if (q.length === 0 || kl.includes(q)) {
        placeholderSuggestions.push({ placeholder: true, name: key });
      }
    }
    placeholderSuggestions.sort((a, b) =>
      (a as { placeholder: true; name: string }).name.localeCompare(
        (b as { placeholder: true; name: string }).name,
      ),
    );

    if (q.length === 0) {
      return [...files.slice().sort(sortByRecency), ...placeholderSuggestions].slice(0, 100);
    }

    const results = files.filter(
      (f) => f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
    );

    const sorted: BibSuggestion[] = [
      ...results.sort(sortByRecency),
      ...placeholderSuggestions,
    ].slice(0, 100);

    const exactMatch = files.some((f) => f.basename.toLowerCase() === q);
    if (!exactMatch) {
      sorted.push({ create: true, name: (context.query ?? "").trim() });
    }
    return sorted;
  }

  renderSuggestion(item: BibSuggestion, el: HTMLElement): void {
    el.empty();
    el.addClass("bibman-suggest");

    if ("create" in item) {
      el.addClass("bibman-suggest--create");
      const div = el.createEl("div", { text: `Crear "${item.name}"` });
      div.addClass("bibman-suggest-name");
    } else if ("placeholder" in item) {
      el.addClass("bibman-suggest--placeholder");
      const div = el.createEl("div", { text: item.name });
      div.addClass("bibman-suggest-name");
      const badge = el.createEl("span", { text: "sin nota" });
      badge.addClass("bibman-suggest-badge");
    } else {
      const div = el.createEl("div", { text: item.basename });
      div.addClass("bibman-suggest-name");
    }
  }

  selectSuggestion(item: BibSuggestion, _evt: KeyboardEvent | MouseEvent): void {
    // Enter / click → cursor after }}
    // Tab is handled by the keydown interceptor above; this path is never Tab.
    if ("create" in item) {
      this._createAndInsert(item.name, false);
    } else if ("placeholder" in item) {
      this._insert(item.name, false);
    } else {
      this._insert(item.basename, false);
    }
  }
}
