export function finishInstant(day) {
  const start = day.execution?.started_at || day.available_window?.start_at;
  const elapsed = day.totals?.elapsed_duration_sec;
  if (!start || !Number.isFinite(elapsed)) return null;
  const instant = new Date(start).getTime() + elapsed * 1000;
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}
