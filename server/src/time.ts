export interface CurrentTime {
  iso: string;
  timezone: string;
  formatted: string;
  utc: string;
}

export function getCurrentTime(timezone?: string): CurrentTime {
  const now = new Date();
  const resolved =
    timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: resolved,
      dateStyle: "full",
      timeStyle: "long",
    });
  } catch {
    throw new Error(`Unknown timezone "${resolved}". Use an IANA name such as Europe/Istanbul.`);
  }
  return {
    iso: now.toISOString(),
    timezone: resolved,
    formatted: formatter.format(now),
    utc: now.toUTCString(),
  };
}
