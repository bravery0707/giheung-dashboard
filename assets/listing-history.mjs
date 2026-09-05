// Missing days and failed collections are not observations of disappearance.
export function persistentGone(snapshots, minimumObservations = 2) {
  const valid = snapshots.filter(s => s.quality?.complete !== false)
    .slice().sort((a, b) => a.date.localeCompare(b.date));
  const records = new Map();
  for (const snapshot of valid) {
    const visible = new Set(snapshot.listings.map(item => item.trackId));
    for (const record of records.values()) {
      if (!visible.has(record.item.trackId)) {
        record.missingObservations++;
        record.missingSince ||= snapshot.date;
      }
    }
    for (const item of snapshot.listings) {
      records.set(item.trackId, { item, lastSeen: snapshot.date, missingSince: null, missingObservations: 0 });
    }
  }
  const latest = valid.at(-1)?.date;
  return [...records.values()].filter(r => r.missingObservations >= minimumObservations).map(r => ({
    ...r.item, lastSeen: r.lastSeen, missingSince: r.missingSince,
    missingObservations: r.missingObservations,
    daysSinceLastSeen: Math.round((Date.parse(latest) - Date.parse(r.lastSeen)) / 86400000),
  }));
}
