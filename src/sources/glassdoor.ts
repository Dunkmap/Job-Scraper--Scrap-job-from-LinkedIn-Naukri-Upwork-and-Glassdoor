import { log } from 'apify';
import { BlockedError } from '../core/http.js';
import { clean, cleanUrl, makeJob } from '../core/normalize.js';
import { forEachLimit } from '../core/pool.js';
import type { Input, Job, JobType, SearchQuery, Salary, WorkType } from '../types.js';
import type { Source, SourceContext } from './source.js';

/*
 * Glassdoor, measured 2026-10-10 (see docs/cost-benchmarks.md):
 *
 * - Datacenter proxy is blocked 100% of the time; residential works. Hence `preferResidential`.
 * - The search page ignores locKeyword/typedLocation entirely and derives location from the
 *   proxy IP, but explicit `locT`/`locId` DOES filter. Those ids come from the surviving
 *   /autocomplete/location endpoint, so arbitrary city/state/country names can be resolved.
 * - We do NOT scrape the rendered cards. Their class names are hashed CSS-module names
 *   (JobCard_jobTitle__GLyJ1) that change on every Glassdoor deploy. Instead the page embeds the
 *   whole result set as JSON in its React Server Component payload, which carries strictly more
 *   than the HTML does: ageInDays, employer rating, pay percentiles, salary provenance and
 *   extracted job attributes.
 */
const SEARCH_URL = 'https://www.glassdoor.com/Job/jobs.htm';
const AUTOCOMPLETE_URL = 'https://www.glassdoor.com/autocomplete/location';
/*
 * One request per query, deliberately.
 *
 * Glassdoor's GET search is hard-capped at 30 results and cannot be paginated: measured over
 * ?p=2..3, ?pageCursor=<cursor>, both combined, and the SEO _IP2.._IP4 URLs, every one returned
 * the SAME 30 job ids. Real pagination goes through a POST to its GraphQL endpoint using the
 * opaque `paginationCursors` in the page payload; /graph answers 403 to anything simpler.
 *
 * Each search page is ~175 KB gzip, so asking for pages we know are duplicates cost about
 * $0.004 per query in residential traffic and returned nothing. Until the GraphQL path is
 * implemented, we take page 1 and stop.
 */
const MAX_PAGES = 1;
const QUERY_CONCURRENCY = 2;

const POSTED_WITHIN_DAYS: Record<Input['postedWithin'], number | null> = {
    '24h': 1, week: 7, month: 30, any: null,
};

/** Values Glassdoor's extracted attributes use for things that are not skills. */
const ATTR_JOB_TYPE: Record<string, JobType> = {
    'full-time': 'full-time', 'part-time': 'part-time', contract: 'contract',
    temporary: 'temporary', internship: 'internship', permanent: 'full-time',
};
const ATTR_WORK_TYPE: Record<string, WorkType> = {
    remote: 'remote', hybrid: 'hybrid', 'in-person': 'onsite', 'on-site': 'onsite', onsite: 'onsite',
};
const ATTR_LEVEL = /^(entry|junior|mid|senior|lead|principal|staff|director|executive)[\s-]*level$|^(entry|junior|mid|senior|lead|principal|staff|director|executive)$/i;
/** Perks and pay mechanics that Glassdoor mixes in with skills; they are not skills. */
const ATTR_NOT_A_SKILL = /insurance|401\(k\)|pension|paid time off|\bpto\b|vacation|holiday|bonus|hourly pay|salary|relocation|visa|parental|dental|vision|wellness|gym|remote work|on demand|flexible schedule|degree|diploma|licen[cs]e|certification|driver's/i;

interface GlassdoorLocation {
    locationId: number;
    locationType: string;
    locationName: string;
}

/** Take the JSON value that starts at `open` (a `[` or `{`), respecting strings and escapes. */
function sliceJson(text: string, open: number): string | null {
    const closer = text[open] === '[' ? ']' : '}';
    const opener = text[open]!;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = open; i < text.length; i++) {
        const ch = text[i]!;
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === opener) depth++;
        else if (ch === closer) {
            depth--;
            if (depth === 0) return text.slice(open, i + 1);
        }
    }
    return null;
}

/**
 * Pull the React Server Component payload out of the page.
 * Next.js streams it as a series of `self.__next_f.push([1,"<chunk>"])` calls, and a single
 * value can straddle chunk boundaries, so they have to be decoded and concatenated in order.
 */
export function flightPayload(html: string): string {
    const chunks: string[] = [];
    const marker = 'self.__next_f.push(';
    // The chunks contain "]" inside their strings, so they have to be bracket-matched,
    // not regex-matched.
    for (let at = html.indexOf(marker); at >= 0; at = html.indexOf(marker, at + 1)) {
        const open = html.indexOf('[', at + marker.length);
        if (open < 0) continue;
        const json = sliceJson(html, open);
        if (!json) continue;
        try {
            const parsed = JSON.parse(json) as unknown[];
            if (typeof parsed[1] === 'string') chunks.push(parsed[1]);
        } catch {
            // Not a chunk we can read; the remaining ones are still usable.
        }
    }
    return chunks.join('');
}

