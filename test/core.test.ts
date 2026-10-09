import { describe, expect, it } from 'vitest';
import { Semaphore } from '../src/core/pool.js';
import { pruneSeen } from '../src/core/sink.js';

describe('Semaphore', () => {
    it('never runs more than max tasks at once', async () => {
        const sem = new Semaphore(3);
        let active = 0;
        let peak = 0;
        await Promise.all(Array.from({ length: 20 }, () => sem.run(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, Math.random() * 5));
            active--;
        })));
        expect(peak).toBe(3);
    });
});

describe('pruneSeen', () => {
    it('drops entries older than 60 days', () => {
        expect(pruneSeen({ old: 100, fresh: 190 }, 200)).toEqual({ fresh: 190 });
    });
});
