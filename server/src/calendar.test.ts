import assert from "node:assert/strict";
import test from "node:test";
import { buildCalendarEvent, calendarFileName } from "./calendar";

test("builds a portable ICS event with an inferred end", () => {
  const event = buildCalendarEvent({
    title: "Release review",
    start: "2026-12-01T14:00:00Z",
    description: "Check the release notes, then ship.",
  });
  assert.match(event.content, /BEGIN:VEVENT/);
  assert.match(event.content, /SUMMARY:Release review/);
  assert.match(event.content, /DTSTART:20261201T140000Z/);
  assert.match(event.content, /DTEND:20261201T150000Z/);
  assert.match(event.content, /Check the release notes\\, then ship\./);
  assert.equal(event.end, "2026-12-01T15:00:00.000Z");
});

test("calendar file names are slugged or use the requested path", () => {
  assert.equal(calendarFileName("Release Review"), "calendar/release-review.ics");
  assert.equal(calendarFileName("x", "plans/review.ics"), "plans/review.ics");
  assert.equal(calendarFileName("x", "plans/review"), "plans/review.ics");
  assert.throws(() => buildCalendarEvent({ title: "x", start: "bad" }), /valid date/);
});
