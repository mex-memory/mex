export const localDateTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

export const fullDateTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "long", day: "numeric",
  hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
});

export const localShortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function relativeTime(at: Date, now: Date, compactDays = false) {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  if (compactDays) return `${Math.floor(minutes / (24 * 60))} d ago`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return at.toDateString() === yesterday.toDateString() ? "yesterday" : localShortDate.format(at);
}
