import { useCallback, useEffect, useRef, useState } from "react";

interface CacheEntry<T> {
  value: T;
  at: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

export function readCache<T>(key: string, maxAgeMs = Number.POSITIVE_INFINITY): {
  value: T;
  at: number;
  stale: boolean;
} | undefined {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  return {
    value: entry.value,
    at: entry.at,
    stale: Date.now() - entry.at > maxAgeMs,
  };
}

export function writeCache<T>(key: string, value: T): void {
  cache.set(key, { value, at: Date.now() });
}

export function clearCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

export interface CachedResource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  updatedAt?: number;
  refresh: (force?: boolean) => Promise<void>;
}

/**
 * Keeps the last result in memory across Settings tab/panel mounts.
 * A cached value is shown immediately; a stale value is revalidated in the
 * background. Manual refresh bypasses the client cache.
 */
export function useCachedResource<T>(
  key: string | null,
  loader: (force?: boolean) => Promise<T>,
  options: { maxAgeMs?: number; errorMessage?: string } = {},
): CachedResource<T> {
  const maxAgeMs = options.maxAgeMs ?? 60_000;
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const initial = key ? readCache<T>(key, maxAgeMs) : undefined;
  const [data, setData] = useState<T | null>(initial?.value ?? null);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | undefined>(initial?.at);

  useEffect(() => {
    if (!key) {
      setData(null);
      setLoading(false);
      setError(null);
      setUpdatedAt(undefined);
      return;
    }
    const cached = readCache<T>(key, maxAgeMs);
    if (cached) {
      setData(cached.value);
      setUpdatedAt(cached.at);
      setLoading(false);
      if (!cached.stale) return;
    } else {
      setData(null);
      setLoading(true);
    }
    let cancelled = false;
    loaderRef
      .current()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
        const at = Date.now();
        writeCache(key, value);
        setUpdatedAt(at);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : options.errorMessage ?? "Could not load this list.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, maxAgeMs]);

  const refresh = useCallback(
    async (force = false) => {
      if (!key) return;
      setLoading((current) => (data === null ? true : current));
      try {
        const value = await loaderRef.current(force);
        setData(value);
        setError(null);
        const at = Date.now();
        writeCache(key, value);
        setUpdatedAt(at);
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : options.errorMessage ?? "Could not load this list.",
        );
      } finally {
        setLoading(false);
      }
    },
    [key, data, options.errorMessage],
  );

  return { data, loading, error, updatedAt, refresh };
}
