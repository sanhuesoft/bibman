import { App, FuzzySuggestModal, Modal, Notice, requestUrl } from "obsidian";
import type { BibmanPlugin } from "./main";
import { BIBLIO_FOLDER } from "./constants";
import type { CrossRefChapter, OpenLibrarySearchDoc } from "./types";
import { quoteFields, formatAuthorApa, normalizeIsbn } from "./helpers";

export { normalizeIsbn };

// ── Open Library: full book by ISBN ──────────────────────────────────────────

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

  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
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
    new Notice(`Bibman: frontmatter actualizado desde isbn.`);
  }
}

// ── CrossRef: chapters by ISBN ────────────────────────────────────────────────

export async function fetchChaptersByIsbn(isbn: string): Promise<CrossRefChapter[]> {
  const encoded = encodeURIComponent(isbn);
  const resp = await requestUrl({
    url: `https://api.crossref.org/works?filter=isbn:${encoded},type:book-chapter&rows=100`,
    method: "GET",
    headers: { "User-Agent": "bibman-obsidian-plugin/1.0" },
  });
  if (resp.status !== 200) throw new Error(`CrossRef devolvió HTTP ${resp.status}`);
  const items = (resp.json as { message?: { items?: unknown[] } }).message?.items;
  if (!items || items.length === 0)
    throw new Error("CrossRef no encontró capítulos para este ISBN.");
  return items.map((raw: unknown) => {
    const item = raw as Record<string, unknown>;
    const titleArr = item["title"] as string[] | undefined;
    const containerArr = item["container-title"] as string[] | undefined;
    const authorArr = item["author"] as Array<{ family?: string; given?: string }> | undefined;
    const published = item["published"] as { "date-parts"?: number[][] } | undefined;
    return {
      title: titleArr?.[0] ?? "Sin título",
      bookTitle: containerArr?.[0] ?? "",
      authors: (authorArr ?? []).map((a) => {
        const last = a.family ?? "";
        const initials = (a.given ?? "")
          .split(" ")
          .filter(Boolean)
          .map((n) => `${n[0]!.toUpperCase()}.`)
          .join(" ");
        return initials ? `${last}, ${initials}` : last;
      }),
      year: published?.["date-parts"]?.[0]?.[0],
      pages: item["page"] as string | undefined,
      doi: item["DOI"] as string | undefined,
    };
  });
}

export async function fillFrontmatterFromChapter(
  app: App,
  chapter: CrossRefChapter,
): Promise<void> {
  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice("Bibman: no hay ninguna nota activa.");
    return;
  }

  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    fm["type"] = "incollection";
    fm["title"] = chapter.title;
    if (chapter.bookTitle) fm["booktitle"] = chapter.bookTitle;
    if (chapter.authors.length > 0) fm["authors"] = chapter.authors;
    if (chapter.year != null) fm["year"] = chapter.year;
    if (chapter.pages) fm["pages"] = chapter.pages;
    if (chapter.doi) fm["doi"] = chapter.doi;
  });

  await quoteFields(app, file, ["title", "type", "booktitle"]);

  if (!file.path.startsWith(`${BIBLIO_FOLDER}/`)) {
    const newPath = `${BIBLIO_FOLDER}/${file.name}`;
    try {
      await app.fileManager.renameFile(file, newPath);
      new Notice(`Bibman: frontmatter actualizado y nota movida a ${BIBLIO_FOLDER}.`);
    } catch (err) {
      new Notice(`Bibman: frontmatter actualizado, pero no se pudo mover la nota.\n${String(err)}`);
    }
  } else {
    new Notice("Bibman: frontmatter de capítulo actualizado.");
  }
}

// ── Modals ────────────────────────────────────────────────────────────────────

export class IsbnInputModal extends Modal {
  private input!: HTMLInputElement;

  constructor(app: App, private readonly plugin: BibmanPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Completar frontmatter desde isbn" });

    const desc = contentEl.createEl("p");
    desc.setCssProps({ color: "var(--text-muted)", "font-size": "0.9em" });
    desc.textContent = "Introduce el isbn-10 o isbn-13 del libro (con o sin guiones).";

    this.input = contentEl.createEl("input", { type: "text" });
    this.input.placeholder = "978-0-06-112008-4";
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
    const isbn = normalizeIsbn(raw);
    this.close();
    await fillFrontmatterFromIsbn(this.app, isbn);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class IsbnChapterInputModal extends Modal {
  private input!: HTMLInputElement;

  constructor(app: App, private readonly plugin: BibmanPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Completar frontmatter para capítulo (isbn)" });

    const desc = contentEl.createEl("p");
    desc.setCssProps({ color: "var(--text-muted)", "font-size": "0.9em" });
    desc.textContent =
      "Introduce el isbn del libro. Se buscará en crossref la lista de capítulos.";

    this.input = contentEl.createEl("input", { type: "text" });
    this.input.placeholder = "978-0-06-112008-4";
    this.input.setCssProps({ width: "100%", "margin-top": "8px", "margin-bottom": "12px" });

    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.submit();
    });

    const btn = contentEl.createEl("button", { text: "Buscar capítulos" });
    btn.setCssProps({ width: "100%" });
    btn.addEventListener("click", () => void this.submit());

    setTimeout(() => this.input.focus(), 50);
  }

