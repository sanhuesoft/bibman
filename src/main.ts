import {
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  Editor,
  EditorSuggest,
  EditorPosition,
  EditorSuggestTriggerInfo,
  App,
  requestUrl,
  setIcon,
} from "obsidian";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// ── Constants ─────────────────────────────────────────────────────────────────

const BIBLIO_FOLDER = "Bibliografía";

/**
 * Matches {{{key}}} or {{key}} (with optional :pages).
 * Use a non-capturing alternation so callers can test the full match
 * and examine the first characters to determine whether it's triple.
 */
const CITATION_SOURCE = String.raw`(?:\{\{\{[^}:]+?(?::[^}]+?)?\}\}\}|\{\{[^}:]+?(?::[^}]+?)?\}\})`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface BibEntry {
  author?: string;
  authors?: string[];
  title?: string;
  year?: string | number;
}

// ── Plugin settings ───────────────────────────────────────────────────────────

interface BibmanSettings {
  updateRefsOnRename: boolean;
  moveNewNoteToBiblio: boolean;
}

const DEFAULT_SETTINGS: BibmanSettings = {
  updateRefsOnRename: true,
  moveNewNoteToBiblio: true,
};

// ── Render child: hover popup ─────────────────────────────────────────────────

class BibmanRenderChild extends MarkdownRenderChild {
  private activePopup: HTMLElement | null = null;

  constructor(
    containerEl: HTMLElement,
    private readonly plugin: BibmanPlugin,
  ) {
    super(containerEl);
  }

  onload(): void {
    this.containerEl
      .querySelectorAll<HTMLElement>(".bibman-cite")
      .forEach((cite) => {
        this.registerDomEvent(cite, "mouseenter", () =>
          void this.showPopup(cite),
        );
        this.registerDomEvent(cite, "mouseleave", () => this.hidePopup());
        this.registerDomEvent(cite, "click", () => this.openNote(cite));
      });
  }

  onunload(): void {
    this.hidePopup();
  }

  private async showPopup(cite: HTMLElement): Promise<void> {
    const key = cite.dataset.bibkey;
    if (!key) return;

    const entry = await this.plugin.getBibEntry(key);
    this.hidePopup();

    const popup = document.createElement("div");
    popup.className = "bibman-popup";

    if (key.startsWith("W_")) {
      const badge = popup.appendChild(document.createElement("span"));
      badge.className = "bibman-popup__web-badge";
      setIcon(badge, "globe");
    }

    if (entry) {
      if (entry.title) {
        const p = popup.appendChild(document.createElement("p"));
        p.className = "bibman-popup__title";
        p.textContent = entry.title;
      }
      let authorLine = "";
      if (Array.isArray(entry.authors) && entry.authors.length > 0) {
        authorLine = entry.authors.join(" · ");
      } else if (entry.author) {
        authorLine = entry.author;
      }
      if (authorLine) {
        const p = popup.appendChild(document.createElement("p"));
        p.className = "bibman-popup__author";
        p.textContent = authorLine;
      }
      const pages = cite.dataset.bibpages;
      if (pages) {
        const p = popup.appendChild(document.createElement("p"));
        p.className = "bibman-popup__pages";
        p.textContent = `p. ${pages}`;
      }
      if (entry.year != null) {
        const p = popup.appendChild(document.createElement("p"));
        p.className = "bibman-popup__year";
        p.textContent = String(entry.year);
      }

      const hasAny = !!entry.title || !!authorLine || entry.year != null;
      if (!hasAny) {
        const pf = popup.appendChild(document.createElement("p"));
        pf.className = "bibman-popup__file";
        pf.textContent = key;
        const pn = popup.appendChild(document.createElement("p"));
        pn.className = "bibman-popup__note";
        pn.textContent = "Sin metadatos disponibles en la referencia.";
      }
    } else {
      const p = popup.appendChild(document.createElement("p"));
      p.className = "bibman-popup__error";
      p.textContent = `Referencia no encontrada: ${key}`;
    }

    const rect = cite.getBoundingClientRect();
    popup.style.setProperty("--bibman-x", `${Math.round(rect.left)}px`);
    popup.style.setProperty("--bibman-y", `${Math.round(rect.bottom + 6)}px`);

    document.body.appendChild(popup);
    this.activePopup = popup;
  }

  private hidePopup(): void {
    this.activePopup?.remove();
    this.activePopup = null;
  }

