export function createPlaybackHistory() {
  const records = new Map();
  const active = record => record && ['queued', 'started'].includes(record.status);
  return {
    queued({ id, text, generation, epoch, key }) {
      records.set(id, { id, text: text.trim(), generation, epoch, ...(key ? { key } : {}),
        status: 'queued', started: false });
      while (records.size > 16) records.delete(records.keys().next().value);
    },
    unplayed(record, reason) {
      if (records.has(record.id)) return;
      this.queued(record);
      const entry = records.get(record.id);
      entry.status = 'not_queued';
      entry.reason = reason;
    },
    started(id) {
      const record = records.get(id);
      if (active(record)) { record.status = 'started'; record.started = true; }
    },
    ended(id, completed, reason = 'not_completed') {
      const record = records.get(id);
      if (!active(record)) return;
      record.status = completed === true ? 'completed' : 'interrupted';
      if (completed !== true) record.reason = reason;
    },
    interrupt(reason) {
      for (const record of records.values()) {
        if (active(record)) { record.status = 'interrupted'; record.reason = reason; }
      }
    },
    snapshot() { return [...records.values()].map(record => ({ ...record })); },
    clear() { records.clear(); },
  };
}
