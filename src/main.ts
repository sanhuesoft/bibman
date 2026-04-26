import {
  MarkdownPostProcessorContext,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  Editor,
} from "obsidian";

import { BIBLIO_FOLDER } from "./constants";
import { BibmanSettings, DEFAULT_SETTINGS, BibEntry } from "./types";
import { citationEditorPlugin } from "./editor-extension";
import { BibmanRenderChild } from "./popup";
import { BibCiteSuggest } from "./suggest";
import { DoiInputModal } from "./doi";
import { IsbnInputModal, IsbnChapterInputModal } from "./isbn";
import { WebInputModal } from "./web";
import { ConfirmCreateModal } from "./modals";
import { BibmanSettingTab } from "./settings";
import { runUpdateReferences } from "./references";

export class BibmanPlugin extends Plugin {
  private bibSuggest: BibCiteSuggest | null = null;
  private readonly sweepTimers = new Map<string, number>();
  recentlyUsed: Map<string, number> = new Map();
  settings: BibmanSettings = { ...DEFAULT_SETTINGS };
  placeholderKeys: Set<string> = new Set();
  private _placeholderRebuildTimer: number | undefined;

  async onload(): Promise<void> {
    const saved = await this.loadData() as {
      recentlyUsed?: Record<string, number>;
      updateRefsOnRename?: boolean;
      moveNewNoteToBiblio?: boolean;
    } | null;
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

    this.bibSuggest = new BibCiteSuggest(this.app, this);
    this.registerEditorSuggest(this.bibSuggest);

    void this.rebuildPlaceholderIndex();
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md")
          this.schedulePlaceholderRebuild();
      }),
    );
    this.registerEvent(this.app.vault.on("create", () => this.schedulePlaceholderRebuild()));
    this.registerEvent(this.app.vault.on("delete", () => this.schedulePlaceholderRebuild()));
    this.registerEvent(this.app.vault.on("rename", () => this.schedulePlaceholderRebuild()));

    // ── Commands ──────────────────────────────────────────────────────────────

    this.addCommand({
      id: "fill-frontmatter-from-doi",
      name: "Fill frontmatter from doi",
      callback: () => new DoiInputModal(this.app, this).open(),
    });

    this.addCommand({
      id: "fill-frontmatter-from-isbn",
      name: "Fill frontmatter from isbn",
      callback: () => new IsbnInputModal(this.app, this).open(),
    });

    this.addCommand({
      id: "fill-incollection-from-isbn",
      name: "Fill frontmatter for chapter (isbn)",
      callback: () => new IsbnChapterInputModal(this.app, this).open(),
    });

    this.addCommand({
      id: "fill-frontmatter-from-web",
      name: "Fill frontmatter from web",
      callback: () => new WebInputModal(this.app, this).open(),
    });

    this.addCommand({
      id: "open-or-create-reference-at-cursor",
      name: "Abrir o crear referencia en cursor",
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

    // ── Frontmatter templates ─────────────────────────────────────────────────

    const insertFrontmatterTemplate = (
      editor: Editor,
      view: MarkdownView,
      fields: Record<string, string>,
    ): void => {
      const keys = Object.keys(fields);
      const lines = ["---", ...keys.map((k) => `${k}: ${fields[k]}`), "---", ""];
      const yaml = lines.join("\n");
      const firstLine = editor.getLine(0);
      if (firstLine === "---") {
        new Notice("Bibman: el archivo ya tiene un bloque frontmatter.");
        return;
      }
      editor.replaceRange(yaml, { line: 0, ch: 0 }, { line: 0, ch: 0 });
      const titleIdx = keys.indexOf("title");
      if (titleIdx !== -1) {
        editor.setCursor({ line: 1 + titleIdx, ch: "title: ".length });
      }
      if (view.file) {
        const f = view.file;
        if (!f.path.startsWith(`${BIBLIO_FOLDER}/`)) {
          void this.app.fileManager.renameFile(f, `${BIBLIO_FOLDER}/${f.name}`);
        }
      }
    };

    this.addCommand({
      id: "insert-template-web",
      name: 'Insert template for "web"',
      editorCallback: (editor, view) =>
        insertFrontmatterTemplate(editor, view as MarkdownView, {
          type: "web",
          title: "",
          author: "",
          year: "",
          url: "",
        }),
    });

    this.addCommand({
      id: "insert-template-book",
      name: 'Insert template for "book"',
      editorCallback: (editor, view) =>
        insertFrontmatterTemplate(editor, view as MarkdownView, {
          type: "book",
          title: "",
          author: "",
          year: "",
          publisher: "",
          edition: "",
        }),
    });

    this.addCommand({
      id: "insert-template-incollection",
      name: 'Insert template for "incollection"',
      editorCallback: (editor, view) =>
        insertFrontmatterTemplate(editor, view as MarkdownView, {
          type: "incollection",
          title: "",
          author: "",
          booktitle: "",
          editor: "",
          publisher: "",
          year: "",
          pages: "",
        }),
    });

    this.addCommand({
      id: "insert-template-journal",
      name: 'Insert template for "journal"',
      editorCallback: (editor, view) =>
        insertFrontmatterTemplate(editor, view as MarkdownView, {
          type: "journal",
          title: "",
          author: "",
          year: "",
          journal: "",
          volume: "",
          number: "",
          pages: "",
          doi: "",
          url: "",
        }),
    });
  }

  onunload(): void {
    for (const timer of this.sweepTimers.values()) clearTimeout(timer);
    this.sweepTimers.clear();
    if (this._placeholderRebuildTimer !== undefined) {
      window.clearTimeout(this._placeholderRebuildTimer);
      this._placeholderRebuildTimer = undefined;
    }
    this.bibSuggest?.destroy();
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

  async moveFileToBiblio(file: TFile): Promise<void> {
    if (!this.settings.moveNewNoteToBiblio) return;
    const targetFolder = BIBLIO_FOLDER;
    if (file.parent?.path === targetFolder) return;
    const targetPath = `${targetFolder}/${file.name}`;
    const existing = this.app.vault.getAbstractFileByPath(targetPath);
    if (existing) {
      new Notice(`Bibman: ya existe "${file.name}" en ${targetFolder}.`);
      return;
    }
    await this.app.vault.rename(file, targetPath);
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

  async getBibEntry(key: string): Promise<BibEntry | null> {
    const path = `${BIBLIO_FOLDER}/${key}.md`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;

    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm || typeof fm !== "object") return null;
    const fmr = fm as Record<string, unknown>;

    return {
      author: typeof fmr["author"] === "string" ? (fmr["author"]) : undefined,
      authors: Array.isArray(fmr["authors"])
        ? (fmr["authors"] as unknown[]).filter((a) => typeof a === "string")
        : Array.isArray(fmr["author"])
        ? (fmr["author"] as unknown[]).filter((a) => typeof a === "string")
        : undefined,
      title: typeof fmr["title"] === "string" ? (fmr["title"]) : undefined,
      year:
        typeof fmr["year"] === "string" || typeof fmr["year"] === "number"
          ? (fmr["year"])
          : undefined,
    };
  }

  private async propagateRename(oldKey: string, newKey: string): Promise<void> {
    const escaped = oldKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reTriple = new RegExp(`\\{\\{\\{${escaped}((?::[^}]+?)?)\\}\\}\\}`, "g");
    const reDouble = new RegExp(
      `(?<!\\{)\\{\\{(?!\\{)${escaped}((?::[^}]+?)?)\\}\\}(?!\\})`,
      "g",
    );

    const markdownFiles = this.app.vault.getMarkdownFiles();
    let count = 0;

    for (const file of markdownFiles) {
      const content = await this.app.vault.read(file);
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

  private postProcessor(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    if (!this.replaceCitations(el)) return;
    ctx.addChild(new BibmanRenderChild(el, this));
    this.scheduleNumberingSweep(ctx.sourcePath);
  }

  private replaceCitations(root: HTMLElement): boolean {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node): number {
        if (node.parentElement?.closest("code, pre")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const re = new RegExp(
      String.raw`\{\{\{([^}:]+?)(?::([^}]+?))?\}\}\}|\{\{([^}:]+?)(?::([^}]+?))?\}\}`,
      "g",
    );
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
            span.textContent = "[referencia]";
            frags.push(span);
          } else {
            const sup = document.createElement("sup");
            sup.className = "bibman-cite";
            sup.dataset.bibkey = key;
            if (pages) sup.dataset.bibpages = pages;
            sup.dataset.bibvariant = "double";
            sup.textContent = "[r]";
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
              wrapper.setCssProps({ "white-space": "nowrap" });
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

      const cites = Array.from(view.containerEl.querySelectorAll<HTMLElement>(".bibman-cite"));
      for (const cite of cites) {
        if (cite.dataset.bibvariant === "triple") {
          cite.textContent = "Referencia";
        } else {
          cite.textContent = "[R]";
        }
      }
    }
  }
}

export default BibmanPlugin;
