import { App, Modal, Notice, requestUrl } from "obsidian";
import type { BibmanPlugin } from "./main";
import { BIBLIO_FOLDER } from "./constants";
import type { WebMetadata } from "./types";
import { quoteFields } from "./helpers";

async function fetchWebMetadata(urlStr: string): Promise<WebMetadata> {
  const resp = await requestUrl({
    url: urlStr,
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "es-ES,es;q=0.9",
    },
  });

  if (resp.status !== 200) {
    if (resp.status === 429)
      throw new Error("YouTube/Web está limitando las peticiones. Intenta más tarde.");
    throw new Error(`El servidor devolvió HTTP ${resp.status}`);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(resp.text, "text/html");

  // YouTube y otros sitios usan Open Graph (og:title) o Twitter Cards
  const title =
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
    doc.querySelector('meta[name="twitter:title"]')?.getAttribute("content") ||
    doc.title ||
    undefined;

  // En YouTube, el autor suele estar en og:video:tag o meta[name="author"]
  const author =
    doc.querySelector('meta[name="author"]')?.getAttribute("content") ||
    doc.querySelector('link[itemprop="name"]')?.getAttribute("content") ||
    doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content") ||
    undefined;

  let year: number | undefined;
  // Intentamos extraer la fecha de publicación de etiquetas comunes
  const dateStr =
    doc.querySelector('meta[property="article:published_time"]')?.getAttribute("content") ||
    doc.querySelector('itemprop[itemprop="datePublished"]')?.getAttribute("content") ||
    doc.querySelector('meta[name="date"]')?.getAttribute("content");

  if (dateStr) {
    const match = dateStr.match(/\d{4}/);
    if (match) year = parseInt(match[0], 10);
  } else if (urlStr.includes("youtube.com")) {
    year = new Date().getFullYear();
  }

  return { title, author, year, url: urlStr };
}

async function fillFrontmatterFromWeb(app: App, url: string): Promise<void> {
  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice("Bibman: no hay ninguna nota activa.");
    return;
  }

  let info: WebMetadata;
  try {
    info = await fetchWebMetadata(url);
  } catch (err) {
    new Notice(`Bibman: error al obtener la página web.\n${String(err)}`);
    return;
  }

  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    fm["type"] = "web";
    fm["url"] = info.url;
    if (info.title) fm["title"] = info.title;
    if (info.author) fm["author"] = info.author;
    if (info.year != null) fm["year"] = info.year;
  });

  await quoteFields(app, file, ["title", "type", "author"]);

  if (!file.path.startsWith(`${BIBLIO_FOLDER}/`)) {
    const newPath = `${BIBLIO_FOLDER}/${file.name}`;
    try {
      await app.fileManager.renameFile(file, newPath);
      new Notice(`Bibman: frontmatter actualizado y nota movida a ${BIBLIO_FOLDER}.`);
    } catch (err) {
      new Notice(`Bibman: frontmatter actualizado, pero no se pudo mover la nota.\n${String(err)}`);
    }
  } else {
    new Notice(`Bibman: frontmatter actualizado desde la web.`);
  }
}

export class WebInputModal extends Modal {
  private input!: HTMLInputElement;

  constructor(app: App, private readonly plugin: BibmanPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Completar frontmatter desde URL" });

    const desc = contentEl.createEl("p");
    desc.setCssProps({ color: "var(--text-muted)", "font-size": "0.9em" });
    desc.textContent = "Introduce la URL de la página web.";

    this.input = contentEl.createEl("input", { type: "url" });
    this.input.placeholder = "https://ejemplo.com/articulo";
    this.input.setCssProps({ width: "100%", "margin-top": "8px", "margin-bottom": "12px" });

    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.submit();
    });

    const btn = contentEl.createEl("button", { text: "Completar" });
    btn.setCssProps({ width: "100%" });
    btn.addEventListener("click", () => void this.submit());

    setTimeout(() => this.input.focus(), 50);
  }

  private async submit(): Promise<void> {
    const raw = this.input.value;
    if (!raw.trim()) return;
    this.close();
    await fillFrontmatterFromWeb(this.app, raw.trim());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
