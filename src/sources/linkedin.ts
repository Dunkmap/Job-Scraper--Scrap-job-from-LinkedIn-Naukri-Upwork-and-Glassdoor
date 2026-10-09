import { log } from 'apify';
import * as cheerio from 'cheerio';
import { BlockedError } from '../core/http.js';
import { clean, cleanUrl, makeJob, parseCount, parseRelativeDate, parseSalary } from '../core/normalize.js';
import { forEachLimit, Semaphore } from '../core/pool.js';
import type { Input, Job, SearchQuery, WorkType } from '../types.js';
import type { Source, SourceContext } from './source.js';

/*
 * LinkedIn's logged-out ("guest") endpoints. They return small HTML fragments instead of full
 * pages: ~10 job cards per search request, and one fragment per job detail.
 *
 * Selectors verified against live guest responses in Phase 0 recon (2026-10-09). Guest detail
 * pages no longer include the external apply URL or the "Job function" criterion.
 */
const SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DETAIL_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
/** LinkedIn stops returning results after ~1,000 per query. */
const MAX_START = 1000;
/** Stop paginating a query after this many pages in a row without a single new job. */
const MAX_EMPTY_PAGES = 3;
const QUERY_CONCURRENCY = 3;
const DETAIL_CONCURRENCY = 8;

const TPR = { '24h': 'r86400', week: 'r604800', month: 'r2592000', any: null } as const;
const WT: Record<WorkType, string> = { onsite: '1', remote: '2', hybrid: '3' };
const JT: Record<string, string> = { 'full-time': 'F', 'part-time': 'P', contract: 'C', temporary: 'T', internship: 'I' };
const EXP: Record<string, string> = { internship: '1', entry: '2', associate: '3', 'mid-senior': '4', director: '5', executive: '6' };

export function buildSearchUrl(input: Input, query: SearchQuery, start: number): string {
    const params = new URLSearchParams({ keywords: query.keyword, location: query.location, start: String(start) });
    const tpr = TPR[input.postedWithin];
    if (tpr) params.set('f_TPR', tpr);
    if (input.workType.length) params.set('f_WT', input.workType.map((w) => WT[w]).join(','));
    if (input.jobType.length) params.set('f_JT', input.jobType.map((j) => JT[j]).filter(Boolean).join(','));
    if (input.experienceLevel.length) params.set('f_E', input.experienceLevel.map((e) => EXP[e]).filter(Boolean).join(','));
    // Newest first: the most valuable jobs come first, so users hitting maxItems get fresh results.
    params.set('sortBy', 'DD');
    return `${SEARCH_URL}?${params}`;
}

function workTypeFromText(text: string | null): WorkType | null {
    if (!text) return null;
    if (/\bremote\b/i.test(text)) return 'remote';
    if (/\bhybrid\b/i.test(text)) return 'hybrid';
    if (/\bon-?site\b/i.test(text)) return 'onsite';
    return null;
}

/** Parse a search-results fragment into basic jobs. */
export function parseSearch(html: string, query: SearchQuery, input: Input): Job[] {
    const $ = cheerio.load(html);
    const jobs: Job[] = [];
    $('li').each((_, li) => {
        const card = $(li).find('.base-card, .job-search-card').first();
        const root = card.length ? card : $(li);
        const urn = root.attr('data-entity-urn') ?? $(li).find('[data-entity-urn]').attr('data-entity-urn') ?? '';
        const href = root.find('a.base-card__full-link').attr('href') ?? root.find('a[href*="/jobs/view/"]').attr('href') ?? '';
        const id = urn.match(/jobPosting:(\d+)/)?.[1] ?? href.match(/(\d{6,})(?:\?|\/|$)/)?.[1];
        const title = clean(root.find('.base-search-card__title').text());
        if (!id || !title) return;

        const location = clean(root.find('.job-search-card__location').text());
        const timeEl = root.find('time').first();
        const postedAtRaw = clean(timeEl.text());
        const datetime = timeEl.attr('datetime');
        const companyLink = root.find('.base-search-card__subtitle a').first();
        const benefits = clean(root.find('.job-posting-benefits__text').text());

        jobs.push(makeJob({
            source: 'linkedin',
            sourceJobId: id,
            url: cleanUrl(href) ?? `https://www.linkedin.com/jobs/view/${id}/`,
            title,
            company: clean(companyLink.text()) ?? clean(root.find('.base-search-card__subtitle').text()),
            companyUrl: cleanUrl(companyLink.attr('href')),
            companyLogo: root.find('img').attr('data-delayed-url') ?? null,
            location,
            workType: input.workType.length === 1 ? input.workType[0]! : workTypeFromText(location),
            salary: parseSalary(root.find('.job-search-card__salary-info').text()),
            postedAt: datetime ? new Date(datetime).toISOString() : parseRelativeDate(postedAtRaw),
            postedAtRaw,
            easyApply: benefits ? /easy apply/i.test(benefits) || null : null,
            searchKeyword: query.keyword,
            searchLocation: query.location,
        }));
    });
    return jobs;
}

