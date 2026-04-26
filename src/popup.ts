import { MarkdownRenderChild, Notice, TFile, setIcon } from "obsidian";
import type { BibmanPlugin } from "./main";
import { BIBLIO_FOLDER } from "./constants";

export class BibmanRenderChild extends MarkdownRenderChild {
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
