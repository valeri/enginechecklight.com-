// Key-value storage behind one small interface, so the app logic does not care where data lives.
//   get(key) -> value | null     set(key, value)     del(key)     incr(key) -> new count
//   add(key, delta) -> new count (atomic; used for credit balances)
// Production: Netlify Blobs (one site-wide store, strong consistency so limits and sessions
// are exact). Tests and local dev: an in-memory map.

export function memoryStore() {
  const data = new Map();
  return {
    async get(key) {
      return data.has(key) ? structuredClone(data.get(key)) : null;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async del(key) {
      data.delete(key);
    },
    async incr(key) {
      return this.add(key, 1);
    },
    async add(key, delta) {
      const n = ((data.get(key) ?? {}).n ?? 0) + delta;
      data.set(key, { n });
      return n;
    },
    _data: data,
  };
}

export async function blobStore(name = 'ecl') {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name, consistency: 'strong' });
  return {
    get: (key) => store.get(key, { type: 'json' }),
    set: (key, value) => store.setJSON(key, value),
    del: (key) => store.delete(key),
    incr(key) {
      return this.add(key, 1);
    },
    // Counter with optimistic concurrency: retry if another request wrote in between.
    async add(key, delta) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const entry = await store.getWithMetadata(key, { type: 'json' });
        const n = ((entry?.data ?? {}).n ?? 0) + delta;
        const res = entry
          ? await store.setJSON(key, { n }, { onlyIfMatch: entry.etag })
          : await store.setJSON(key, { n }, { onlyIfNew: true });
        if (res?.modified !== false) return n;
      }
      throw new Error(`incr conflict on ${key}`);
    },
  };
}
