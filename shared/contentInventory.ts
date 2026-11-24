export interface ContentReference {
  file: string;
  line: number;
  reference: string;
}

export interface ContentAsset {
  path: string;
  bytes: number;
  referencedBy: ContentReference[];
}

export interface BrokenReference extends ContentReference {
  resolved?: string;
}

export interface MarkdownHeading {
  file: string;
  line: number;
  level: number;
  text: string;
}

export interface MarkdownInventory {
  file: string;
  headings: MarkdownHeading[];
  warnings: string[];
}

export interface ContentInventory {
  assets: ContentAsset[];
  unreferenced: ContentAsset[];
  broken: BrokenReference[];
  markdown: MarkdownInventory[];
  summary: {
    assets: number;
    unreferenced: number;
    broken: number;
    markdownFiles: number;
    headingWarnings: number;
  };
  notes: string[];
}
