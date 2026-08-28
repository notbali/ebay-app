// Shared date formatting for the What's New list and detail pages.

function ordinalDay(day) {
  const rem100 = day % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][day % 10] || 'th';
  return `${day}${suffix}`;
}

// e.g. "Fri 28th" — short label for the list page.
function formatUpdateDateShort(dateStr) {
  const d = new Date(dateStr);
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
  return `${weekday} ${ordinalDay(d.getDate())}`;
}

// e.g. "Friday, August 28, 2026" — full date for the detail page.
function formatUpdateDateFull(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
