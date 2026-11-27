import crypto from "node:crypto";

export interface CalendarEventInput {
  title: string;
  start: string;
  end?: string;
  location?: string;
  description?: string;
}

function icsDate(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

export function buildCalendarEvent(input: CalendarEventInput): {
  content: string;
  start: string;
  end: string;
} {
  const start = new Date(input.start);
  if (Number.isNaN(start.getTime())) {
    throw new Error("start must be a valid date, for example 2026-11-30T09:00:00Z.");
  }
  const end = input.end ? new Date(input.end) : new Date(start.getTime() + 60 * 60 * 1000);
  if (Number.isNaN(end.getTime())) {
    throw new Error("end must be a valid date.");
  }
  if (end.getTime() <= start.getTime()) {
    throw new Error("end must be after start.");
  }
  const title = input.title.trim();
  if (!title) throw new Error("An event title is required.");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//B.A.D IDE//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@bad-ide`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(title)}`,
    input.location ? `LOCATION:${icsText(input.location)}` : "",
    input.description ? `DESCRIPTION:${icsText(input.description)}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].filter(Boolean);
  return { content: lines.join("\r\n"), start: start.toISOString(), end: end.toISOString() };
}

export function calendarFileName(title: string, requestedPath?: string): string {
  if (requestedPath?.trim()) {
    const clean = requestedPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    return clean.endsWith(".ics") ? clean : `${clean}.ics`;
  }
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "event";
  return `calendar/${slug}.ics`;
}