/** Parse a job-detail fragment and merge it into the basic job. */
export function parseDetail(html: string, job: Job): Job {
    const $ = cheerio.load(html);
    const criteria: Record<string, string> = {};
    $('.description__job-criteria-item').each((_, el) => {
        const key = clean($(el).find('.description__job-criteria-subheader').text())?.toLowerCase();
        const value = clean($(el).find('.description__job-criteria-text').text());
        if (key && value) criteria[key] = value;
    });

    const descEl = $('.show-more-less-html__markup').first();
    const descriptionHtml = descEl.html()?.trim() || null;
    // Keep line breaks so the plain-text description stays readable.
    descEl.find('br').replaceWith('\n');
    descEl.find('li').each((_, li) => { $(li).prepend('• ').append('\n'); });
    descEl.find('p, ul, ol').each((_, p) => { $(p).append('\n'); });
    const description = descEl.text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim() || null;

    // The external apply URL is stored inside an HTML comment in <code id="applyUrl">.
    const applyRaw = $('code#applyUrl').html()?.match(/"(https?:[^"]+)"/)?.[1] ?? null;
    let applyUrl: string | null = null;
    if (applyRaw) {
        try {
            const inner = new URL(applyRaw.replace(/&amp;/g, '&')).searchParams.get('url');
            applyUrl = inner ?? applyRaw;
        } catch { applyUrl = applyRaw; }
    }

    // Guests no longer get the external URL; the apply button's tracking name still tells
    // "onsite" (Easy Apply) from "offsite" (company site).
    const onsite = $('[data-tracking-control-name="public_jobs_apply-link-onsite"]').length > 0;
    const offsite = $('[data-tracking-control-name^="public_jobs_apply-link-offsite"], [data-impression-id^="public_jobs_apply-link-offsite"]').length > 0;

    const applicantsText = clean($('.num-applicants__caption').text()) ?? clean($('figcaption.num-applicants__caption').text());
    const salary = parseSalary($('.compensation__salary').text()) ?? job.salary;

    return {
        ...job,
        company: job.company ?? clean($('a.topcard__org-name-link').text()),
        location: job.location ?? clean($('.topcard__flavor--bullet').first().text()),
        description,
        descriptionHtml,
        applyUrl,
        easyApply: onsite ? true : applyUrl || offsite ? false : job.easyApply,
        applicants: parseCount(applicantsText),
        salary,
        experienceLevel: criteria['seniority level'] ?? null,
        jobType: criteria['employment type'] ?? null,
        jobFunction: criteria['job function'] ?? null,
        industry: criteria['industries'] ?? null,
        postedAtRaw: job.postedAtRaw ?? clean($('.posted-time-ago__text').text()),
        detailsFetched: description != null,
    };
}

export const linkedin: Source = {
    name: 'linkedin',
    isBlocked: (res) => /authwall|\/checkpoint\//i.test(res.url),

    async run({ input, sink, http }: SourceContext, queries: SearchQuery[]) {
        const details = new Semaphore(DETAIL_CONCURRENCY);
        const pending: Promise<void>[] = [];

        const enrich = async (job: Job) => {
            try {
                const res = await details.run(() => http.fetch(DETAIL_URL + job.sourceJobId));
                await sink.push(parseDetail(res.body, job));
            } catch (err) {
                // Still deliver the basic job; it's charged as a basic job, not a detailed one.
                log.debug(`LinkedIn detail failed for ${job.sourceJobId}: ${(err as Error).message}`);
                await sink.push(job);
            }
        };

        await forEachLimit(queries, QUERY_CONCURRENCY, async (query) => {
            let emptyPages = 0;
            for (let start = 0; start < MAX_START && !sink.isFull('linkedin'); ) {
                const res = await http.fetch(buildSearchUrl(input, query, start));
                const jobs = parseSearch(res.body, query, input);
                if (!jobs.length) break;
                start += jobs.length;

                let fresh = 0;
                for (const job of jobs) {
                    if (!sink.claim(job)) continue;
                    fresh++;
                    if (input.fetchDetails) pending.push(enrich(job));
                    else await sink.push(job);
                }
                emptyPages = fresh ? 0 : emptyPages + 1;
                if (emptyPages >= MAX_EMPTY_PAGES) break;
            }
        }, (err, query) => {
            const level = err instanceof BlockedError ? 'warning' : 'error';
            log[level](`LinkedIn search "${query.keyword}" in "${query.location}" stopped: ${(err as Error).message}`);
        });

        await Promise.all(pending);
    },
};