/** The raw `jobListings` array from the page's embedded payload. */
export function extractListings(html: string): any[] {
    for (const text of [flightPayload(html), html]) {
        const marker = text.indexOf('"jobListings":[');
        if (marker < 0) continue;
        const open = text.indexOf('[', marker);
        const json = sliceJson(text, open);
        if (!json) continue;
        try {
            const rows = JSON.parse(json) as any[];
            if (Array.isArray(rows) && rows.length) return rows;
        } catch {
            // Fall through and try the next source of text.
        }
    }
    return [];
}

const PERIODS: Record<string, Salary['period']> = {
    HOURLY: 'hour', DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', ANNUAL: 'year', YEARLY: 'year',
};

function parsePay(header: any): Salary | null {
    const pay = header?.payPeriodAdjustedPay;
    const currency: string | null = header?.payCurrency ?? null;
    const period = PERIODS[String(header?.payPeriod ?? '')] ?? null;
    const min = typeof pay?.p10 === 'number' ? pay.p10 : null;
    const max = typeof pay?.p90 === 'number' ? pay.p90 : null;
    if (min == null && max == null) return null;
    // Readable, e.g. "INR 526,500 - INR 1,000,000 per year" rather than "INR526500-INR1000000/year".
    const money = (n: number) => `${currency ? `${currency} ` : ''}${n.toLocaleString('en-US')}`;
    const amounts = min != null && max != null && max !== min
        ? `${money(min)} - ${money(max)}`
        : money((min ?? max)!);
    return {
        min, max, currency, period,
        raw: `${amounts}${period ? ` per ${period}` : ''}`,
        // Glassdoor marks whether the employer stated the pay or Glassdoor estimated it.
        // Users filtering on salary need to know which, so we pass it through.
        source: header?.salarySource ?? null,
    };
}

/** Split Glassdoor's extracted attributes into the fields they actually describe. */
export function classifyAttributes(values: string[]) {
    let jobType: JobType | null = null;
    let workType: WorkType | null = null;
    let experienceLevel: string | null = null;
    const skills: string[] = [];
    for (const raw of values) {
        const v = clean(raw);
        if (!v) continue;
        const key = v.toLowerCase();
        if (ATTR_JOB_TYPE[key]) { jobType ??= ATTR_JOB_TYPE[key]!; continue; }
        if (ATTR_WORK_TYPE[key]) { workType ??= ATTR_WORK_TYPE[key]!; continue; }
        if (ATTR_LEVEL.test(v)) { experienceLevel ??= v; continue; }
        if (ATTR_NOT_A_SKILL.test(v)) continue;
        skills.push(v);
    }
    return { jobType, workType, experienceLevel, skills };
}

/** Map one embedded listing onto the unified schema. */
export function mapListing(row: any, query: SearchQuery, now = Date.now()): Job | null {
    const view = row?.jobview;
    const header = view?.header;
    const job = view?.job;
    const id = job?.listingId ?? header?.adOrderId;
    const title = clean(job?.jobTitleText ?? header?.jobTitleText);
    if (!id || !title) return null;

    const attrs: string[] = (header?.indeedJobAttribute?.extractedJobAttributes ?? [])
        .map((a: any) => a?.value)
        .filter((v: unknown): v is string => typeof v === 'string');
    const { jobType, workType, experienceLevel, skills } = classifyAttributes(attrs);

    const ageInDays = typeof header?.ageInDays === 'number' ? header.ageInDays : null;
    const employerId = header?.employer?.id;
    const rating = header?.employer?.ratings?.overallRating;
    const snippet = (job?.descriptionFragmentsText ?? [])
        .filter((t: unknown): t is string => typeof t === 'string')
        .join('\n\n');

    return makeJob({
        source: 'glassdoor',
        sourceJobId: String(id),
        url: cleanUrl(header?.seoJobLink) ?? `https://www.glassdoor.com/job-listing/?jl=${id}`,
        title,
        company: clean(header?.employer?.name ?? header?.employerNameFromSearch),
        // Glassdoor's "999999999" is its placeholder for an unlisted employer.
        companyUrl: employerId && employerId !== 999_999_999 ? `https://www.glassdoor.com/Overview/-EI_IE${employerId}.htm` : null,
        companyLogo: view?.overview?.squareLogoUrl ?? null,
        companyRating: typeof rating === 'number' && rating > 0 ? rating : null,
        location: clean(header?.locationName),
        workType,
        jobType,
        experienceLevel,
        salary: parsePay(header),
        skills,
        postedAt: ageInDays != null ? new Date(now - ageInDays * 86_400_000).toISOString() : null,
        postedAtRaw: ageInDays != null ? `${ageInDays}d` : null,
        easyApply: typeof header?.easyApply === 'boolean' ? header.easyApply : null,
        description: snippet || null,
        jobFunction: clean(header?.goc ?? header?.normalizedJobTitle),
        searchKeyword: query.keyword,
        searchLocation: query.location,
    });
}

