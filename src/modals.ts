import { App, Modal, Notice } from "obsidian";
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
