/** Store for the per-user hash chain. Swap for Redis/DB by implementing the same interface. */
export interface HashStore {
  get(userId: string): Promise<string | undefined>;
  set(userId: string, hash: string): Promise<void>;
}

export class MemoryHashStore implements HashStore {
  private map = new Map<string, string>();
  async get(userId: string) {
    return this.map.get(userId);
  }
  async set(userId: string, hash: string) {
    this.map.set(userId, hash);
  }
}

/** Serializes async work per key so read-modify-write on the chain stays consistent. */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => tail);
    this.tails.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === chained) this.tails.delete(key);
    }
  }
}
