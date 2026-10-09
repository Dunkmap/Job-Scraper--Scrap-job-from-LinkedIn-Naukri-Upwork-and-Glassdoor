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
    /** Decides whether a 200 response is actually a block page. */
    isBlocked?: (res: { status: number; body: string; url: string }) => boolean;
    run(ctx: SourceContext, queries: SearchQuery[]): Promise<void>;
}
