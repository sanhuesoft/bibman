import {
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  TFile,
  Editor,
  EditorSuggest,
  EditorPosition,
  EditorSuggestTriggerInfo,
  App,
  requestUrl,
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

// ── Main plugin ───────────────────────────────────────────────────────────────

export default class BibmanPlugin extends Plugin {
  private bibSuggest: EditorSuggest<TFile> | null = null;
  /** Debounce handles for the document-wide numbering sweep, keyed by sourcePath. */
  private readonly sweepTimers = new Map<string, number>();
  /** basename → last-used timestamp (ms). Persisted in plugin data. */
  recentlyUsed: Map<string, number> = new Map();

  async onload(): Promise<void> {
    const saved = await this.loadData() as { recentlyUsed?: Record<string, number> } | null;
    if (saved?.recentlyUsed) {
      this.recentlyUsed = new Map(Object.entries(saved.recentlyUsed));
    }
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

    this.bibSuggest = new (class extends EditorSuggest<TFile> {
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
            | { values: TFile[]; selectedItem: number }
            | undefined;
          if (!chooser) return;
          const file = chooser.values?.[chooser.selectedItem];
          if (!file) return;
          e.preventDefault();
          e.stopPropagation();
          this._insert(file, /* tabMode */ true);
          this.close();
        };
        document.addEventListener("keydown", this._keydownHandler, true);
      }

      /** Shared insert logic. tabMode=true → cursor before }}, false → after }} */
      private _insert(file: TFile, tabMode: boolean): void {
        const ctx = this.context as unknown as { start: { line: number; ch: number }; end: { line: number; ch: number }; editor: Editor } | null;
        if (!ctx) return;
        const editor = ctx.editor;

        const prefix = editor.getRange(ctx.start, ctx.end);
        const isTriple = prefix.startsWith("{{{");
        const insertText = isTriple ? `{{{${file.basename}}}}` : `{{${file.basename}}}`;
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
        this.plugin.recordUsage(file.basename);
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

      getSuggestions(context: { query?: string }) {
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

        if (q.length === 0) {
          return files.slice().sort(sortByRecency).slice(0, 100);
        }

        const results = files.filter((f) =>
          f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
        );

        return results.sort(sortByRecency).slice(0, 100);
      }

      renderSuggestion(file: TFile, el: HTMLElement) {
        el.empty();
        el.addClass("bibman-suggest");

        const name = el.createEl("div", { text: file.basename });
        name.addClass("bibman-suggest-name");
      }

      selectSuggestion(file: TFile, _evt: KeyboardEvent | MouseEvent): void {
        // Enter / click → cursor after }}
        // Tab is handled by the keydown interceptor above; this path is never Tab.
        this._insert(file, /* tabMode */ false);
      }
    })(this.app, this);
    this.registerEditorSuggest(this.bibSuggest!);

    this.addCommand({
      id: "fill-frontmatter-from-doi",
      name: "Fill frontmatter from DOI",
      callback: () => new DoiInputModal(this.app, this).open(),
    });
  }

  onunload(): void {
    for (const timer of this.sweepTimers.values()) clearTimeout(timer);
    this.sweepTimers.clear();    // Clean up the keydown listener from the suggest
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
    void this.saveData({ recentlyUsed: Object.fromEntries(this.recentlyUsed) });
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
            sup.textContent = "[REF]";
            frags.push(sup);
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
          cite.textContent = "[Referencia]";
        } else {
          cite.textContent = "[REF]";
        }
      }
    }
  }
}

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
        const parts: string[] = [];
        if (a.family) parts.push(a.family);
        if (a.given) parts.push(a.given);
        return parts.join(", ");
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

  new Notice(`Bibman: frontmatter actualizado desde DOI.`);
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
