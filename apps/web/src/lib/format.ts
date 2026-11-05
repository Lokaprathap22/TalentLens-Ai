const LOCALE = 'en-GB';

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

/**
 * Relative time such as "2 hours ago". The reference time is explicit so output is
 * deterministic for fixtures and tests.
 */
export function formatRelative(iso: string, referenceIso: string): string {
  const delta = new Date(iso).getTime() - new Date(referenceIso).getTime();
  for (const [unit, size] of UNITS) {
    if (Math.abs(delta) >= size) return relative.format(Math.trunc(delta / size), unit);
  }
  return 'just now';
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Day and month in the interview's own time zone, e.g. { weekday: "Fri", day: "6", month: "Nov" }. */
export function formatDateParts(
  iso: string,
  timeZone: string,
): { weekday: string; day: string; month: string } {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(new Date(iso));
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return { weekday: pick('weekday'), day: pick('day'), month: pick('month') };
}

/** "15:00–16:00 GMT+5:30": always shown in the stated time zone, never the viewer's. */
export function formatTimeRange(startIso: string, endIso: string, timeZone: string): string {
  const time = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const zone =
    new Intl.DateTimeFormat(LOCALE, { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date(startIso))
      .find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
  return `${time.format(new Date(startIso))}–${time.format(new Date(endIso))} ${zone}`;
}

const shortDateFormatter = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Locale-aware calendar date such as "5 Nov 2026" (UTC-stable across environments). */
export function formatShortDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }
  return shortDateFormatter.format(parsed);
}
