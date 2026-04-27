import { App, Modal, Notice, requestUrl } from "obsidian";
import type { BibmanPlugin } from "./main";
import type { CrossRefMessage } from "./types";
import { quoteFields, normalizeDoi, moveAndRenameFileByCiteKey } from "./helpers";

export { normalizeDoi };

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

  let capturedAuthors: string[] = [];
  let capturedYear: number | undefined;

  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    fm["type"] = crossrefTypeToLocal(msg.type);

    const title = msg.title?.[0] ?? "";
    if (title) fm["title"] = title;

    if (Array.isArray(msg.author) && msg.author.length > 0) {
      const formatted = msg.author.map((a) => {
        const last = a.family ?? "";
        const givenParts = (a.given ?? "").trim().split(/\s+/).filter(Boolean);
        const initials = givenParts.map((p) => `${p[0]!.toUpperCase()}.`).join(" ");
        return initials ? `${last}, ${initials}` : last;
      });
      fm["authors"] = formatted;
      capturedAuthors = formatted;
    }

    const year = msg.published?.["date-parts"]?.[0]?.[0];
    if (year != null) {
      fm["year"] = year;
      capturedYear = year;
    }

    const journal = msg["container-title"]?.[0];
    if (journal) fm["journal"] = journal;

    if (msg.volume != null) fm["volume"] = isNaN(Number(msg.volume)) ? msg.volume : Number(msg.volume);
    if (msg.issue != null) fm["number"] = isNaN(Number(msg.issue)) ? msg.issue : Number(msg.issue);
    if (msg.page != null) fm["pages"] = msg.page;
  });

  await quoteFields(app, file, ["title", "type"]);
  new Notice("Bibman: frontmatter actualizado desde doi.");
  await moveAndRenameFileByCiteKey(app, file, capturedAuthors, capturedYear);
}

export class DoiInputModal extends Modal {
  private input!: HTMLInputElement;

  constructor(app: App, private readonly plugin: BibmanPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Completar frontmatter desde doi" });

    const desc = contentEl.createEl("p");
    desc.setCssProps({ color: "var(--text-muted)", "font-size": "0.9em" });
    desc.textContent =
      "Introduce el doi en cualquier formato: solo el código, con prefijo doi:, o como URL.";

    this.input = contentEl.createEl("input", { type: "text" });
    this.input.placeholder = "10.1016/j.xcrm.2025.101982";
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
    const doi = normalizeDoi(raw);
    this.close();
    await fillFrontmatterFromDoi(this.app, doi);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
