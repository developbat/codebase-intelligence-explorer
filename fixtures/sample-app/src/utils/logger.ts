export function log(event: string, context: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ event, ...context, at: new Date().toISOString() });
  console.log(line);
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
