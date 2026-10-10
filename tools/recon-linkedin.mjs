/**
 * Recon + fixture capture for LinkedIn guest endpoints.
 *
 * Saves real responses to test/fixtures/linkedin/ and prints the numbers
 * docs/cost-benchmarks.md needs (decoded bytes per job) plus a selector audit,
 * so a markup change shows up as MISS instead of as silently empty output.
 *
 *   node tools/recon-linkedin.mjs ["keywords"] ["location"]
 *   APIFY_PROXY_URL=http://... node tools/recon-linkedin.mjs   # route via proxy
 */
import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const KEYWORDS = process.argv[2] ?? 'react developer';
const LOCATION = process.argv[3] ?? 'India';
const OUT = 'test/fixtures/linkedin';
mkdirSync(OUT, { recursive: true });

const imp = new Impit({
    browser: 'chrome',
    timeout: 25_000,
    cookieJar: new CookieJar(),
    proxyUrl: process.env.APIFY_PROXY_URL || undefined,
    headers: { 'accept-language': 'en-US,en;q=0.9' },
});

const warmUrl = `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(KEYWORDS)}&location=${encodeURIComponent(LOCATION)}`;

async function get(url, label, save = true) {
    const t = Date.now();
    const res = await imp.fetch(url, { headers: { referer: warmUrl } });
    const buf = Buffer.from(await res.bytes());
    const gz = gzipSync(buf).byteLength;
    console.log(`${label}: HTTP ${res.status}  ${buf.byteLength}B decoded / ~${gz}B gzip  ${Date.now() - t}ms`);
    if (res.url !== url) console.log(`  redirected -> ${res.url}`);
    if (save) writeFileSync(`${OUT}/${label}.html`, buf);
    return { status: res.status, body: buf.toString('utf8'), bytes: buf.byteLength, gz };
}

function audit(body, selectors, label) {
    console.log(`  -- ${label} selector audit --`);
    let missing = 0;
    for (const sel of selectors) {
        const n = body.split(sel).length - 1;
        if (!n) missing++;
        console.log(`  ${n ? 'OK  ' : 'MISS'} ${sel}${n ? ` x${n}` : ''}`);
    }
    if (missing) console.log(`  ${missing} selector(s) MISSING -> parser needs updating`);
    return missing;
}

// Warm cookies on the public page first: the guest API 429s much sooner without them.
await get(warmUrl, 'warmup', false);

const params = new URLSearchParams({ keywords: KEYWORDS, location: LOCATION, start: '0', sortBy: 'DD' });
const s = await get(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`, 'search');
const ids = [...s.body.matchAll(/jobPosting:(\d+)/g)].map((m) => m[1]);
const cards = (s.body.match(/<li[\s>]/g) ?? []).length;
console.log(`  cards=${cards} ids=${ids.length}  bytes/job=${ids.length ? Math.round(s.bytes / ids.length) : 'n/a'} decoded,`
    + ` ~${ids.length ? Math.round(s.gz / ids.length) : 'n/a'} gzip`);

audit(s.body, ['base-card', 'job-search-card', 'base-search-card__title', 'base-search-card__subtitle',
    'job-search-card__location', 'base-card__full-link', 'job-search-card__salary-info',
    'job-posting-benefits__text', 'data-entity-urn', '<time', 'data-delayed-url'], 'search');

if (ids[0]) {
    const d = await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${ids[0]}`, 'detail');
    console.log(`  detail bytes/job=${d.bytes} decoded, ~${d.gz} gzip`);
    audit(d.body, ['show-more-less-html__markup', 'description__job-criteria-item',
        'description__job-criteria-subheader', 'description__job-criteria-text', 'num-applicants__caption',
        'id="applyUrl"', 'topcard__org-name-link', 'compensation__salary', 'posted-time-ago__text',
        'topcard__flavor--bullet'], 'detail');
}
