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
    /** Session warm-up requests, counted separately so they are visible in the cost numbers. */
    warmups: number;
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
    /** Tier to try first. Defaults to the user's (cheap) proxy; see Source.preferResidential. */
    startTier?: ProxyTier;
    /**
     * Cheap URL fetched once when a session is created, to pick up the cookies a
     * Cloudflare-fronted site expects before the first real request. Keep it small: it is paid
     * for on every session. Glassdoor uses robots.txt (~2 KB gzip).
     */
    warmUrl?: string;
    maxRetries?: number;
    timeoutMs?: number;
    /**
     * Keep cookies per session. On by default: Cloudflare-fronted sites (Glassdoor) hand out a
     * __cf_bm cookie on the first response and 403 every later request without it. All the
     * block-rate numbers in docs/cost-benchmarks.md were measured with a cookie jar in place.
     */
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
        requests: 0, failures: 0, blocked: 0, warmups: 0,
        bytes: { user: 0, residential: 0 },
        requestsByTier: { user: 0, residential: 0 },
    };

    private pools: Record<ProxyTier, Session[]> = { user: [], residential: [] };
    /** Sessions pinned to a caller key, e.g. one per Glassdoor search query. */
    private sticky = new Map<string, Session>();
    private sessionCounter = 0;
    /*
     * Apify Proxy pins one IP per session id, so a deterministic id such as
     * "glassdoor_residential_1" hands every run the SAME IPs - including the ones the previous
     * run got blocked on. Measured: a Glassdoor run inherited burned IPs and was blocked on
     * 8/8 requests, while identical code using random ids was clean. Scope ids to this run.
     */
    private readonly runTag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    private readonly loggedProxy = new Set<ProxyTier>();

    constructor(private readonly opts: HttpClientOptions) {}

    private async newSession(tier: ProxyTier): Promise<Session> {
        const id = `${this.opts.name}_${tier}_${this.runTag}_${++this.sessionCounter}`;
        const proxyConf = tier === 'residential' ? this.opts.residentialProxy : this.opts.proxy;
        const proxyUrl = proxyConf ? await proxyConf.newUrl(id) : undefined;
        const impit = new Impit({
            browser: 'chrome',
            proxyUrl,
            timeout: this.opts.timeoutMs ?? 20_000,
            cookieJar: this.opts.cookies === false ? undefined : new CookieJar(),
            headers: this.opts.headers,
        });
        const session: Session = { id, tier, impit, uses: 0 };
        if (!this.loggedProxy.has(tier)) {
            this.loggedProxy.add(tier);
            // Credentials redacted: we only want to see which proxy groups/country are in play.
            log.debug(`[${this.opts.name}] ${tier} proxy: ${proxyUrl ? proxyUrl.replace(/:[^:@]*@/, ':<pw>@') : 'none (direct)'}`);
        }
        if (this.opts.warmUrl) {
            // Best effort: a failed warm-up should not fail the real request that follows.
            try {
                const res = await impit.fetch(this.opts.warmUrl);
                const n = (await res.bytes()).byteLength;
                this.stats.bytes[tier] += n;
                this.stats.warmups++;
                log.debug(`[${this.opts.name}] warm-up ${id}: HTTP ${res.status} ${n}B`);
            } catch (err) {
                log.debug(`[${this.opts.name}] warm-up ${id} failed: ${(err as Error).message.slice(0, 80)}`);
            }
        }
        return session;
    }

    /**
     * Session bound to a caller-chosen key, for sites whose pagination lives in the session.
     * Glassdoor advances its result set per session, so page 2 fetched from a different IP
     * returns page 1 again (measured) and often a 403.
     */
    private async getSession(tier: ProxyTier, key?: string): Promise<Session> {
        if (key) {
            const bound = this.sticky.get(`${tier}:${key}`);
            if (bound && bound.uses < (this.opts.maxSessionUses ?? 5)) return bound;
            const fresh = await this.newSession(tier);
            this.sticky.set(`${tier}:${key}`, fresh);
            this.pools[tier].push(fresh);
            return fresh;
        }
        const pool = this.pools[tier];
        // Measured: a LinkedIn guest IP serves only a handful of requests before it starts
        // returning 999/429, so sessions are retired early and replaced with a fresh IP.
        const maxUses = this.opts.maxSessionUses ?? 5;
        for (const s of pool.filter((x) => x.uses >= maxUses)) this.retire(s);
        if (pool.length < (this.opts.poolSize ?? 12)) {
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
        for (const [key, bound] of this.sticky) if (bound === session) this.sticky.delete(key);
    }

    /** Run a callback with a session, e.g. to warm cookies before API calls. */
    async withSession<T>(tier: ProxyTier, fn: (impit: Impit) => Promise<T>): Promise<T> {
        return fn((await this.getSession(tier)).impit);
    }

    async fetch(url: string, init: RequestInit = {}, sessionKey?: string): Promise<FetchResult> {
        const maxRetries = this.opts.maxRetries ?? 3;
        let lastError: unknown;
        let wasBlocked = false;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            /*
             * Escalate on the FIRST block, not on the last attempt.
             * Measured on LinkedIn (docs/cost-benchmarks.md): Apify datacenter IPs are blocked on
             * ~25% of requests, residential on ~5%. Retrying a block on datacenter mostly buys
             * another block, so once we have seen one we switch. A plain network error is not a
             * block, so that stays on the free tier.
             */
            const start = this.opts.startTier === 'residential' && this.opts.residentialProxy ? 'residential' : 'user';
            const tier: ProxyTier = this.opts.residentialProxy && wasBlocked ? 'residential' : start;
            const session = await this.getSession(tier, sessionKey);
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
                    wasBlocked = true;
                    // Include what the site actually said: a captcha wall, a rate-limit notice and
                    // a geo block all arrive as 403 but need different fixes.
                    const why = result.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
                    throw new BlockedError(`Blocked (${result.status}) on ${tier} proxy: ${url}${why ? ` | said: ${why}` : ''}`);
                }
                if (result.status >= 500) throw new Error(`HTTP ${result.status}: ${url}`);
                return result;
            } catch (err) {
                lastError = err;
                this.stats.failures++;
                this.retire(session);
                // Exponential backoff with jitter: 0.5s, 1s, 2s ... but never after the last
                // attempt, where the wait is billed wall-clock that buys nothing.
                if (attempt < maxRetries) await sleep(500 * 2 ** attempt + Math.random() * 300);
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
