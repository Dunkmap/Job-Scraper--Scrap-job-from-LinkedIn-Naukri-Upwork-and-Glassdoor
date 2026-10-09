import { Actor, log } from 'apify';
import type { Job, SourceName } from '../types.js';
import { crossSourceKey } from './normalize.js';

/** Pay-per-event names. Prices are set in Apify Console; see PLAN.md. */
export const EVENTS = {
    job: 'job',
    jobWithDetails: 'job-with-details',
} as const;

const STATE_STORE = 'ultimate-job-scraper-state';
const SEEN_KEY = 'SEEN_JOB_IDS';
const SEEN_MAX_AGE_DAYS = 60;
const SEEN_MAX_ENTRIES = 200_000;
const FLUSH_SIZE = 50;

export interface SinkOptions {
    sources: SourceName[];
    maxItemsPerSource: number;
    fetchDetails: boolean;
    onlyNewJobs: boolean;
    dedupeAcrossSources: boolean;
    includeDescriptionHtml: boolean;
}

/**
 * Single gate between scrapers and the dataset. It decides *before* any expensive detail request
 * whether a job is worth fetching (not a duplicate, not seen before, within quota and budget),
 * then pushes and charges in batches.
 */
export class JobSink {
    private readonly ids = new Set<string>();
    private readonly crossKeys = new Set<string>();
    private readonly claimed: Record<string, number> = {};
    private readonly pushed: Record<string, number> = {};
    private readonly buffers: Record<string, Job[]> = { [EVENTS.job]: [], [EVENTS.jobWithDetails]: [] };
    private seen: Record<string, number> = {};
    private budgetExhausted = false;
    skippedDuplicates = 0;
    skippedSeen = 0;

    constructor(private readonly opts: SinkOptions) {
        for (const s of opts.sources) { this.claimed[s] = 0; this.pushed[s] = 0; }
    }

    async init() {
        if (!this.opts.onlyNewJobs) return;
        const store = await Actor.openKeyValueStore(STATE_STORE);
        this.seen = (await store.getValue<Record<string, number>>(SEEN_KEY)) ?? {};
        log.info(`Only-new mode: ${Object.keys(this.seen).length} previously seen jobs loaded.`);
    }

    /** True when nothing more can be added: budget gone, or every source is at its quota. */
    get stopped(): boolean {
        return this.budgetExhausted || this.opts.sources.every((s) => this.isFull(s));
    }

    isFull(source: SourceName): boolean {
        return this.budgetExhausted || this.claimed[source]! >= this.opts.maxItemsPerSource;
    }

    private pendingCount(): number {
        return Object.values(this.buffers).reduce((n, b) => n + b.length, 0);
    }

    /** Remaining number of jobs the user's max-charge limit allows (Infinity when not pay-per-event). */
    private budgetLeft(): number {
        const event = this.opts.fetchDetails ? EVENTS.jobWithDetails : EVENTS.job;
        const max = Actor.getChargingManager().calculateMaxEventChargeCountWithinLimit(event);
        return max - this.pendingCount() - this.inFlight;
    }

    private inFlight = 0;

    /**
     * Reserve a slot for a job found in search results. Returns false if the job should be skipped.
     * Call `push` (or `release`) for every claimed job.
     */
    claim(job: Job): boolean {
        if (this.isFull(job.source)) return false;
        if (this.ids.has(job.id)) { this.skippedDuplicates++; return false; }
        if (this.opts.onlyNewJobs && this.seen[job.id]) { this.skippedSeen++; return false; }
        if (this.budgetLeft() <= 0) { this.budgetExhausted = true; return false; }
        const key = crossSourceKey(job);
        if (this.opts.dedupeAcrossSources && this.crossKeys.has(key)) { this.skippedDuplicates++; return false; }
        this.ids.add(job.id);
        this.crossKeys.add(key);
        this.claimed[job.source]!++;
        this.inFlight++;
        return true;
    }

    /** Give back a claimed slot (e.g. job disappeared). */
    release(job: Job) {
        this.claimed[job.source]!--;
        this.inFlight--;
    }

    async push(job: Job) {
        this.inFlight--;
        if (!this.opts.includeDescriptionHtml) job.descriptionHtml = null;
        const event = job.detailsFetched ? EVENTS.jobWithDetails : EVENTS.job;
        this.buffers[event]!.push(job);
        if (this.buffers[event]!.length >= FLUSH_SIZE) await this.flushEvent(event);
    }

    private async flushEvent(event: string) {
        const items = this.buffers[event]!.splice(0);
        if (!items.length) return;
        const result = await Actor.pushData(items, event);
        // pushData only stores as many items as the budget allows.
        const stored = Actor.getChargingManager().getPricingInfo().isPayPerEvent ? result.chargedCount : items.length;
        for (const item of items.slice(0, stored)) {
            this.pushed[item.source]!++;
            this.seen[item.id] = today();
        }
        if (result.eventChargeLimitReached) {
            this.budgetExhausted = true;
            log.info('Maximum charge per run reached; stopping.');
        }
    }

    async flush() {
        for (const event of Object.keys(this.buffers)) await this.flushEvent(event);
    }

    async close() {
        await this.flush();
        if (this.opts.onlyNewJobs) {
            const store = await Actor.openKeyValueStore(STATE_STORE);
            await store.setValue(SEEN_KEY, pruneSeen(this.seen));
        }
    }

    summary() {
        return { pushed: { ...this.pushed }, skippedDuplicates: this.skippedDuplicates, skippedSeen: this.skippedSeen, budgetExhausted: this.budgetExhausted };
    }
}

/** Days since epoch: compact timestamp for the seen-store (keeps the record small). */
function today(): number {
    return Math.floor(Date.now() / 86_400_000);
}

export function pruneSeen(seen: Record<string, number>, now = today()): Record<string, number> {
    const entries = Object.entries(seen).filter(([, d]) => now - d <= SEEN_MAX_AGE_DAYS);
    entries.sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(entries.slice(0, SEEN_MAX_ENTRIES));
}
