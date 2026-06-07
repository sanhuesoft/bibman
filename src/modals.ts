import { App, Editor, Modal, Notice, TFile } from "obsidian";
import type { BibmanPlugin } from "./main";
import { BIBLIO_FOLDER } from "./constants";

export class ConfirmCreateModal extends Modal {
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
    btnRow.setCssProps({ display: "flex", gap: "8px", "justify-content": "flex-end", "margin-top": "16px" });

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

// ─── Insert Citation Modal ────────────────────────────────────────────────────

export class InsertCitationModal extends Modal {
  private sourceInput!: HTMLInputElement;
  private pagesInput!: HTMLInputElement;
  private globalToggle!: HTMLInputElement;
  private dropdown!: HTMLElement;
  private allFiles: TFile[] = [];
  private selectedBasename = "";

  constructor(
    app: App,
    private readonly editor: Editor,
    private readonly recentlyUsed: Map<string, number>,
    private readonly bibFolder: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("bibman-insert-modal");

    contentEl.createEl("h2", { text: "Insertar referencia" });

    // ── Source field ─────────────────────────────────────────────────────────
    const sourceLabel = contentEl.createEl("label");
    sourceLabel.addClass("bibman-modal-label");
    sourceLabel.setText("Fuente");
    const sourceWrap = contentEl.createEl("div");
    sourceWrap.addClass("bibman-modal-source-wrap");

    this.sourceInput = sourceWrap.createEl("input", { type: "text" });
    this.sourceInput.addClass("bibman-modal-input");
    this.sourceInput.placeholder = "Buscar en bibliografía…";
    this.sourceInput.setAttribute("autocomplete", "off");

    this.dropdown = sourceWrap.createEl("div");
    this.dropdown.addClass("bibman-modal-dropdown");
    this.dropdown.setCssProps({ display: "none" });

    // Load files
    const folderPrefix = `${this.bibFolder}/`;
    this.allFiles = this.app.vault
      .getFiles()
      .filter((f) => f.path.normalize().startsWith(folderPrefix.normalize()) && f.extension === "md")
      .sort((a, b) => {
        const ta = this.recentlyUsed.get(a.basename) ?? 0;
        const tb = this.recentlyUsed.get(b.basename) ?? 0;
        if (tb !== ta) return tb - ta;
        return a.basename.localeCompare(b.basename);
      });

    this.sourceInput.addEventListener("input", () => this._renderDropdown());
    this.sourceInput.addEventListener("keydown", (e) => this._handleSourceKeydown(e));

    // Close dropdown when clicking outside
    document.addEventListener("mousedown", (e) => {
      if (!sourceWrap.contains(e.target as Node)) {
        this.dropdown.setCssProps({ display: "none" });
      }
    }, { capture: true });

    // ── Pages field ──────────────────────────────────────────────────────────
    const pagesLabel = contentEl.createEl("label");
    pagesLabel.addClass("bibman-modal-label");
    pagesLabel.setCssProps({ "margin-top": "12px", display: "block" });
    pagesLabel.setText("Páginas (opcional)");

    this.pagesInput = contentEl.createEl("input", { type: "text" });
    this.pagesInput.addClass("bibman-modal-input");
    this.pagesInput.placeholder = "Ej. 45 o 45-48";

    // ── Global toggle ─────────────────────────────────────────────────────────
    const toggleRow = contentEl.createEl("div");
    toggleRow.addClass("bibman-modal-toggle-row");

    this.globalToggle = toggleRow.createEl("input", { type: "checkbox" });
    this.globalToggle.id = "bibman-global-toggle";
    this.globalToggle.addClass("bibman-modal-toggle");

    const toggleLabel = toggleRow.createEl("label");
    toggleLabel.htmlFor = "bibman-global-toggle";
    toggleLabel.setText("Referencia global (triple llave)");

    // ── Action buttons ────────────────────────────────────────────────────────
    const btnRow = contentEl.createEl("div");
    btnRow.addClass("bibman-modal-btn-row");

    const cancelBtn = btnRow.createEl("button", { text: "Cancelar" });
    cancelBtn.addEventListener("click", () => this.close());

    const insertBtn = btnRow.createEl("button", { text: "Insertar" });
    insertBtn.addClass("mod-cta");
    insertBtn.addEventListener("click", () => this._insert());

    // Submit on Enter in any field
    [this.pagesInput].forEach((inp) =>
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this._insert(); }
      }),
    );

    setTimeout(() => this.sourceInput.focus(), 30);
  }

  private _renderDropdown(): void {
    const q = this.sourceInput.value.toLowerCase().trim();

    // Only show suggestions once the user has typed something
    if (q.length === 0) {
      this.dropdown.setCssProps({ display: "none" });
      this.dropdown.empty();
      return;
    }

    const matches = this.allFiles
      .filter(
        (f) => f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
      )
      .slice(0, 50);

    this.dropdown.empty();

    if (matches.length === 0) {
      this.dropdown.setCssProps({ display: "none" });
      return;
    }

    this.dropdown.setCssProps({ display: "block" });
    matches.forEach((f) => {
      const item = this.dropdown.createEl("div");
      item.addClass("bibman-modal-dropdown-item");
      item.dataset.basename = f.basename;

      // Basename
      const nameSpan = item.createEl("span");
      nameSpan.addClass("bibman-modal-dropdown-name");
      nameSpan.setText(f.basename);

      // Optional title from frontmatter
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      const title = typeof fm?.["title"] === "string" ? fm["title"] : null;
      if (title) {
        const titleSpan = item.createEl("span");
        titleSpan.addClass("bibman-modal-dropdown-title");
        titleSpan.setText(" \u00b7 " + title);
      }

      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this._selectSource(f.basename);
      });
    });
  }

  private _handleSourceKeydown(e: KeyboardEvent): void {
    const items = Array.from(this.dropdown.querySelectorAll<HTMLElement>(".bibman-modal-dropdown-item"));
    const active = this.dropdown.querySelector<HTMLElement>(".bibman-modal-dropdown-item--active");
    const idx = active ? items.indexOf(active) : -1;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = items[idx + 1] ?? items[0];
      active?.removeClass("bibman-modal-dropdown-item--active");
      next?.addClass("bibman-modal-dropdown-item--active");
      next?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = items[idx - 1] ?? items[items.length - 1];
      active?.removeClass("bibman-modal-dropdown-item--active");
      prev?.addClass("bibman-modal-dropdown-item--active");
      prev?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active) {
        this._selectSource(active.dataset.basename ?? active.getText());
        this.pagesInput.focus();
      } else {
        // If there's exactly one match, auto-select it
        const items2 = Array.from(this.dropdown.querySelectorAll<HTMLElement>(".bibman-modal-dropdown-item"));
        if (items2.length === 1) {
          this._selectSource(items2[0]!.dataset.basename ?? items2[0]!.getText());
          this.pagesInput.focus();
        } else {
          this._insert();
        }
      }
    } else if (e.key === "Escape") {
      this.dropdown.setCssProps({ display: "none" });
    }
  }

  private _selectSource(basename: string): void {
    this.selectedBasename = basename;
    this.sourceInput.value = basename;
    this.dropdown.setCssProps({ display: "none" });
  }

  private _buildCitation(key: string, pages: string, global: boolean): string {
    const trimmed = pages.trim();
    let inner: string;
    if (trimmed === "") {
      inner = key;
    } else {
      inner = `${key}:${trimmed}`;
    }
    return global ? `{{{${inner}}}}` : `{{${inner}}}`;
  }

  private _insert(): void {
    const key = this.selectedBasename || this.sourceInput.value.trim();
    if (!key) {
      new Notice("Bibman: selecciona una fuente.");
      return;
    }
    const pages = this.pagesInput.value.trim();
    const isGlobal = this.globalToggle.checked;
    const citation = this._buildCitation(key, pages, isGlobal);

    this.editor.replaceSelection(citation);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
