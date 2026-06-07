import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { BibmanPlugin } from "./main";
import { formatCiteLabel } from "./helpers";
import { showBibmanPopup, hideBibmanPopup, openBibmanNote } from "./popup";

class CitationWidget extends WidgetType {
  constructor(
    public plugin: BibmanPlugin,
    public key: string,
    public pages: string | undefined,
    public isTriple: boolean
  ) {
    super();
  }

  eq(other: CitationWidget) {
    return other.key === this.key && other.pages === this.pages && other.isTriple === this.isTriple;
  }

  toDOM(view: EditorView): HTMLElement {
    const isTriple = this.isTriple;
    const key = this.key;
    const pages = this.pages;

    let el: HTMLElement;
    if (isTriple) {
      el = document.createElement("span");
      el.className = "bibman-cite";
      el.dataset.bibkey = key;
      if (pages) el.dataset.bibpages = pages;
      el.dataset.bibvariant = "triple";
      el.textContent = formatCiteLabel(key);
    } else {
      el = document.createElement("sup");
      el.className = "bibman-cite";
      el.dataset.bibkey = key;
      if (pages) el.dataset.bibpages = pages;
      el.dataset.bibvariant = "double";
      el.textContent = "[R]";
    }

    el.addEventListener("mouseenter", () => void showBibmanPopup(this.plugin, el));
    el.addEventListener("mouseleave", () => hideBibmanPopup());
    el.addEventListener("click", () => openBibmanNote(this.plugin, el));

    return el;
  }
}

export function buildCitationEditorPlugin(plugin: BibmanPlugin) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const re = new RegExp(String.raw`\{\{\{([^}:]+?)(?::([^}]+?))?\}\}\}|\{\{([^}:]+?)(?::([^}]+?))?\}\}`, "g");

        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          re.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = re.exec(text)) !== null) {
            const start = from + match.index;
            const end = start + match[0].length;
            
            const isCursorInside = view.state.selection.ranges.some(
              (r) => r.from <= end && r.to >= start
            );

            const isTriple = !!match[1];
            const key = isTriple ? match[1] : match[3];
            const pages = isTriple ? match[2] : match[4];

            if (isCursorInside) {
               builder.add(start, end, Decoration.mark({ class: isTriple ? "bibman-inline-cite--triple" : "bibman-inline-cite" }));
               continue;
            }

            if (key) {
               builder.add(
                 start,
                 end,
                 Decoration.replace({
                   widget: new CitationWidget(plugin, key, pages, isTriple),
                   inclusive: false,
                 })
               );
            }
          }
        }

        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}
