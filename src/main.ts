import {
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  MarkdownView,
  Plugin,
  TFile,
  Editor,
  EditorSuggest,
  EditorPosition,
  EditorSuggestTriggerInfo,
  App,
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
 * Matches {{key}} or {{key:pages}}.
 * Group 1 → key, Group 2 → pages (optional).
 */
const CITATION_SOURCE = String.raw`\{\{([^}:]+?)(?::([^}]+?))?\}\}`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface BibEntry {
  author?: string;
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
      if (entry.author) {
        const p = popup.appendChild(document.createElement("p"));
        p.className = "bibman-popup__author";
        p.textContent = entry.author;
      }
      if (entry.year != null) {
        const p = popup.appendChild(document.createElement("p"));
        p.className = "bibman-popup__year";
        p.textContent = String(entry.year);
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
  const mark = Decoration.mark({ class: "bibman-inline-cite" });
  const re = new RegExp(CITATION_SOURCE, "g");

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const start = from + match.index;
      builder.add(start, start + match[0].length, mark);
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

  async onload(): Promise<void> {
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

      constructor(app: App, plugin: BibmanPlugin) {
        super(app);
        this.plugin = plugin;
      }

      // suggest methods

      onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line).slice(0, cursor.ch);
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

        const files = this.app.vault.getFiles().filter(
          (f) => f.path.startsWith(`${BIBLIO_FOLDER}/`) && f.extension === "md",
        );

        if (q.length === 0) {
          const sorted = files.slice().sort((a, b) => a.basename.localeCompare(b.basename));
          return sorted.slice(0, 100);
        }

        const results = files.filter((f) =>
          f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
        );

        return results.slice(0, 100);
      }

      renderSuggestion(file: TFile, el: HTMLElement) {
        el.empty();
        el.addClass("bibman-suggest");

        const name = el.createEl("div", { text: file.basename });
        name.addClass("bibman-suggest-name");
      }

      selectSuggestion(file: TFile): void {
        const ctx = this.context as unknown as { start: { line: number; ch: number }; end: { line: number; ch: number }; editor: Editor } | null;
        if (!ctx) return;
        const editor = ctx.editor;

        const look = editor.getRange(ctx.end, { line: ctx.end.line, ch: ctx.end.ch + 2 });
        let extra = 0;
        if (look.startsWith("}}")) extra = 2;
        else if (look.startsWith("}")) extra = 1;

        const replaceEnd = extra ? { line: ctx.end.line, ch: ctx.end.ch + extra } : ctx.end;

        const insertText = `{{${file.basename}}}`;
        editor.replaceRange(insertText, ctx.start, replaceEnd);
        try {
          editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + insertText.length });
        } catch (_e) {
          try {
            // @ts-ignore
            editor.setCursor(ctx.start.line, ctx.start.ch + insertText.length);
          } catch (err) {
            console.debug("setCursor fallback failed", err);
          }
        }
      }
    })(this.app, this);
    this.registerEditorSuggest(this.bibSuggest!);
  }

  onunload(): void {
    for (const timer of this.sweepTimers.values()) clearTimeout(timer);
    this.sweepTimers.clear();
    // unregister suggest if present
    this.bibSuggest = null;
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

    const re = new RegExp(CITATION_SOURCE, "g");
    const pending: Array<{ node: Text; frags: Array<string | HTMLElement> }> =
      [];

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

          const sup = document.createElement("sup");
          sup.className = "bibman-cite";
          sup.dataset.bibkey = match[1];
          if (match[2]) sup.dataset.bibpages = match[2];
          sup.textContent = "[?]";
          frags.push(sup);

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
        const pages = cite.dataset.bibpages;
        // Non-breaking space before page numbers for typographic consistency
        cite.textContent = pages ? `[${n},\u00a0p.\u00a0${pages}]` : `[${n}]`;
      }
    }
  }
}
