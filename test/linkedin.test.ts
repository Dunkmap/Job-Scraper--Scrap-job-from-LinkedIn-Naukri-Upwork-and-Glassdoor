import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSearchUrl, parseDetail, parseSearch } from '../src/sources/linkedin.js';
import type { Input } from '../src/types.js';

/*
 * These run against REAL responses captured from LinkedIn's guest endpoints
 * (test/fixtures/linkedin/, refreshed with `node tools/recon-linkedin.mjs`).
 * If LinkedIn changes its markup, these fail in CI instead of the Actor silently
 * returning rows of nulls to paying users.
 */
const fixture = (name: string) => readFileSync(`test/fixtures/linkedin/${name}.html`, 'utf8');

const input: Input = {
    keywords: ['react developer'], locations: ['India'], sources: ['linkedin'], maxItemsPerSource: 10,
    postedWithin: 'week', workType: ['remote'], jobType: ['full-time', 'contract'], experienceLevel: ['entry'],
    fetchDetails: false, onlyNewJobs: false, dedupeAcrossSources: true, includeDescriptionHtml: false,
};
const query = { keyword: 'react developer', location: 'India' };

describe('buildSearchUrl', () => {
    it('maps filters to LinkedIn params', () => {
        const url = new URL(buildSearchUrl(input, query, 20));
        expect(url.searchParams.get('f_TPR')).toBe('r604800');
        expect(url.searchParams.get('f_WT')).toBe('2');
        expect(url.searchParams.get('f_JT')).toBe('F,C');
        expect(url.searchParams.get('f_E')).toBe('2');
        expect(url.searchParams.get('start')).toBe('20');
        expect(url.searchParams.get('sortBy')).toBe('DD');
    });
});

describe('parseSearch (real fixture)', () => {
    const { jobs, cards } = parseSearch(fixture('search'), query, input);

    it('parses every card on the page', () => {
        expect(cards).toBe(10);
        expect(jobs).toHaveLength(10);
    });

    it('fills every core field on every job', () => {
        for (const job of jobs) {
            expect(job.title).toBeTruthy();
            expect(job.company).toBeTruthy();
            expect(job.sourceJobId).toMatch(/^\d{6,}$/);
            expect(job.url).toMatch(/^https:\/\/[a-z.]*linkedin\.com\/jobs\/view\//);
            expect(job.companyUrl).toMatch(/^https:\/\//);
            expect(job.location).toBeTruthy();
            expect(job.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(job.id).toBe(`linkedin:${job.sourceJobId}`);
        }
    });

    it('strips tracking params from URLs', () => {
        for (const job of jobs) expect(job.url).not.toContain('?');
    });

    it('reads the listing badges', () => {
        // Both are plain booleans: the badge is either shown or it is not.
        expect(jobs.filter((j) => j.activelyHiring)).not.toHaveLength(0);
        for (const job of jobs) {
            expect(typeof job.activelyHiring).toBe('boolean');
            expect(typeof job.earlyApplicant).toBe('boolean');
        }
    });

    it('leaves work type null when neither the card nor the filter settles it', () => {
        // Cards here say nothing about remote/hybrid. With no single work-type filter to lean on,
        // the field must stay null rather than being guessed.
        const noFilter = { ...input, workType: [] };
        const { jobs: unfiltered } = parseSearch(fixture('search'), query, noFilter);
        expect(unfiltered.every((j) => j.workType === null)).toBe(true);
    });

    it('trusts a single work-type filter, since LinkedIn applied it server-side', () => {
        // input filters f_WT=remote, so every returned job really is remote.
        expect(jobs.every((j) => j.workType === 'remote')).toBe(true);
    });
});

describe('parseDetail (real fixture)', () => {
    const [job] = parseSearch(fixture('search'), query, input).jobs;
    const full = parseDetail(fixture('detail'), job!);

    it('extracts the description as text and HTML', () => {
        expect(full.description!.length).toBeGreaterThan(500);
        expect(full.description).toContain('• '); // bullets preserved
        expect(full.description).not.toContain('<');
        expect(full.descriptionHtml).toContain('<');
        expect(full.detailsFetched).toBe(true);
    });

    it('extracts job criteria, skipping LinkedIn "Not Applicable" placeholders', () => {
        expect(full.jobType).toBe('Full-time');
        expect(full.industry).toBe('IT Services and IT Consulting');
        expect(full.experienceLevel).toBeNull();
    });

    it('detects off-site apply as not Easy Apply', () => {
        expect(full.easyApply).toBe(false);
    });

    it('recovers required experience from the description', () => {
        expect(full.experienceYears).toEqual({ min: 1, max: 2 });
    });

    it('does not infer work type from perks mentioned in the description', () => {
        // This posting states fixed office hours but mentions "remote working opportunities".
        // Parsed with no work-type filter, the field must stay null instead of guessing "remote".
        const [plain] = parseSearch(fixture('search'), query, { ...input, workType: [] }).jobs;
        expect(parseDetail(fixture('detail'), plain!).workType).toBeNull();
    });

    it('reads the applicant count', () => {
        expect(full.applicants).toBe(200);
    });
});

describe('parseDetail (real US fixture with published pay)', () => {
    const q = { keyword: 'software engineer', location: 'United States' };
    const [job] = parseSearch(fixture('search-us'), q, input).jobs;
    const full = parseDetail(fixture('detail-us'), job!);

    it('parses the base pay range without repeating it in raw', () => {
        expect(full.salary).toMatchObject({ min: 123_500, max: 150_000, currency: 'USD', period: 'year' });
        expect(full.salary!.raw).toBe('$123,500.00/yr - $150,000.00/yr');
    });
});
