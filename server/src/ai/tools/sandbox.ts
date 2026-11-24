export const TOOL_TRY_TIMEOUT_MS = 120_000;

export async function withToolTimeout<T>(
  promise: Promise<T>,
  timeoutMs = TOOL_TRY_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Tool try timed out after ${Math.round(timeoutMs / 1000)}s.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
