import { App, PluginSettingTab, Setting } from "obsidian";
import type { BibmanPlugin } from "./main";

export class BibmanSettingTab extends PluginSettingTab {
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
      .setName("Mover nueva nota a bibliografía")
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
