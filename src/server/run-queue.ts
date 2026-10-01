interface WaitingRun {
  id: string;
  execute: () => Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export class RunQueue {
  private waiting: WaitingRun[] = [];
  private active = 0;
  private capacity: number;
  constructor(capacity = 4) {
    this.capacity = capacity;
  }
  get pendingCount() {
    return this.waiting.length;
  }
  enqueue(id: string, execute: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ id, execute, resolve, reject });
      this.drain();
    });
  }
  remove(id: string): boolean {
    const index = this.waiting.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [entry] = this.waiting.splice(index, 1);
    entry.resolve();
    return true;
  }
  private drain() {
    while (this.active < this.capacity && this.waiting.length) {
      const entry = this.waiting.shift()!;
      this.active++;
      void Promise.resolve()
        .then(entry.execute)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }
}
