/** Run `fn` over `items` with at most `concurrency` in flight. Errors are passed to `onError`, not thrown. */
export async function forEachLimit<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
    onError: (err: unknown, item: T) => void,
): Promise<void> {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const item = items[next++]!;
            try {
                await fn(item);
            } catch (err) {
                onError(err, item);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** Minimal semaphore to share a concurrency budget between several loops (e.g. detail requests). */
export class Semaphore {
    private waiting: (() => void)[] = [];
    private active = 0;

    constructor(private readonly max: number) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        // A released slot is handed directly to the next waiter, so `active` never exceeds `max`.
        if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
        else this.active++;
        try {
            return await fn();
        } finally {
            const next = this.waiting.shift();
            if (next) next();
            else this.active--;
        }
    }
}
