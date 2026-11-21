export interface CatalogModel {
  id: string;
  provider: string;
  name?: string;
  contextWindow?: number;
  inputPrice?: number;
  outputPrice?: number;
  speed?: string;
  quality?: number;
  openSource?: boolean;
  roles: string[];
  tags: string[];
  description?: string;
}

export interface CatalogAgent {
  id: string;
  name: string;
  role?: string;
  provider: string;
  model: string;
  description?: string;
}

export interface ModelCatalog {
  version: 1;
  source: string;
  sourceUrl?: string;
  updatedAt: string;
  hash: string;
  models: CatalogModel[];
  agents: CatalogAgent[];
  warnings: string[];
}

export interface CatalogImportInput {
  json?: string;
  url?: string;
  replace?: boolean;
}

export interface CatalogImportResult {
  catalog: ModelCatalog;
  importedModels: number;
  importedAgents: number;
  warnings: string[];
}
