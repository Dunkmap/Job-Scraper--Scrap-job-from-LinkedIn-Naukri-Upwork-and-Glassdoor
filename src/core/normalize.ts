import type { Job, Salary, SourceName } from '../types.js';

/** Collapse whitespace and trim. Returns null for empty strings. */
export function clean(text: string | null | undefined): string | null {
    if (text == null) return null;
    const out = text.replace(/\s+/g, ' ').trim();
    return out.length ? out : null;
}

/** Strip tracking query params so the same job always has the same URL (and so outputs are smaller). */
export function cleanUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.toString();
    } catch {
        return null;
    }
}

const CURRENCY_SYMBOLS: Record<string, string> = { '₹': 'INR', '$': 'USD', '€': 'EUR', '£': 'GBP' };

function parseAmount(num: string, suffix: string | undefined): number {
    const n = Number(num.replace(/,/g, ''));
    const s = (suffix ?? '').toLowerCase();
    if (s === 'k') return n * 1_000;
    if (s === 'm' || s === 'mn') return n * 1_000_000;
    if (s === 'l' || s === 'lac' || s === 'lakh' || s === 'lakhs' || s === 'lacs') return n * 100_000;
    if (s === 'cr' || s === 'crore') return n * 10_000_000;
    return n;
}

/**
 * Best-effort salary parser for strings like "$120,000.00/yr - $150,000.00/yr", "₹ 5-8 Lacs P.A.",
 * "€50K - €70K (Employer est.)". Always keeps the raw text.
 */
export function parseSalary(raw: string | null | undefined): Salary | null {
    const text = clean(raw);
    if (!text) return null;
    let currency: string | null = null;
    for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
        if (text.includes(sym)) { currency = code; break; }
    }
    const code = text.match(/\b(INR|USD|EUR|GBP|CAD|AUD|SGD|AED)\b/i);
    if (!currency && code) currency = code[1]!.toUpperCase();
    if (!currency && /\b(lacs?|lakhs?|crores?|p\.?a\.?)\b/i.test(text)) currency = 'INR';

    const lower = text.toLowerCase();
    let period: Salary['period'] = null;
    if (/\/\s*(hr|hour)|per hour|hourly/.test(lower)) period = 'hour';
    else if (/\/\s*day|per day|daily/.test(lower)) period = 'day';
    else if (/\/\s*(wk|week)|per week|weekly/.test(lower)) period = 'week';
    else if (/\/\s*(mo|month)|per month|monthly/.test(lower)) period = 'month';
    else if (/\/\s*(yr|year)|per year|annual|yearly|p\.?\s?a\.?|lacs?|lakhs?/.test(lower)) period = 'year';

    // Shared unit like "5-8 Lacs": the suffix after the last number applies to both.
    const nums = [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|m|mn|l|lacs?|lakhs?|cr|crore)?\b/gi)];
    if (!nums.length) return { min: null, max: null, currency, period, raw: text };
    const lastSuffix = nums[nums.length - 1]![2];
    const values = nums.slice(0, 2).map((m) => parseAmount(m[1]!, m[2] ?? lastSuffix));
    const min = values[0] ?? null;
    const max = values[1] ?? min;
    return { min, max, currency, period, raw: text };
}

/** Parse "2-5 Yrs", "3+ years" etc. */
export function parseExperienceYears(raw: string | null | undefined): Job['experienceYears'] {
    const text = clean(raw);
    if (!text) return null;
    const range = text.match(/(\d+)\s*-\s*(\d+)/);
    if (range) return { min: Number(range[1]), max: Number(range[2]) };
    const single = text.match(/(\d+)\s*\+?/);
    if (single) return { min: Number(single[1]), max: null };
    return null;
}

/** Convert "3 days ago", "1 week ago", "30+ days ago", "just now" into an ISO date (relative to `now`). */
export function parseRelativeDate(raw: string | null | undefined, now = new Date()): string | null {
    const text = clean(raw)?.toLowerCase();
    if (!text) return null;
    if (/just now|today|few hours|moments? ago/.test(text)) return now.toISOString();
    if (/yesterday/.test(text)) return new Date(now.getTime() - 86_400_000).toISOString();
    const m = text.match(/(\d+)\+?\s*(minute|min|hour|hr|day|d|week|wk|month|mo|year|yr)s?\b/);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2]!;
    const ms: Record<string, number> = {
        minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000, day: 86_400_000, d: 86_400_000,
        week: 604_800_000, wk: 604_800_000, month: 2_592_000_000, mo: 2_592_000_000, year: 31_536_000_000, yr: 31_536_000_000,
    };
    return new Date(now.getTime() - n * ms[unit]!).toISOString();
}

export function parseCount(raw: string | null | undefined): number | null {
    const m = clean(raw)?.replace(/,/g, '').match(/\d+/);
    return m ? Number(m[0]) : null;
}

/** Key used to detect the same job posted on several boards. */
export function crossSourceKey(job: Pick<Job, 'title' | 'company' | 'location'>): string {
    const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const city = norm(job.location).split(' ')[0] ?? '';
    return `${norm(job.title)}|${norm(job.company)}|${city}`;
}

/** Build a complete Job with every field present; sources only fill what they know. */
export function makeJob(
    base: Pick<Job, 'source' | 'sourceJobId' | 'url' | 'title' | 'searchKeyword' | 'searchLocation'> & Partial<Job>,
): Job {
    return {
        id: `${base.source}:${base.sourceJobId}`,
        applyUrl: null,
        company: null,
        companyUrl: null,
        companyLogo: null,
        companyRating: null,
        location: null,
        workType: null,
        jobType: null,
        experienceLevel: null,
        experienceYears: null,
        salary: null,
        skills: [],
        postedAt: null,
        postedAtRaw: null,
        applicants: null,
        easyApply: null,
        description: null,
        descriptionHtml: null,
        industry: null,
        jobFunction: null,
        detailsFetched: false,
        scrapedAt: new Date().toISOString(),
        ...base,
    } as Job;
}

export function sourceIdOf(id: string): { source: SourceName; sourceJobId: string } {
    const i = id.indexOf(':');
    return { source: id.slice(0, i) as SourceName, sourceJobId: id.slice(i + 1) };
}
