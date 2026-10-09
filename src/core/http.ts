import { Actor, log, type ProxyConfiguration } from 'apify';
import { Impit, type RequestInit } from 'impit';
import { CookieJar } from 'tough-cookie';

/** Thrown when the site refused us (429, captcha, auth wall). The caller should not retry blindly. */
export class BlockedError extends Error {}

export type ProxyTier = 'user' | 'residential';

interface Session {
    id: string;
    tier: ProxyTier;
    impit: Impit;
    uses: number;
}

export interface FetchResult {
    status: number;
    body: string;
    url: string;
}

export interface HttpStats {
    requests: number;
    failures: number;
    blocked: number;
    bytes: Record<ProxyTier, number>;
    requestsByTier: Record<ProxyTier, number>;
}

export interface HttpClientOptions {
    /** Name used in logs and stats. */
    name: string;
    /** User-configured proxy (Apify datacenter by default). */
    proxy?: ProxyConfiguration;
    /**
     * Residential proxy used only for a request that was blocked on the user's proxy.
     * Residential traffic is billed per GB to us, so this is a last resort, never the default.
     */
    residentialProxy?: ProxyConfiguration;
    /** Decides whether a response means "blocked" (captcha page, auth wall, ...). */
    isBlocked?: (res: FetchResult) => boolean;
    /** Retire a session after this many requests to spread load over IPs. */
    maxSessionUses?: number;
    /** Number of parallel sessions (IPs) per proxy tier. Requests are spread across them. */
    poolSize?: number;
    maxRetries?: number;
    timeoutMs?: number;
    /** Keep cookies per session (needed by sites that set tokens on the first page). */
    cookies?: boolean;
    headers?: Record<string, string>;
}

/**
 * Lightweight HTTP client: browser TLS fingerprint (impit), sticky proxy sessions,
 * automatic proxy escalation on block, and byte accounting for cost tracking.
 *
 * We deliberately don't use Crawlee's RequestQueue here: every queue operation is a billed
 * storage API call, and our pagination is fully predictable.
 */
export class HttpClient {
    readonly stats: HttpStats = {
        requests: 0, failures: 0, blocked: 0,
        bytes: { user: 0, residential: 0 },
        requestsByTier: { user: 0, residential: 0 },
    };

    private pools: Record<ProxyTier, Session[]> = { user: [], residential: [] };
    private sessionCounter = 0;

    constructor(private readonly opts: HttpClientOptions) {}

    private async newSession(tier: ProxyTier): Promise<Session> {
        const id = `${this.opts.name}_${tier}_${++this.sessionCounter}`;
        const proxyConf = tier === 'residential' ? this.opts.residentialProxy : this.opts.proxy;
        const proxyUrl = proxyConf ? await proxyConf.newUrl(id) : undefined;
        const impit = new Impit({
            browser: 'chrome',
            proxyUrl,
            timeout: this.opts.timeoutMs ?? 20_000,
            cookieJar: this.opts.cookies ? new CookieJar() : undefined,
            headers: this.opts.headers,
        });
        return { id, tier, impit, uses: 0 };
    }

    private async getSession(tier: ProxyTier): Promise<Session> {
        const pool = this.pools[tier];
        const maxUses = this.opts.maxSessionUses ?? 50;
        for (const s of pool.filter((x) => x.uses >= maxUses)) this.retire(s);
        if (pool.length < (this.opts.poolSize ?? 5)) {
            const fresh = await this.newSession(tier);
            pool.push(fresh);
            return fresh;
        }
        return pool[Math.floor(Math.random() * pool.length)]!;
    }

    private retire(session: Session) {
        const pool = this.pools[session.tier];
        const i = pool.indexOf(session);
        if (i >= 0) pool.splice(i, 1);
    }

    /** Run a callback with a session, e.g. to warm cookies before API calls. */
    async withSession<T>(tier: ProxyTier, fn: (impit: Impit) => Promise<T>): Promise<T> {
        return fn((await this.getSession(tier)).impit);
    }

    async fetch(url: string, init: RequestInit = {}): Promise<FetchResult> {
        const maxRetries = this.opts.maxRetries ?? 3;
        let lastError: unknown;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // Escalate to residential only for the last attempt(s), and only if configured.
            const tier: ProxyTier = this.opts.residentialProxy && attempt >= maxRetries - 1 && attempt > 0 ? 'residential' : 'user';
            const session = await this.getSession(tier);
            session.uses++;
            this.stats.requests++;
            this.stats.requestsByTier[tier]++;
            try {
                const res = await session.impit.fetch(url, init);
                const bytes = await res.bytes();
                // Approximation: impit decompresses transparently, so we count decoded bytes.
                // Real (compressed) wire traffic is lower; benchmarks in docs/ use this as an upper bound.
                this.stats.bytes[tier] += bytes.byteLength;
                const result: FetchResult = { status: res.status, body: Buffer.from(bytes).toString('utf8'), url: res.url };
                if (result.status === 429 || result.status === 403 || result.status === 999 || this.opts.isBlocked?.(result)) {
                    this.stats.blocked++;
                    this.retire(session);
                    throw new BlockedError(`Blocked (${result.status}) on ${tier} proxy: ${url}`);
                }
                if (result.status >= 500) throw new Error(`HTTP ${result.status}: ${url}`);
                return result;
            } catch (err) {
                lastError = err;
                this.stats.failures++;
                this.retire(session);
                // Exponential backoff with jitter: 0.5s, 1s, 2s ...
                await sleep(500 * 2 ** attempt + Math.random() * 300);
            }
        }
        throw lastError;
    }
}

export function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the proxy ladder. Users choose their proxy in the input (Apify datacenter by default);
 * residential is added as a fallback only when running on Apify with Apify Proxy.
 */
export async function createProxies(input: { useApifyProxy?: boolean; apifyProxyGroups?: string[]; apifyProxyCountry?: string; proxyUrls?: string[] } | undefined, residentialCountry?: string) {
    const proxy = input ? await Actor.createProxyConfiguration(input) : undefined;
    let residentialProxy: ProxyConfiguration | undefined;
    const alreadyResidential = input?.apifyProxyGroups?.includes('RESIDENTIAL');
    if (Actor.isAtHome() && input?.useApifyProxy && !alreadyResidential) {
        try {
            residentialProxy = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: residentialCountry });
        } catch (err) {
            log.warning(`Residential fallback proxy unavailable: ${(err as Error).message}`);
        }
    }
    return { proxy, residentialProxy };
}
