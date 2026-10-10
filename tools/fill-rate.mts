/**
 * Run the real parsers over captured fixtures and report field fill rates.
 * This is the guard against "it runs but returns empty columns", which is what
 * actually loses Store users.
 *
 *   npx tsx tools/fill-rate.mts
 */
import { readFileSync } from 'node:fs';
import { parseDetail, parseSearch } from '../src/sources/linkedin.js';
import type { Input, Job } from '../src/types.js';

const input = {
    keywords: ['react developer'], locations: ['India'], sources: ['linkedin'], maxItemsPerSource: 50,
    postedWithin: 'any', workType: [], jobType: [], experienceLevel: [],
    fetchDetails: true, onlyNewJobs: false, dedupeAcrossSources: true, includeDescriptionHtml: true,
} as Input;
const query = { keyword: 'react developer', location: 'India' };

const { jobs, cards } = parseSearch(readFileSync('test/fixtures/linkedin/search.html', 'utf8'), query, input);
console.log(`parseSearch -> ${jobs.length} jobs from ${cards} cards`);

function fill(rows: Job[], keys: (keyof Job)[], label: string) {
    console.log(`\n=== ${label} (n=${rows.length}) ===`);
    for (const k of keys) {
        const n = rows.filter((r) => {
            const v = r[k];
            return v != null && !(Array.isArray(v) && v.length === 0);
        }).length;
        const pct = Math.round((n / rows.length) * 100);
        console.log(`  ${String(pct).padStart(3)}%  ${k}`);
    }
}

fill(jobs, ['title', 'company', 'companyUrl', 'companyLogo', 'location', 'url', 'sourceJobId',
    'postedAt', 'postedAtRaw', 'salary', 'workType', 'activelyHiring', 'earlyApplicant'], 'search fill rates');

const full = parseDetail(readFileSync('test/fixtures/linkedin/detail.html', 'utf8'), jobs[0]!);
fill([full], ['description', 'descriptionHtml', 'applyUrl', 'easyApply', 'applicants', 'jobType',
    'experienceLevel', 'experienceYears', 'industry', 'jobFunction', 'salary'], 'detail fill (1 job)');

console.log('\n=== detail values ===');
console.log(JSON.stringify({
    applicants: full.applicants, easyApply: full.easyApply, applyUrl: full.applyUrl,
    jobType: full.jobType, experienceLevel: full.experienceLevel, experienceYears: full.experienceYears,
    industry: full.industry, workType: full.workType, detailsFetched: full.detailsFetched,
    description: full.description ? `${full.description.length} chars` : null,
}, null, 1));
