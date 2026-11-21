export interface ModelHealth {
  provider: string;
  model: string;
  successCount: number;
  protocolFailures: number;
  emptyFailures: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

export interface ModelHealthReport {
  models: ModelHealth[];
}
