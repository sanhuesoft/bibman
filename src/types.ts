import { TFile } from "obsidian";

export interface BibEntry {
  author?: string;
  authors?: string[];
  title?: string;
  year?: string | number;
}

export interface CrossRefChapter {
  title: string;
  bookTitle: string;
  authors: string[];
  year?: number;
  pages?: string;
  doi?: string;
}

export interface BibmanSettings {
  updateRefsOnRename: boolean;
  moveNewNoteToBiblio: boolean;
}

export const DEFAULT_SETTINGS: BibmanSettings = {
  updateRefsOnRename: true,
  moveNewNoteToBiblio: true,
};

export type BibSuggestion =
  | TFile
  | { create: true; name: string }
  | { placeholder: true; name: string };

export interface CrossRefMessage {
  type?: string;
  title?: string[];
  author?: { family?: string; given?: string }[];
  published?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  volume?: string;
  issue?: string;
  page?: string;
}

export interface OpenLibrarySearchDoc {
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  publisher?: string[];
}

export interface WebMetadata {
  title?: string;
  author?: string;
  year?: number;
  url: string;
}
