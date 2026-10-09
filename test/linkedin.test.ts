import { describe, expect, it } from 'vitest';
import { buildSearchUrl, parseDetail, parseSearch } from '../src/sources/linkedin.js';
import type { Input } from '../src/types.js';

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
    });
});

// SYNTHETIC markup modelled on LinkedIn's guest fragments. Replace with real captured
// fixtures (test/fixtures/linkedin/) during Phase 0 recon.
const SEARCH_HTML = `
<li><div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:4012345678">
  <a class="base-card__full-link" href="https://in.linkedin.com/jobs/view/react-developer-at-acme-4012345678?position=1&refId=x"></a>
  <img data-delayed-url="https://media.licdn.com/logo.png">
  <h3 class="base-search-card__title"> React Developer </h3>
  <h4 class="base-search-card__subtitle"><a href="https://in.linkedin.com/company/acme?trk=x">Acme</a></h4>
  <span class="job-search-card__location">Bengaluru, Karnataka, India</span>
  <span class="job-search-card__salary-info">₹10L - ₹15L</span>
  <time datetime="2026-10-05">4 days ago</time>
</div></li>
<li><div class="base-card"><h3 class="base-search-card__title"></h3></div></li>`;

describe('parseSearch', () => {
    it('extracts basic jobs and skips broken cards', () => {
        const jobs = parseSearch(SEARCH_HTML, query, input);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
            id: 'linkedin:4012345678', title: 'React Developer', company: 'Acme',
            url: 'https://in.linkedin.com/jobs/view/react-developer-at-acme-4012345678',
            companyUrl: 'https://in.linkedin.com/company/acme', location: 'Bengaluru, Karnataka, India',
            workType: 'remote', postedAt: '2026-10-05T00:00:00.000Z', salary: { min: 1000000, max: 1500000, currency: 'INR' },
        });
    });
});

const DETAIL_HTML = `
<div class="show-more-less-html__markup"><p>Build UIs.</p><ul><li>React</li><li>TypeScript</li></ul></div>
<span class="num-applicants__caption">Over 200 applicants</span>
<code id="applyUrl" style="display: none"><!--"https://www.linkedin.com/jobs/view/externalApply/4012345678?url=https%3A%2F%2Fcareers%2Eacme%2Ecom%2Fjobs%2F1&amp;urlHash=x"--></code>
<ul class="description__job-criteria-list">
  <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader">Seniority level</h3><span class="description__job-criteria-text">Entry level</span></li>
  <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader">Employment type</h3><span class="description__job-criteria-text">Full-time</span></li>
  <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader">Industries</h3><span class="description__job-criteria-text">Software Development</span></li>
</ul>`;

describe('parseDetail', () => {
    it('merges detail fields', () => {
        const [job] = parseSearch(SEARCH_HTML, query, input);
        const full = parseDetail(DETAIL_HTML, job!);
        expect(full).toMatchObject({
            detailsFetched: true, applicants: 200, applyUrl: 'https://careers.acme.com/jobs/1', easyApply: false,
            experienceLevel: 'Entry level', jobType: 'Full-time', industry: 'Software Development',
        });
        expect(full.description).toContain('• React');
    });
});