export function buildSearchUrl(query: SearchQuery, loc: GlassdoorLocation | null, page: number): string {
    const params = new URLSearchParams({ 'sc.keyword': query.keyword });
    if (loc) {
        params.set('locT', loc.locationType);
        params.set('locId', String(loc.locationId));
    }
    if (page > 1) params.set('p', String(page));
    return `${SEARCH_URL}?${params}`;
}

export const glassdoor: Source = {
    name: 'glassdoor',
    // Measured: 3/3 datacenter requests blocked, 3/3 residential requests fine.
    preferResidential: true,
    /*
     * Pin the residential exit to the US. Glassdoor is a US property behind Cloudflare and
     * returned 403 for every request on unpinned (random-country) residential exits, while
     * US exits were clean. Location filtering does not depend on the exit country any more,
     * because we pass Glassdoor its own locT/locId.
     */
    residentialCountry: 'US',
    /*
     * Pagination is session-stateful, so one session has to carry a whole query. Sessions
     * therefore live far longer here than the LinkedIn default of 5 requests.
     */
    httpOptions: {
        maxSessionUses: 60,
        poolSize: 8,
        /*
         * Glassdoor fingerprints the request header shape, not just the TLS handshake.
         * Measured over 5 repeats each: impit's bare Chrome profile scored 0/5, adding only
         * accept-language scored 0/5, and adding this real Chrome navigation header scored 4/5.
         * Never override `accept` here: replacing Chrome's own value scored 0/5.
         */
        headers: { 'upgrade-insecure-requests': '1' },
    },
    isBlocked: (res) => res.status === 403 || /Attention Required|cf-browser-verification/i.test(res.body.slice(0, 3000)),

    async run({ input, sink, http }: SourceContext, queries: SearchQuery[]) {
        const cache = new Map<string, GlassdoorLocation | null>();

        /** Resolve a free-text location to Glassdoor's own ids. One cheap request per unique name. */
        const resolveLocation = async (name: string, sessionKey: string): Promise<GlassdoorLocation | null> => {
            const key = name.trim().toLowerCase();
            if (!key) return null;
            if (cache.has(key)) return cache.get(key)!;
            let found: GlassdoorLocation | null = null;
            try {
                const url = `${AUTOCOMPLETE_URL}?term=${encodeURIComponent(name)}&locationTypeFilters=CITY,STATE,COUNTRY`;
                // No custom Accept header: impit sends Chrome's own, and anything else is a
                // signal to Cloudflare. The endpoint returns JSON regardless.
                const res = await http.fetch(url, {}, sessionKey);
                const rows = JSON.parse(res.body) as GlassdoorLocation[];
                const hit = rows?.[0];
                if (hit?.locationId && hit?.locationType) {
                    found = { locationId: hit.locationId, locationType: hit.locationType, locationName: hit.locationName };
                    log.info(`Glassdoor: "${name}" -> ${found.locationName} (${found.locationType}${found.locationId})`);
                } else {
                    log.warning(`Glassdoor: no location match for "${name}"; searching without a location filter.`);
                }
            } catch (err) {
                log.warning(`Glassdoor: could not resolve location "${name}": ${(err as Error).message}`);
            }
            cache.set(key, found);
            return found;
        };

        const maxAgeDays = POSTED_WITHIN_DAYS[input.postedWithin];
        const wantWork = new Set(input.workType);
        const wantType = new Set(input.jobType);

        await forEachLimit(queries, QUERY_CONCURRENCY, async (query) => {
            // All requests for one query share a session, so Glassdoor's paging state holds.
            const sessionKey = `${query.keyword}|${query.location}`;
            const loc = await resolveLocation(query.location, sessionKey);
            for (let page = 1; page <= MAX_PAGES && !sink.isFull('glassdoor'); page++) {
                const res = await http.fetch(buildSearchUrl(query, loc, page), {}, sessionKey);
                const rows = extractListings(res.body);
                if (!rows.length) break;

                let fresh = 0;
                for (const row of rows) {
                    const job = mapListing(row, query);
                    if (!job) continue;
                    /*
                     * Glassdoor's own filter params for age, work type and job type are not
                     * verified, and sending a wrong one silently returns the wrong result set.
                     * The embedded payload already tells us these exactly, so we filter here.
                     */
                    if (maxAgeDays != null && job.postedAtRaw) {
                        const age = Number.parseInt(job.postedAtRaw, 10);
                        if (Number.isFinite(age) && age > maxAgeDays) continue;
                    }
                    if (wantWork.size && (!job.workType || !wantWork.has(job.workType))) continue;
                    if (wantType.size && (!job.jobType || !wantType.has(job.jobType as JobType))) continue;

                    if (!sink.claim(job)) continue;
                    fresh++;
                    await sink.push(job);
                }
                if (!fresh) break;
            }
        }, (err, query) => {
            const level = err instanceof BlockedError ? 'warning' : 'error';
            log[level](`Glassdoor search "${query.keyword}" in "${query.location}" stopped: ${(err as Error).message}`);
        });
    },
};