  private async submit(): Promise<void> {
    const raw = this.input.value;
    if (!raw.trim()) return;
    const isbn = normalizeIsbn(raw);
    this.close();

    new Notice("Bibman: buscando capítulos en crossref…");
    let chapters: CrossRefChapter[];
    try {
      chapters = await fetchChaptersByIsbn(isbn);
    } catch (err) {
      new Notice(`Bibman: ${String(err)}\nUsando entrada manual como alternativa.`);
      new ManualChapterModal(this.app, this.plugin).open();
      return;
    }
    new ChapterSuggestModal(this.app, chapters, (chapter) =>
      void fillFrontmatterFromChapter(this.app, chapter),
    ).open();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ChapterSuggestModal extends FuzzySuggestModal<CrossRefChapter> {
  constructor(
    app: App,
    private readonly chapters: CrossRefChapter[],
    private readonly onSelect: (chapter: CrossRefChapter) => void,
  ) {
    super(app);
    this.setPlaceholder("Escribe para filtrar capítulos…");
  }

  getItems(): CrossRefChapter[] {
    return this.chapters;
  }

  getItemText(item: CrossRefChapter): string {
    return item.title;
  }

  onChooseItem(item: CrossRefChapter, _evt: MouseEvent | KeyboardEvent): void {
    this.onSelect(item);
  }

  renderSuggestion(match: { item: CrossRefChapter }, el: HTMLElement): void {
    el.createEl("div", { text: match.item.title });
    const meta = [
      match.item.pages ? `p. ${match.item.pages}` : null,
      match.item.authors.length > 0 ? match.item.authors[0] : null,
      match.item.year != null ? String(match.item.year) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (meta) el.createEl("small", { text: meta, cls: "bibman-suggest-meta" });
  }
}

export class ManualChapterModal extends Modal {
  constructor(app: App, private readonly plugin: BibmanPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Entrada manual de capítulo" });

    const desc = contentEl.createEl("p");
    desc.setCssProps({ color: "var(--text-muted)", "font-size": "0.9em" });
    desc.textContent =
      "Crossref no encontró capítulos automáticamente. Completa los campos manualmente.";

    const fields: Record<string, HTMLInputElement> = {};
    const rows: Array<[string, string, string]> = [
      ["title", "Título del capítulo *", "El capítulo de…"],
      ["bookTitle", "Título del libro *", "Libro que contiene el capítulo"],
      ["authors", "Autores (uno por línea)", "Apellido, N."],
      ["year", "Año", "2024"],
      ["pages", "Páginas", "45-78"],
      ["doi", "DOI", "10.1234/example"],
    ];

    for (const [key, label, placeholder] of rows) {
      contentEl.createEl("label", { text: label, cls: "bibman-modal-label" });
      const input = contentEl.createEl("input", { type: "text" });
      input.placeholder = placeholder;
      input.setCssProps({ width: "100%", "margin-bottom": "8px" });
      fields[key] = input;
    }

    const btn = contentEl.createEl("button", { text: "Guardar" });
    btn.addClass("mod-cta");
    btn.setCssProps({ width: "100%", "margin-top": "8px" });
    btn.addEventListener("click", () => void this.save(fields));

    setTimeout(() => fields["title"]?.focus(), 50);
  }

  private async save(fields: Record<string, HTMLInputElement>): Promise<void> {
    const title = fields["title"]?.value.trim() ?? "";
    const bookTitle = fields["bookTitle"]?.value.trim() ?? "";
    if (!title || !bookTitle) {
      new Notice("Bibman: el título del capítulo y del libro son obligatorios.");
      return;
    }
    const authorsRaw = fields["authors"]?.value.trim() ?? "";
    const chapter: CrossRefChapter = {
      title,
      bookTitle,
      authors: authorsRaw ? authorsRaw.split("\n").map((s) => s.trim()).filter(Boolean) : [],
      year: fields["year"]?.value.trim() ? parseInt(fields["year"].value.trim(), 10) : undefined,
      pages: fields["pages"]?.value.trim() || undefined,
      doi: fields["doi"]?.value.trim() || undefined,
    };
    this.close();
    await fillFrontmatterFromChapter(this.app, chapter);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
