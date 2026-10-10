import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSearchUrl, classifyAttributes, extractListings, flightPayload, mapListing } from '../src/sources/glassdoor.js';

/*
 * Run against a REAL 937 KB Glassdoor search page captured through a residential proxy
 * (test/fixtures/glassdoor/search.html). We parse the embedded React Server Component
 * payload, not the rendered cards, because the card class names are hashed per deploy.
 */
const html = readFileSync('test/fixtures/glassdoor/search.html', 'utf8');
const query = { keyword: 'react developer', location: 'United States' };

describe('flightPayload', () => {
    it('reassembles the streamed RSC chunks', () => {
        const payload = flightPayload(html);
        expect(payload.length).toBeGreaterThan(100_000);
        // A value we know straddles the chunked stream.
        expect(payload).toContain('"jobListings":[');
    });
});

describe('extractListings', () => {
    const rows = extractListings(html);

    it('finds the full page of listings', () => {
        expect(rows).toHaveLength(30);
    });

    it('returns an empty array rather than throwing on unrelated HTML', () => {
        expect(extractListings('<html><body>no jobs here</body></html>')).toEqual([]);
        expect(extractListings('')).toEqual([]);
    });
});

describe('mapListing', () => {
    const rows = extractListings(html);
    // Fixed clock so postedAt is deterministic.
    const now = Date.parse('2026-10-10T00:00:00.000Z');
    const jobs = rows.map((r) => mapListing(r, query, now)).filter((j) => j !== null);

    it('maps every listing on the page', () => {
        expect(jobs).toHaveLength(30);
    });

    it('fills the core fields on every job', () => {
        for (const job of jobs) {
            expect(job!.title).toBeTruthy();
            expect(job!.company).toBeTruthy();
            expect(job!.location).toBeTruthy();
            expect(job!.id).toBe(`glassdoor:${job!.sourceJobId}`);
            expect(job!.url).toMatch(/^https:\/\/www\.glassdoor\.com\//);
            expect(job!.url).not.toContain('?'); // tracking stripped
        }
    });

    it('derives postedAt from ageInDays', () => {
        const first = jobs[0]!;
        expect(first.postedAtRaw).toBe('141d');
        expect(first.postedAt).toBe('2026-05-22T00:00:00.000Z');
    });

    it('reads the company rating, which LinkedIn never provides', () => {
        expect(jobs[0]!.companyRating).toBe(4);
        expect(jobs.filter((j) => j!.companyRating != null).length).toBeGreaterThan(20);
    });

    it('parses pay percentiles and records whether the employer stated them', () => {
        const paid = jobs.find((j) => j!.salary);
        expect(paid!.salary).toMatchObject({ min: 75, max: 150, currency: 'USD', period: 'hour' });
        expect(paid!.salary!.source).toBe('EMPLOYER_PROVIDED');
    });

    it('extracts skills', () => {
        expect(jobs[0]!.skills).toContain('Go');
        expect(jobs[0]!.skills).toContain('C#');
    });

    it('does not file perks or pay mechanics as skills', () => {
        for (const job of jobs) {
            for (const skill of job!.skills) {
                expect(skill).not.toMatch(/401\(k\)|insurance|paid time off|hourly pay/i);
            }
        }
    });

    it('skips a listing with no id or title instead of emitting a broken row', () => {
        expect(mapListing({ jobview: { header: {}, job: {} } }, query, now)).toBeNull();
        expect(mapListing({}, query, now)).toBeNull();
        expect(mapListing(null, query, now)).toBeNull();
    });
});

describe('classifyAttributes', () => {
    it('separates job type, work type, level and skills', () => {
        const out = classifyAttributes(['Full-time', 'Remote', 'Mid-level', 'TypeScript', '401(k) matching', 'Health insurance']);
        expect(out.jobType).toBe('full-time');
        expect(out.workType).toBe('remote');
        expect(out.experienceLevel).toBe('Mid-level');
        expect(out.skills).toEqual(['TypeScript']);
    });

    it('maps in-person to onsite', () => {
        expect(classifyAttributes(['In-person']).workType).toBe('onsite');
    });
});

describe('buildSearchUrl', () => {
    it('sends Glassdoor its own location ids, which is the only filter that works', () => {
        const loc = { locationId: 2_940_587, locationType: 'C', locationName: 'Bengaluru' };
        const url = new URL(buildSearchUrl({ keyword: 'react developer', location: 'Bangalore' }, loc, 3));
        expect(url.searchParams.get('sc.keyword')).toBe('react developer');
        expect(url.searchParams.get('locT')).toBe('C');
        expect(url.searchParams.get('locId')).toBe('2940587');
        expect(url.searchParams.get('p')).toBe('3');
    });

    it('omits the location filter when the name could not be resolved, and p on page 1', () => {
        const url = new URL(buildSearchUrl(query, null, 1));
        expect(url.searchParams.has('locT')).toBe(false);
        expect(url.searchParams.has('p')).toBe(false);
    });
});

describe('salary formatting', () => {
    const rows = extractListings(html);
    const jobs = rows.map((r) => mapListing(r, query, Date.parse('2026-10-10T00:00:00.000Z')));

    it('writes a readable raw string with separators', () => {
        const paid = jobs.find((j) => j?.salary);
        expect(paid!.salary!.raw).toBe('USD 75 - USD 150 per hour');
    });
});