  private openNote(cite: HTMLElement): void {
    const key = cite.dataset.bibkey;
    if (!key) return;
    const path = `${BIBLIO_FOLDER}/${key}.md`;
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`Bibman: no se encontró la nota "${key}".`);
      return;
    }
    void this.plugin.app.workspace.getLeaf("tab").openFile(file);
  }
}

// ── CM6 editor extension: dim {{...}} in source / live-preview mode ───────────

function decorateView(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const markDouble = Decoration.mark({ class: "bibman-inline-cite" });
  const markTriple = Decoration.mark({ class: "bibman-inline-cite--triple" });
  const re = new RegExp(CITATION_SOURCE, "g");

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const start = from + match.index;
      const len = match[0].length;
      if (match[0].startsWith("{{{")) {
        builder.add(start, start + len, markTriple);
      } else {
        builder.add(start, start + len, markDouble);
      }
    }
  }

  return builder.finish();
}

const citationEditorPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = decorateView(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = decorateView(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ── Suggest item type ────────────────────────────────────────────────────────

type BibSuggestion = TFile | { create: true; name: string } | { placeholder: true; name: string };

// ── Main plugin ───────────────────────────────────────────────────────────────

export default class BibmanPlugin extends Plugin {
  private bibSuggest: EditorSuggest<BibSuggestion> | null = null;
  /** Debounce handles for the document-wide numbering sweep, keyed by sourcePath. */
  private readonly sweepTimers = new Map<string, number>();
  /** basename → last-used timestamp (ms). Persisted in plugin data. */
  recentlyUsed: Map<string, number> = new Map();
  settings: BibmanSettings = { ...DEFAULT_SETTINGS };
  /** Keys found in {{...}} across the vault that lack a Bibliografía note. */
  placeholderKeys: Set<string> = new Set();
  private _placeholderRebuildTimer: number | undefined;

  async onload(): Promise<void> {
    const saved = await this.loadData() as { recentlyUsed?: Record<string, number>; updateRefsOnRename?: boolean; moveNewNoteToBiblio?: boolean } | null;
    if (saved?.recentlyUsed) {
      this.recentlyUsed = new Map(Object.entries(saved.recentlyUsed));
    }
    this.settings = {
      updateRefsOnRename: saved?.updateRefsOnRename ?? DEFAULT_SETTINGS.updateRefsOnRename,
      moveNewNoteToBiblio: saved?.moveNewNoteToBiblio ?? DEFAULT_SETTINGS.moveNewNoteToBiblio,
    };

    this.addSettingTab(new BibmanSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        if (!this.settings.updateRefsOnRename) return;
        const oldFolder = oldPath.substring(0, oldPath.lastIndexOf("/"));
        const newFolder = file.parent?.path ?? "";
        if (oldFolder !== BIBLIO_FOLDER || newFolder !== BIBLIO_FOLDER) return;
        const oldBasename = oldPath
          .substring(oldPath.lastIndexOf("/") + 1)
          .replace(/\.md$/, "");
        const newBasename = file.basename;
        if (oldBasename === newBasename) return;
        void this.propagateRename(oldBasename, newBasename);
      }),
    );

    this.registerMarkdownPostProcessor(this.postProcessor.bind(this));
    this.registerEditorExtension(citationEditorPlugin);
    // Register an editor suggest that triggers on "{{" and lists files
    // from the Bibliografía folder.
    type SuggestContext = {
      start: { line: number; ch: number };
      end: { line: number; ch: number };
      query?: string;
      editor: Editor;
    };

    this.bibSuggest = new (class extends EditorSuggest<BibSuggestion> {
      plugin: BibmanPlugin;
      private _keydownHandler: ((e: KeyboardEvent) => void) | null = null;

      constructor(app: App, plugin: BibmanPlugin) {
        super(app);
        this.plugin = plugin;
        // Intercept Tab in capture phase so we can confirm the suggestion
        // with cursor-before-}} behaviour before Obsidian swallows the key.
        this._keydownHandler = (e: KeyboardEvent) => {
          if (e.key !== "Tab" || !this.context) return;
          // Access the internal chooser that Obsidian uses for suggestions.
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
            this._createAndInsert(item.name, /* tabMode */ true);
          } else if ("placeholder" in item) {
            this._insert(item.name, /* tabMode */ true);
          } else {
            this._insert(item.basename, /* tabMode */ true);
          }
          this.close();
        };
        document.addEventListener("keydown", this._keydownHandler, true);
      }

      /** Shared insert logic. tabMode=true → cursor before }}, false → after }} */
      private _insert(basename: string, tabMode: boolean): void {
        const ctx = this.context as unknown as { start: { line: number; ch: number }; end: { line: number; ch: number }; editor: Editor } | null;
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

      // suggest methods

      onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line).slice(0, cursor.ch);
        const triple = line.match(/\{\{\{([^}]*)$/);
        if (triple) {
          const startCh = triple.index ?? 0;
          return {
            start: { line: cursor.line, ch: startCh },
            end: cursor,
            query: (triple[1] ?? ""),
          };
        }

        const m = line.match(/\{\{([^}]*)$/);
        if (!m) return null;

        const startCh = m.index ?? 0;
        return {
          start: { line: cursor.line, ch: startCh },
          end: cursor,
          query: (m[1] ?? ""),
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
        // Dangling placeholder keys: used in {{...}} but no backing file in Bibliografía
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

        const results = files.filter((f) =>
          f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
        );

        const sorted: BibSuggestion[] = [
          ...results.sort(sortByRecency),
          ...placeholderSuggestions,
        ].slice(0, 100);

        const exactMatch =
          files.some((f) => f.basename.toLowerCase() === q);
        if (!exactMatch) {
          sorted.push({ create: true, name: (context.query ?? "").trim() });
        }
        return sorted;
      }

      renderSuggestion(item: BibSuggestion, el: HTMLElement) {
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
          this._createAndInsert(item.name, /* tabMode */ false);
        } else if ("placeholder" in item) {
          this._insert(item.name, /* tabMode */ false);
        } else {
          this._insert(item.basename, /* tabMode */ false);
        }
      }
    })(this.app, this);
    this.registerEditorSuggest(this.bibSuggest!);

    // Build the placeholder index on startup and keep it updated
    void this.rebuildPlaceholderIndex();
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md")
          this.schedulePlaceholderRebuild();
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", () => this.schedulePlaceholderRebuild()),
    );
    this.registerEvent(
      this.app.vault.on("delete", () => this.schedulePlaceholderRebuild()),
    );
    this.registerEvent(
      this.app.vault.on("rename", () => this.schedulePlaceholderRebuild()),
    );

    this.addCommand({
      id: "fill-frontmatter-from-doi",
      name: "Fill frontmatter from DOI",
      callback: () => new DoiInputModal(this.app, this).open(),
    });

    this.addCommand({
      id: "fill-frontmatter-from-isbn",
      name: "Fill frontmatter from ISBN",
      callback: () => new IsbnInputModal(this.app, this).open(),
    });

    this.addCommand({
      id: "open-or-create-reference-at-cursor",
      name: "Abrir o crear referencia en cursor",
      hotkeys: [{ modifiers: ["Mod"], key: "Enter" }],
      editorCallback: (editor: Editor) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const re = /\{\{\{([^}:]+?)(?::[^}]+?)?\}\}\}|\{\{([^}:]+?)(?::[^}]+?)?\}\}/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(line)) !== null) {
          const start = match.index;
          const end = start + match[0].length;
          if (cursor.ch >= start && cursor.ch <= end) {
            const key = ((match[1] ?? match[2]) ?? "").trim();
            if (!key) continue;
            const path = `${BIBLIO_FOLDER}/${key}.md`;
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
              void this.app.workspace.getLeaf("window").openFile(file);
            } else {
              new ConfirmCreateModal(this.app, key, this).open();
            }
            return;
          }
        }
        new Notice("Bibman: el cursor no está dentro de una referencia {{\u2026}}.");
      },
    });

    // ── [EXPERIMENTAL] Update references command – remove this block to disable ──
    this.addCommand({
      id: "update-references",
      name: "Update references",
      editorCallback: (editor) => runUpdateReferences(editor),
    });
    // ── end experimental block ────────────────────────────────────────────────
  }

  onunload(): void {
    for (const timer of this.sweepTimers.values()) clearTimeout(timer);
    this.sweepTimers.clear();
    if (this._placeholderRebuildTimer !== undefined) {
      window.clearTimeout(this._placeholderRebuildTimer);
      this._placeholderRebuildTimer = undefined;
    }
    // Clean up the keydown listener from the suggest
    if (this.bibSuggest) {
      const s = this.bibSuggest as unknown as { _keydownHandler: ((e: KeyboardEvent) => void) | null };
      if (s._keydownHandler) {
        document.removeEventListener("keydown", s._keydownHandler, true);
        s._keydownHandler = null;
      }
    }
    this.bibSuggest = null;
  }

  recordUsage(basename: string): void {
    this.recentlyUsed.set(basename, Date.now());
    void this.saveData({
      recentlyUsed: Object.fromEntries(this.recentlyUsed),
      updateRefsOnRename: this.settings.updateRefsOnRename,
      moveNewNoteToBiblio: this.settings.moveNewNoteToBiblio,
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData({
      recentlyUsed: Object.fromEntries(this.recentlyUsed),
      updateRefsOnRename: this.settings.updateRefsOnRename,
      moveNewNoteToBiblio: this.settings.moveNewNoteToBiblio,
    });
  }

  private schedulePlaceholderRebuild(): void {
    if (this._placeholderRebuildTimer !== undefined)
      window.clearTimeout(this._placeholderRebuildTimer);
    this._placeholderRebuildTimer = window.setTimeout(() => {
      this._placeholderRebuildTimer = undefined;
      void this.rebuildPlaceholderIndex();
    }, 1500);
  }

  async rebuildPlaceholderIndex(): Promise<void> {
    const folderPrefix = `${BIBLIO_FOLDER}/`;
    const existingKeys = new Set(
      this.app.vault
        .getFiles()
        .filter((f) => f.path.startsWith(folderPrefix) && f.extension === "md")
        .map((f) => f.basename.toLowerCase()),
    );
    const re = /\{\{\{([^}:]+?)(?::[^}]+?)?\}\}\}|\{\{([^}:]+?)(?::[^}]+?)?\}\}/g;
    const found = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      let content: string;
      try {
        content = await this.app.vault.cachedRead(file);
      } catch {
        continue;
      }
      if (!content.includes("{{")) continue;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const key = ((m[1] ?? m[2]) ?? "").trim();
        if (key && !existingKeys.has(key.toLowerCase())) {
          found.add(key);
        }
      }
    }
    this.placeholderKeys = found;
  }

  /**
   * Reads the frontmatter of `Bibliografía/<key>.md` and returns
   * the author, title, and year fields.
   */
  async getBibEntry(key: string): Promise<BibEntry | null> {
    const path = `${BIBLIO_FOLDER}/${key}.md`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;

    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm || typeof fm !== "object") return null;
    const fmr = fm as Record<string, unknown>;

    return {
      author: typeof fmr["author"] === "string" ? (fmr["author"] as string) : undefined,
      authors: Array.isArray(fmr["authors"])
        ? (fmr["authors"] as unknown[]).filter((a) => typeof a === "string") as string[]
        : Array.isArray(fmr["author"])
        ? (fmr["author"] as unknown[]).filter((a) => typeof a === "string") as string[]
        : undefined,
      title: typeof fmr["title"] === "string" ? (fmr["title"] as string) : undefined,
      year:
        typeof fmr["year"] === "string" || typeof fmr["year"] === "number"
          ? (fmr["year"] as string | number)
          : undefined,
    };
  }

  // ── Rename propagation ─────────────────────────────────────────────────────

  /**
   * Scans all markdown files in the vault and replaces every occurrence of
   * {{oldKey}} / {{oldKey:pages}} / {{{oldKey}}} / {{{oldKey:pages}}} with
   * the new key, mirroring Obsidian's native wikilink-rename behaviour.
   */
  private async propagateRename(oldKey: string, newKey: string): Promise<void> {
    const escaped = oldKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Triple braces must be matched first/separately to avoid partial overlap.
    const reTriple = new RegExp(
      `\\{\\{\\{${escaped}((?::[^}]+?)?)\\}\\}\\}`,
      "g",
    );
    // Double braces: use negative lookahead/lookbehind to exclude triple-brace.
    const reDouble = new RegExp(
      `(?<!\\{)\\{\\{(?!\\{)${escaped}((?::[^}]+?)?)\\}\\}(?!\\})`,
      "g",
    );

    const markdownFiles = this.app.vault.getMarkdownFiles();
    let count = 0;

    for (const file of markdownFiles) {
      const content = await this.app.vault.read(file);
      // Quick pre-check to avoid unnecessary regex work.
      if (!content.includes(`{{${oldKey}`) && !content.includes(`{{{${oldKey}`)) continue;

      let updated = content.replace(
        reTriple,
        (_, pages: string | undefined) => `{{{${newKey}${pages ?? ""}}}}`,
      );
      updated = updated.replace(
        reDouble,
        (_, pages: string | undefined) => `{{${newKey}${pages ?? ""}}}`,
      );

      if (updated !== content) {
        await this.app.vault.modify(file, updated);
        count++;
      }
    }

    if (count > 0) {
      new Notice(
        `Bibman: "${oldKey}" → "${newKey}" actualizado en ${count} nota${count !== 1 ? "s" : ""}.`,
      );
    }
  }

  // ── Post-processor (reading mode) ──────────────────────────────────────────

  private postProcessor(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ): void {
    if (!this.replaceCitations(el)) return;
    ctx.addChild(new BibmanRenderChild(el, this));
    this.scheduleNumberingSweep(ctx.sourcePath);
  }

  /**
   * Walks all text nodes in `root`, skipping code/pre blocks, and replaces
   * every {{key}} / {{key:pages}} match with a placeholder <sup> element.
   *
   * Returns true when at least one citation was replaced.
   */
  private replaceCitations(root: HTMLElement): boolean {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node): number {
        // Skip text inside verbatim blocks
        if (node.parentElement?.closest("code, pre")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    // Match either triple braces {{{key}}} or double braces {{key}}
    const re = new RegExp(String.raw`\{\{\{([^}:]+?)(?::([^}]+?))?\}\}\}|\{\{([^}:]+?)(?::([^}]+?))?\}\}`, "g");
    const pending: Array<{ node: Text; frags: Array<string | HTMLElement> }> = [];

    let node: Node | null = walker.nextNode();
    while (node !== null) {
      const text = (node as Text).data;
      if (text.includes("{{")) {
        re.lastIndex = 0;
        let cursor = 0;
        let match: RegExpExecArray | null;
        const frags: Array<string | HTMLElement> = [];

        while ((match = re.exec(text)) !== null) {
          if (match.index > cursor) frags.push(text.slice(cursor, match.index));

          const isTriple = !!match[1];
          const key = isTriple ? match[1] : match[3];
          const pages = isTriple ? match[2] : match[4];

          if (isTriple) {
            const span = document.createElement("span");
            span.className = "bibman-cite";
            span.dataset.bibkey = key;
            if (pages) span.dataset.bibpages = pages;
            span.dataset.bibvariant = "triple";
            span.textContent = "[Referencia]";
            frags.push(span);
          } else {
            const sup = document.createElement("sup");
            sup.className = "bibman-cite";
            sup.dataset.bibkey = key;
            if (pages) sup.dataset.bibpages = pages;
            sup.dataset.bibvariant = "double";
            sup.textContent = "[R]";
            // Wrap the preceding word + sup in a nowrap span so the
            // superscript never starts a new line separated from its word.
            const prevFrag = frags.length > 0 ? frags[frags.length - 1] : null;
            let wordTail = "";
            if (typeof prevFrag === "string") {
              const m = prevFrag.match(/(\S+\s*)$/);
              if (m) {
                wordTail = m[1]!;
                frags[frags.length - 1] = prevFrag.slice(0, prevFrag.length - wordTail.length);
              }
            }
            if (wordTail) {
              const wrapper = document.createElement("span");
              wrapper.style.whiteSpace = "nowrap";
              wrapper.appendChild(document.createTextNode(wordTail));
              wrapper.appendChild(sup);
              frags.push(wrapper);
            } else {
              frags.push(sup);
            }
          }

          cursor = match.index + match[0].length;
        }

        if (frags.length > 0) {
          if (cursor < text.length) frags.push(text.slice(cursor));
          pending.push({ node: node as Text, frags });
        }
      }
      node = walker.nextNode();
    }

    for (const { node, frags } of pending) {
      const parent = node.parentNode;
      if (!parent) continue;
      for (const frag of frags) {
        parent.insertBefore(
          typeof frag === "string" ? document.createTextNode(frag) : frag,
          node,
        );
      }
      parent.removeChild(node);
    }

    return pending.length > 0;
  }

  // ── Numbering sweep ────────────────────────────────────────────────────────

  /**
   * Debounces a document-level sweep so that, after all sections of a note
   * have been processed, citations get consecutive numbers in reading order.
   *
   * Same key always maps to the same number; numbers are assigned in order
   * of first appearance.
   */
  private scheduleNumberingSweep(sourcePath: string): void {
    const prev = this.sweepTimers.get(sourcePath);
    if (prev !== undefined) clearTimeout(prev);

    this.sweepTimers.set(
      sourcePath,
      window.setTimeout(() => {
        this.sweepTimers.delete(sourcePath);
        this.runNumberingSweep(sourcePath);
      }, 80),
    );
  }

  private runNumberingSweep(sourcePath: string): void {
    const leaves = this.app.workspace.getLeavesOfType("markdown");

    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      if (view.file?.path !== sourcePath) continue;

      const cites = Array.from(
        view.containerEl.querySelectorAll<HTMLElement>(".bibman-cite"),
      );

      const keyOrder = new Map<string, number>();
      let counter = 0;

      for (const cite of cites) {
        const key = cite.dataset.bibkey ?? "";
        if (!keyOrder.has(key)) keyOrder.set(key, ++counter);
        const n = keyOrder.get(key)!;
        // Keep citations as a generic reference marker — no numbering
        if (cite.dataset.bibvariant === "triple") {
          cite.textContent = "Referencia";
        } else {
          cite.textContent = "[R]";
        }
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// [EXPERIMENTAL] Convert parenthetical citations → bibman syntax
//
// To remove this feature entirely:
//   1. Delete this whole section (down to the matching ═══ comment).
//   2. Remove the "Update references" addCommand block in onload().
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
function convertParentheticalCitations(
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

function runUpdateReferences(editor: Editor): void {
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

// ════════════════════════════════════════════════════════════════════════════
// end [EXPERIMENTAL] Convert parenthetical citations
// ════════════════════════════════════════════════════════════════════════════

// ── DOI helpers ───────────────────────────────────────────────────────────────

/** Strips any prefix/URL and returns the bare DOI (e.g. "10.1016/j.xcrm…"). */
function normalizeDoi(raw: string): string {
  const s = raw.trim();
  // https://doi.org/10.xxx or http://dx.doi.org/10.xxx
  const urlMatch = s.match(/(?:https?:\/\/(?:dx\.)?doi\.org\/)(\S+)/i);
  if (urlMatch) return urlMatch[1]!;
  // doi:10.xxx
  const prefixMatch = s.match(/^doi:\s*(\S+)/i);
  if (prefixMatch) return prefixMatch[1]!;
  return s;
}

interface CrossRefMessage {
  type?: string;
  title?: string[];
  author?: { family?: string; given?: string }[];
  published?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  volume?: string;
  issue?: string;
  page?: string;
}

async function fetchDoiMetadata(doi: string): Promise<CrossRefMessage> {
  const encoded = encodeURIComponent(doi);
  const resp = await requestUrl({
    url: `https://api.crossref.org/works/${encoded}`,
    method: "GET",
    headers: { "User-Agent": "bibman-obsidian-plugin/1.0" },
  });
  if (resp.status !== 200) throw new Error(`CrossRef returned HTTP ${resp.status}`);
  const body = resp.json as { message?: CrossRefMessage };
  if (!body.message) throw new Error("Unexpected CrossRef response shape");
  return body.message;
}

function crossrefTypeToLocal(type: string | undefined): string {
  if (!type) return "journal";
  if (type.includes("journal")) return "journal";
  if (type.includes("book-chapter")) return "book-chapter";
  if (type.includes("book")) return "book";
  if (type.includes("proceedings")) return "proceedings";
  return type;
}

/**
 * Reads the raw frontmatter of `file` and wraps the scalar value of each
 * listed field in double quotes if it isn't already quoted.
 */
async function quoteFields(app: App, file: TFile, fields: string[]): Promise<void> {
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

async function fillFrontmatterFromDoi(app: App, doi: string): Promise<void> {
  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice("Bibman: no hay ninguna nota activa.");
    return;
  }

  let msg: CrossRefMessage;
  try {
    msg = await fetchDoiMetadata(doi);
  } catch (err) {
    new Notice(`Bibman: error al obtener el DOI.\n${String(err)}`);
    return;
  }

  await app.fileManager.processFrontMatter(file, (fm) => {
    fm["type"] = crossrefTypeToLocal(msg.type);

    const title = msg.title?.[0] ?? "";
    if (title) fm["title"] = title;

    if (Array.isArray(msg.author) && msg.author.length > 0) {
      fm["authors"] = msg.author.map((a) => {
        const last = a.family ?? "";
        const givenParts = (a.given ?? "").trim().split(/\s+/).filter(Boolean);
        const initials = givenParts.map((p) => `${p[0]!.toUpperCase()}.`).join(" ");
        return initials ? `${last}, ${initials}` : last;
      });
    }

    const year = msg.published?.["date-parts"]?.[0]?.[0];
    if (year != null) fm["year"] = year;

    const journal = msg["container-title"]?.[0];
    if (journal) fm["journal"] = journal;

    if (msg.volume != null) fm["volume"] = isNaN(Number(msg.volume)) ? msg.volume : Number(msg.volume);
    if (msg.issue != null) fm["number"] = isNaN(Number(msg.issue)) ? msg.issue : Number(msg.issue);
    if (msg.page != null) fm["pages"] = msg.page;
  });

  await quoteFields(app, file, ["title", "type"]);

  if (!file.path.startsWith(`${BIBLIO_FOLDER}/`)) {
    const newPath = `${BIBLIO_FOLDER}/${file.name}`;
    try {
      await app.fileManager.renameFile(file, newPath);
      new Notice(`Bibman: frontmatter actualizado y nota movida a ${BIBLIO_FOLDER}.`);
    } catch (err) {
      new Notice(`Bibman: frontmatter actualizado, pero no se pudo mover la nota.\n${String(err)}`);
    }
  } else {
    new Notice(`Bibman: frontmatter actualizado desde DOI.`);
  }
}

// ── DOI input modal ───────────────────────────────────────────────────────────

class DoiInputModal extends Modal {
  private input!: HTMLInputElement;

  constructor(app: App, private readonly plugin: BibmanPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Completar frontmatter desde DOI" });

    const desc = contentEl.createEl("p");
    desc.style.color = "var(--text-muted)";
    desc.style.fontSize = "0.9em";
    desc.textContent =
      "Introduce el DOI en cualquier formato: solo el código, con prefijo doi:, o como URL.";

    this.input = contentEl.createEl("input", { type: "text" });
    this.input.placeholder = "10.1016/j.xcrm.2025.101982";
    this.input.style.width = "100%";
    this.input.style.marginTop = "8px";
    this.input.style.marginBottom = "12px";

    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.submit();
    });

    const btn = contentEl.createEl("button", { text: "Completar" });
    btn.style.width = "100%";
    btn.addEventListener("click", () => void this.submit());

    // Focus the input after the modal is rendered
    setTimeout(() => this.input.focus(), 50);
  }

  private async submit(): Promise<void> {
    const raw = this.input.value;
    if (!raw.trim()) return;
    const doi = normalizeDoi(raw);
    this.close();
    await fillFrontmatterFromDoi(this.app, doi);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ── ISBN helpers ──────────────────────────────────────────────────────────────

/** Strips spaces and hyphens from a raw ISBN string. */
function normalizeIsbn(raw: string): string {
  return raw.trim().replace(/[\s\-]/g, "");
}

interface OpenLibrarySearchDoc {
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  publisher?: string[];
}

/**
 * Converts a full name to APA short format: "Last, F." or "Last, F. M."
 * Handles both "First Last" and "Last, First" input forms.
 */
function formatAuthorApa(name: string): string {
  const trimmed = name.trim();
  let last: string;
  let givenParts: string[];

  if (trimmed.includes(",")) {
    // Already "Last, First [Middle]"
    const commaIdx = trimmed.indexOf(",");
    last = trimmed.slice(0, commaIdx).trim();
    givenParts = trimmed.slice(commaIdx + 1).trim().split(/\s+/).filter(Boolean);
  } else {
    // "First [Middle] Last"
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0]!;
    last = parts[parts.length - 1]!;
    givenParts = parts.slice(0, -1);
  }

  const initials = givenParts.map((p) => `${p[0]!.toUpperCase()}.`).join(" ");
  return initials ? `${last}, ${initials}` : last;
}

async function fetchIsbnMetadata(isbn: string): Promise<OpenLibrarySearchDoc> {
  const encoded = encodeURIComponent(isbn);
  const resp = await requestUrl({
    url: `https://openlibrary.org/search.json?isbn=${encoded}&fields=title,author_name,first_publish_year,publisher&limit=1`,
    method: "GET",
    headers: { "User-Agent": "bibman-obsidian-plugin/1.0" },
  });
  if (resp.status !== 200) throw new Error(`Open Library returned HTTP ${resp.status}`);
  const body = resp.json as { numFound?: number; docs?: OpenLibrarySearchDoc[] };
  if (!body.docs || body.docs.length === 0)
    throw new Error("No se encontró ningún libro con ese ISBN.");
  return body.docs[0]!;
}

async function fillFrontmatterFromIsbn(app: App, isbn: string): Promise<void> {
  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice("Bibman: no hay ninguna nota activa.");
    return;
  }

  let info: OpenLibrarySearchDoc;
  try {
    info = await fetchIsbnMetadata(isbn);
  } catch (err) {
    new Notice(`Bibman: error al obtener el ISBN.\n${String(err)}`);
    return;
  }

  await app.fileManager.processFrontMatter(file, (fm) => {
    fm["type"] = "book";

    if (info.title) fm["title"] = info.title;

    if (Array.isArray(info.author_name) && info.author_name.length > 0) {
      fm["authors"] = info.author_name.filter(Boolean).map(formatAuthorApa);
    }

    if (info.first_publish_year != null) fm["year"] = info.first_publish_year;

    if (Array.isArray(info.publisher) && info.publisher.length > 0) {
      fm["publisher"] = info.publisher[0]!;
    }
  });

  await quoteFields(app, file, ["title", "type", "publisher"]);

  if (!file.path.startsWith(`${BIBLIO_FOLDER}/`)) {
    const newPath = `${BIBLIO_FOLDER}/${file.name}`;
    try {
      await app.fileManager.renameFile(file, newPath);
      new Notice(`Bibman: frontmatter actualizado y nota movida a ${BIBLIO_FOLDER}.`);
    } catch (err) {
      new Notice(`Bibman: frontmatter actualizado, pero no se pudo mover la nota.\n${String(err)}`);
    }
  } else {
    new Notice(`Bibman: frontmatter actualizado desde ISBN.`);
  }
}

// ── ISBN input modal ──────────────────────────────────────────────────────────

class IsbnInputModal extends Modal {
  private input!: HTMLInputElement;

  constructor(app: App, private readonly plugin: BibmanPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Completar frontmatter desde ISBN" });

    const desc = contentEl.createEl("p");
    desc.style.color = "var(--text-muted)";
    desc.style.fontSize = "0.9em";
    desc.textContent =
      "Introduce el ISBN-10 o ISBN-13 del libro (con o sin guiones).";

    this.input = contentEl.createEl("input", { type: "text" });
    this.input.placeholder = "978-0-06-112008-4";
    this.input.style.width = "100%";
    this.input.style.marginTop = "8px";
    this.input.style.marginBottom = "12px";

    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.submit();
    });

    const btn = contentEl.createEl("button", { text: "Completar" });
    btn.style.width = "100%";
    btn.addEventListener("click", () => void this.submit());

    setTimeout(() => this.input.focus(), 50);
  }

  private async submit(): Promise<void> {
    const raw = this.input.value;
    if (!raw.trim()) return;
    const isbn = normalizeIsbn(raw);
    this.close();
    await fillFrontmatterFromIsbn(this.app, isbn);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ── Confirm create modal ──────────────────────────────────────────────────────

class ConfirmCreateModal extends Modal {
  constructor(
    app: App,
    private readonly key: string,
    private readonly plugin: BibmanPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Crear referencia" });
    contentEl.createEl("p", {
      text: `La nota "${this.key}" no existe. ¿Deseas crearla en ${BIBLIO_FOLDER}?`,
    });

    const btnRow = contentEl.createEl("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.justifyContent = "flex-end";
    btnRow.style.marginTop = "16px";

    const cancelBtn = btnRow.createEl("button", { text: "Cancelar" });
    cancelBtn.addEventListener("click", () => this.close());

    const createBtn = btnRow.createEl("button", { text: "Crear" });
    createBtn.addClass("mod-cta");
    createBtn.addEventListener("click", () => {
      this.close();
      void this.createAndOpen();
    });
  }

  private async createAndOpen(): Promise<void> {
    const useBiblio = this.plugin.settings.moveNewNoteToBiblio;
    const path = useBiblio ? `${BIBLIO_FOLDER}/${this.key}.md` : `${this.key}.md`;
    try {
      const file = await this.plugin.app.vault.create(path, "");
      void this.plugin.app.workspace.getLeaf("window").openFile(file);
    } catch (err) {
      new Notice(`Bibman: error al crear la nota.\n${String(err)}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ── Settings tab ──────────────────────────────────────────────────────────────

class BibmanSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: BibmanPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Mover nueva nota a Bibliografía")
      .setDesc(
        "Al crear una referencia nueva desde el menú de autocompletado ({{...}}), " +
          "la nota se crea directamente en la carpeta Bibliografía. " +
          "Si se desactiva, la nota se crea en la raíz del vault.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.moveNewNoteToBiblio)
          .onChange(async (value) => {
            this.plugin.settings.moveNewNoteToBiblio = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Actualizar referencias al renombrar")
      .setDesc(
        "Cuando se renombra un archivo en la carpeta de Bibliografía, " +
          "actualiza automáticamente todas las referencias {{clave}} y {{{clave}}} " +
          "(con o sin número de página) en todas las notas del vault.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.updateRefsOnRename)
          .onChange(async (value) => {
            this.plugin.settings.updateRefsOnRename = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
