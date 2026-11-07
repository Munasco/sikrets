// Where the relay keeps messages. Each message is an opaque blob under (box, id) with an expiry.

export interface Stored {
  id: string;
  blob: string;
  /** Epoch seconds. */
  expiresAt: number;
}

export interface Store {
  put(box: string, msg: Stored): Promise<void>;
  /** Unexpired messages in a box. */
  list(box: string, nowSeconds: number): Promise<Stored[]>;
  remove(box: string, id: string): Promise<void>;
}

export function memoryStore(): Store {
  const boxes = new Map<string, Map<string, Stored>>();
  return {
    async put(box, msg) {
      if (!boxes.has(box)) boxes.set(box, new Map());
      boxes.get(box)!.set(msg.id, msg);
    },
    async list(box, now) {
      const b = boxes.get(box);
      if (!b) return [];
      for (const [id, m] of b) if (m.expiresAt <= now) b.delete(id);
      return [...b.values()];
    },
    async remove(box, id) {
      boxes.get(box)?.delete(id);
    },
  };
}
