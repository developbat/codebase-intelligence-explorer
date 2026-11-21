export interface ModelHealth {
  provider: string;
  model: string;
  successCount: number;
  protocolFailures: number;
  emptyFailures: number;
  unavailable?: boolean;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastUnavailableAt?: string;
}

export interface ModelHealthReport {
  models: ModelHealth[];
}
