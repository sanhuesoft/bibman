import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { CITATION_SOURCE } from "./constants";

export function decorateView(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const markDouble = Decoration.mark({ class: "bibman-inline-cite" });
  const markTriple = Decoration.mark({ class: "bibman-inline-cite--triple" });
  const re = new RegExp(CITATION_SOURCE, "g");

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const start = from + match.index;
      const len = match[0].length;
      if (match[0].startsWith("{{{")) {
        builder.add(start, start + len, markTriple);
      } else {
        builder.add(start, start + len, markDouble);
      }
    }
  }

  return builder.finish();
}

export const citationEditorPlugin = ViewPlugin.fromClass(
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
