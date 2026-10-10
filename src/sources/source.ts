import type { HttpClient } from '../core/http.js';
import type { JobSink } from '../core/sink.js';
import type { Input, SearchQuery, SourceName } from '../types.js';

export interface SourceContext {
    input: Input;
    sink: JobSink;
    http: HttpClient;
}

export interface Source {
    name: SourceName;
    /** Country used for the residential fallback proxy (closest exit = fewer blocks). */
    residentialCountry?: string;
    /**
     * Start on residential instead of datacenter. Only for sources where datacenter is
     * hopeless: Glassdoor blocks 100% of Apify datacenter requests, so trying it first
     * just buys a guaranteed block, a retry and wasted wall-clock.
     */
    preferResidential?: boolean;
    /** Decides whether a 200 response is actually a block page. */
    isBlocked?: (res: { status: number; body: string; url: string }) => boolean;
    /** Per-source HTTP tuning, e.g. a longer session life for sticky pagination. */
    httpOptions?: { maxSessionUses?: number; poolSize?: number; warmUrl?: string; headers?: Record<string, string> };
    run(ctx: SourceContext, queries: SearchQuery[]): Promise<void>;
}
