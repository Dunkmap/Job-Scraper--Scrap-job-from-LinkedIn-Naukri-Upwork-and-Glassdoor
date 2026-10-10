/**
 * Recon harness. Answers the questions that decide whether this Actor is profitable:
 *   1. block rate per proxy tier (datacenter vs residential)
 *   2. how many requests a single IP survives before the site cuts it off
 *   3. bytes per job, decoded and gzipped (gzip ~= what the proxy bills us)
 *   4. whether warming cookies on a public page raises the per-IP quota
 * It also saves raw bodies to the key-value store so parsers are built on real markup.
 */
import { Actor, log } from 'apify';
import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';
import { gzipSync } from 'node:zlib';

await Actor.init();
const {
    source = 'linkedin', keywords = 'react developer', location = 'India',
    requests = 12, concurrency = 4, sessions = 6, warm = true,
    proxyConfiguration = { useApifyProxy: true },
} = (await Actor.getInput()) ?? {};

const proxy = await Actor.createProxyConfiguration(proxyConfiguration);
log.info(`Recon ${source}: ${requests} requests over ${sessions} sessions, concurrency ${concurrency}, warm=${warm}`);

const TARGETS = {
    linkedin: {
        warmUrl: (kw, loc) => `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}`,
        searchUrl: (kw, loc, start) => 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?'
            + new URLSearchParams({ keywords: kw, location: loc, start: String(start), sortBy: 'DD' }),
        detailUrl: (id) => `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`,
        countJobs: (b) => new Set([...b.matchAll(/jobPosting:(\d+)/g)].map((m) => m[1])).size,
        firstId: (b) => b.match(/jobPosting:(\d+)/)?.[1] ?? null,
        step: 10,
    },
    naukri: {
        warmUrl: () => 'https://www.naukri.com/',
        searchUrl: (kw, loc, start) => 'https://www.naukri.com/jobapi/v3/search?'
            + new URLSearchParams({
                noOfResults: '20', urlType: 'search_by_keyword', searchType: 'adv',
                keyword: kw, location: loc, pageNo: String(Math.floor(start / 20) + 1),
            }),
        detailUrl: (id) => `https://www.naukri.com/jobapi/v4/job/${id}`,
        countJobs: (b) => { try { return (JSON.parse(b).jobDetails ?? []).length; } catch { return 0; } },
        firstId: (b) => { try { return JSON.parse(b).jobDetails?.[0]?.jobId ?? null; } catch { return null; } },
        step: 20,
        headers: { appid: '109', systemid: 'Naukri', 'content-type': 'application/json' },
    },
    glassdoor: {
        warmUrl: (kw) => `https://www.glassdoor.com/Job/${encodeURIComponent(kw.replace(/\s+/g, '-'))}-jobs-SRCH_KO0,20.htm`,
        searchUrl: (kw) => `https://www.glassdoor.com/Job/${encodeURIComponent(kw.replace(/\s+/g, '-'))}-jobs-SRCH_KO0,20.htm`,
        detailUrl: () => null,
        countJobs: (b) => (b.match(/data-test="job-link"/g) ?? []).length,
        firstId: (b) => b.match(/jobListingId\D{1,6}(\d+)/)?.[1] ?? null,
        step: 30,
    },
};
const T = TARGETS[source] ?? TARGETS.naukri;

/** One sticky proxy session = one IP, with its own cookie jar. */
async function makeSession(tier, n) {
    const id = `recon_${tier}_${n}`;
    const conf = tier === 'residential'
        ? await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: source === 'naukri' ? 'IN' : 'US' })
        : proxy;
    const pUrl = conf ? await conf.newUrl(id) : undefined;
    log.info(`[recon] ${tier} proxy: ${pUrl ? pUrl.replace(/:[^:@]*@/, ':<pw>@') : 'none'}`);
    return {
        id, tier, blockedAt: null, ok: 0, blocked: 0, failed: 0,
        impit: new Impit({
            browser: 'chrome',
            timeout: 30_000,
            proxyUrl: pUrl,
            cookieJar: new CookieJar(),
            headers: { 'accept-language': 'en-US,en;q=0.9', ...(T.headers ?? {}) },
        }),
    };
}

const isBlocked = (status, body, url) => status === 429 || status === 403 || status === 999 || status === 406
    || /authwall|\/checkpoint\//i.test(url) || /captcha|unusual traffic/i.test(body.slice(0, 2000));

async function hit(session, url, label) {
    const t = Date.now();
    try {
        const res = await session.impit.fetch(url, { headers: { referer: T.warmUrl(keywords, location) } });
        const buf = Buffer.from(await res.bytes());
        const body = buf.toString('utf8');
        const blocked = isBlocked(res.status, body, res.url);
        const rec = {
            label, session: session.id, tier: session.tier, status: res.status, blocked,
            bytes: buf.byteLength, gzip: gzipSync(buf).byteLength, ms: Date.now() - t,
            jobs: blocked ? 0 : T.countJobs(body),
        };
        if (blocked) {
            session.blocked++;
            // Record how many good requests this IP managed before being cut off.
            if (session.blockedAt == null) session.blockedAt = session.ok;
        } else session.ok++;
        return { rec, body };
    } catch (err) {
        session.failed++;
        return {
            rec: {
                label, session: session.id, tier: session.tier, status: 0, blocked: false,
                error: String(err.message).slice(0, 150), bytes: 0, gzip: 0, ms: Date.now() - t, jobs: 0,
            },
            body: '',
        };
    }
}

/*
 * Naukri returns HTTP 406 to its own JSON API even from a residential IP that just loaded the
 * homepage successfully, so cookies alone are not the gate. This probe walks header and endpoint
 * variants on one warmed session and reports which combination returns real data, including the
 * plain HTML search page as a no-API fallback.
 */
if (source === 'naukri-probe') {
    const s = await makeSession('residential', 0);
    const home = await s.impit.fetch('https://www.naukri.com/');
    log.info(`homepage: ${home.status} (${Buffer.from(await home.bytes()).byteLength}B)`);

    const kw = keywords.replace(/\s+/g, '-');
    const loc = location.replace(/\s+/g, '-');
    const apiV3 = `https://www.naukri.com/jobapi/v3/search?${new URLSearchParams({
        noOfResults: '20', urlType: 'search_by_key_loc', searchType: 'adv', keyword: keywords, location,
        pageNo: '1', k: keywords, l: location, seoKey: `${kw}-jobs-in-${loc}`, src: 'jobsearchDesk', latLong: '',
    })}`;
    const htmlUrl = `https://www.naukri.com/${kw}-jobs-in-${loc}`;

    const base = { appid: '109', systemid: 'Naukri' };
    const variants = [
        ['api: appid+systemid', apiV3, base],
        ['api: systemid=109', apiV3, { appid: '109', systemid: '109' }],
        ['api: +json accept', apiV3, { ...base, accept: 'application/json' }],
        ['api: +referer+xhr', apiV3, { ...base, accept: 'application/json', referer: htmlUrl, 'x-requested-with': 'XMLHttpRequest' }],
        ['api: +clientid', apiV3, { ...base, accept: 'application/json', referer: htmlUrl, clientid: 'd3skt0p' }],
        ['api: no custom headers', apiV3, {}],
        ['html search page', htmlUrl, { accept: 'text/html' }],
    ];

    for (const [label, url, headers] of variants) {
        try {
            const res = await s.impit.fetch(url, { headers });
            const buf = Buffer.from(await res.bytes());
            const body = buf.toString('utf8');
            let found = 0;
            try { found = (JSON.parse(body).jobDetails ?? []).length; } catch { /* html */ }
            // The HTML page embeds the same job data as JSON in a __NEXT_DATA__/window blob.
            const embedded = /__NEXT_DATA__|window\.__INITIAL|"jobDetails"|"jobId"/.test(body);
            log.info(`${label.padEnd(24)} ${res.status}  ${String(buf.byteLength).padStart(7)}B  jobs=${found}  embeddedJson=${embedded}  ${body.slice(0, 90).replace(/\s+/g, ' ')}`);
            if (res.status === 200) {
                await Actor.setValue(`NAUKRI_${label.replace(/\W+/g, '_')}`, body, { contentType: 'text/plain; charset=utf-8' });
            }
        } catch (err) {
            log.info(`${label.padEnd(24)} ERROR ${err.message.slice(0, 80)}`);
        }
    }
    await Actor.exit();
}

/*
 * Glassdoor needs a verified URL shape before a parser is worth writing: how to pass a location,
 * and how to paginate. Guessing these is what made the first LinkedIn parser wrong.
 */
if (source === 'glassdoor-probe') {
    const s = await makeSession('residential', 0);
    const kw = keywords.replace(/\s+/g, '-');
    const enc = encodeURIComponent(keywords);

    const countCards = (b) => (b.match(/data-test="jobListing"/g) ?? []).length;
    const firstTitle = (b) => (b.match(/data-test="job-title"[^>]*>([^<]{1,60})/) ?? [])[1] ?? '';
    const firstLoc = (b) => (b.match(/data-test="emp-location"[^>]*>([^<]{1,40})/) ?? [])[1] ?? '';

    const tryUrl = async (label, url, headers = {}) => {
        try {
            const res = await s.impit.fetch(url, { headers });
            const buf = Buffer.from(await res.bytes());
            const body = buf.toString('utf8');
            log.info(`${label.padEnd(30)} ${res.status} ${String(buf.byteLength).padStart(8)}B cards=${String(countCards(body)).padStart(3)}`
                + ` first="${firstTitle(body).slice(0, 28)}" loc="${firstLoc(body).slice(0, 22)}"`);
            if (res.status === 200 && countCards(body)) {
                await Actor.setValue(`GD_${label.replace(/\W+/g, '_')}`, body, { contentType: 'text/plain; charset=utf-8' });
            }
            return body;
        } catch (err) {
            log.info(`${label.padEnd(30)} ERROR ${err.message.slice(0, 70)}`);
            return '';
        }
    };

    // 1. Does the location autocomplete endpoint still exist? It gives us locId/locT.
    const auto = await tryUrl('locationAjax', `https://www.glassdoor.com/util/ajax/findLocationsByFullText.htm?term=${encodeURIComponent(location)}&maxLocationsToReturn=5`);
    log.info(`  locationAjax body: ${auto.slice(0, 300).replace(/\s+/g, ' ')}`);
    const legacy = await tryUrl('findPopularLocationAjax', `https://www.glassdoor.com/findPopularLocationAjax.htm?term=${encodeURIComponent(location)}&maxLocationsToReturn=5`);
    log.info(`  findPopularLocation body: ${legacy.slice(0, 300).replace(/\s+/g, ' ')}`);

    // 2. Search URL shapes.
    await tryUrl('SRCH keyword-only', `https://www.glassdoor.com/Job/${kw}-jobs-SRCH_KO0,${keywords.length}.htm`);
    await tryUrl('jobs.htm sc.keyword', `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${enc}`);
    await tryUrl('jobs.htm +locKeyword', `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${enc}&locKeyword=${encodeURIComponent(location)}`);
    await tryUrl('jobs.htm +typedLocation', `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${enc}&typedLocation=${encodeURIComponent(location)}`);

    // 3. Pagination shapes.
    await tryUrl('jobs.htm p=2', `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${enc}&p=2`);
    await tryUrl('SRCH _IP2', `https://www.glassdoor.com/Job/${kw}-jobs-SRCH_KO0,${keywords.length}_IP2.htm`);

    await Actor.exit();
}

/*
 * Round 2 for Glassdoor. Comparing the first card is useless because Glassdoor reorders results
 * between identical requests, so this compares job-id SETS to answer:
 *   - does ?p=N actually paginate, or just re-serve page 1?
 *   - does any location parameter actually filter?
 *   - is the GraphQL endpoint reachable (the cheaper, cursor-paginated path)?
 */
if (source === 'glassdoor-paging') {
    const s = await makeSession('residential', 0);
    const enc = encodeURIComponent(keywords);
    const ids = async (label, url) => {
        const res = await s.impit.fetch(url);
        const body = Buffer.from(await res.bytes()).toString('utf8');
        const set = [...new Set([...body.matchAll(/data-jobid="(\d+)"/g)].map((m) => m[1]))];
        const locs = [...body.matchAll(/data-test="emp-location"[^>]*>([^<]{1,40})/g)].map((m) => m[1]);
        log.info(`${label.padEnd(26)} ${res.status} ids=${set.length} locs=[${locs.slice(0, 3).join(' | ')}]`);
        return { set, locs, body };
    };

    const base = `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${enc}`;
    const a = await ids('page1 (first call)', base);
    const b = await ids('page1 (second call)', base);
    const p2 = await ids('page2 ?p=2', `${base}&p=2`);
    const p3 = await ids('page3 ?p=3', `${base}&p=3`);

    const overlap = (x, y) => x.set.filter((i) => y.set.includes(i)).length;
    log.info(`OVERLAP page1 vs page1-again : ${overlap(a, b)}/${a.set.length}  <- churn baseline`);
    log.info(`OVERLAP page1 vs p=2         : ${overlap(a, p2)}/${a.set.length}  <- 0 means paging works`);
    log.info(`OVERLAP p=2   vs p=3         : ${overlap(p2, p3)}/${p2.set.length}`);

    for (const [label, param] of [['locKeyword', 'locKeyword'], ['typedLocation', 'typedLocation'], ['locName', 'locName']]) {
        const r = await ids(`loc via ${label}`, `${base}&${param}=${encodeURIComponent(location)}`);
        const hits = r.locs.filter((l) => new RegExp(location.split(',')[0], 'i').test(l) || /india/i.test(l)).length;
        log.info(`  -> ${hits}/${r.locs.length} cards match "${location}"`);
    }

    for (const [label, url] of [
        ['csrftoken', 'https://www.glassdoor.com/api/csrftoken'],
        ['graph GET', 'https://www.glassdoor.com/graph'],
    ]) {
        try {
            const res = await s.impit.fetch(url);
            const body = Buffer.from(await res.bytes()).toString('utf8');
            log.info(`${label.padEnd(26)} ${res.status} ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
        } catch (err) { log.info(`${label.padEnd(26)} ERROR ${err.message.slice(0, 60)}`); }
    }
    await Actor.exit();
}

/*
 * Glassdoor location control. The page derives its location from the proxy IP (`ipLocation` in the
 * embedded payload), which is why locKeyword/typedLocation were ignored. This checks whether
 * explicit locT/locId works, and hunts for a surviving location-autocomplete endpoint so arbitrary
 * city names can be resolved to a locId.
 */
if (source === 'glassdoor-loc') {
    const s = await makeSession('residential', 0);
    const enc = encodeURIComponent(keywords);
    const look = async (label, url, headers = {}) => {
        try {
            const res = await s.impit.fetch(url, { headers });
            const body = Buffer.from(await res.bytes()).toString('utf8');
            const locs = [...body.matchAll(/data-test="emp-location"[^>]*>([^<]{1,40})/g)].map((m) => m[1]);
            const json = /^[[{]/.test(body.trim());
            log.info(`${label.padEnd(34)} ${res.status} ${String(body.length).padStart(7)}B json=${json} locs=[${locs.slice(0, 4).join(' | ')}]`);
            if (json) log.info(`   body: ${body.slice(0, 260).replace(/\s+/g, ' ')}`);
            return body;
        } catch (err) { log.info(`${label.padEnd(34)} ERROR ${err.message.slice(0, 60)}`); return ''; }
    };

    // Does an explicit locId actually filter? 1140320 = Lubbock, TX (taken from a real listing).
    await look('baseline (IP location)', `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${enc}`);
    await look('locT=C&locId=1140320 (Lubbock)', `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${enc}&locT=C&locId=1140320`);
    await look('locT=N&locId=115 (India)', `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${enc}&locT=N&locId=115`);

    // Candidate autocomplete endpoints.
    const term = encodeURIComponent(location);
    for (const f of ['CITY', 'CITY,STATE,COUNTRY', 'C,S,N', 'CITY%2CSTATE%2CCOUNTRY%2CMETRO', 'ALL']) {
        await look(`autocomplete f=${f}`, `https://www.glassdoor.com/autocomplete/location?term=${term}&locationTypeFilters=${f}`, { accept: 'application/json' });
    }
    for (const [label, url] of [
        ['autocomplete/location', `https://www.glassdoor.com/autocomplete/location?term=${encodeURIComponent(location)}`],
        ['api/joblist locations', `https://www.glassdoor.com/api/v1/locations?term=${encodeURIComponent(location)}`],
        ['findLocations', `https://www.glassdoor.com/findLocations.htm?term=${encodeURIComponent(location)}`],
        ['typeahead', `https://www.glassdoor.com/api/typeahead/location?term=${encodeURIComponent(location)}`],
        ['suggest locations', `https://www.glassdoor.com/suggest/locations?term=${encodeURIComponent(location)}`],
    ]) await look(label, url, { accept: 'application/json' });

    await Actor.exit();
}

/*
 * Glassdoor 403s a fresh session: Cloudflare wants its __cf_bm cookie, which only arrives once
 * the session has fetched something. A full search page costs ~175 KB gzip, so this finds the
 * CHEAPEST warm-up URL that still unlocks the API, and checks that paging survives afterwards.
 */
if (source === 'glassdoor-warm') {
    const auto = `https://www.glassdoor.com/autocomplete/location?term=${encodeURIComponent(location)}&locationTypeFilters=CITY,STATE,COUNTRY`;
    const candidates = [
        ['no warm-up', null],
        ['robots.txt', 'https://www.glassdoor.com/robots.txt'],
        ['homepage', 'https://www.glassdoor.com/'],
        ['sitemap index', 'https://www.glassdoor.com/sitemap.xml'],
        ['full search page', `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(keywords)}`],
    ];

    for (const [label, warmUrl] of candidates) {
        // A brand-new session (and cookie jar) per candidate, so results do not leak.
        const s = await makeSession('residential', Math.floor(Math.random() * 1e6));
        let warmBytes = 0;
        let warmStatus = '-';
        if (warmUrl) {
            try {
                const w = await s.impit.fetch(warmUrl);
                warmBytes = gzipSync(Buffer.from(await w.bytes())).byteLength;
                warmStatus = w.status;
            } catch (err) { warmStatus = `ERR ${err.message.slice(0, 30)}`; }
        }
        try {
            const res = await s.impit.fetch(auto, { headers: { accept: 'application/json' } });
            const body = Buffer.from(await res.bytes()).toString('utf8');
            let locId = null;
            try { locId = JSON.parse(body)[0]?.locationId ?? null; } catch { /* not json */ }
            log.info(`${label.padEnd(18)} warm=${String(warmStatus).padEnd(4)} warmGzip=${String(warmBytes).padStart(6)}B`
                + `  autocomplete=${res.status} locId=${locId}`);
        } catch (err) {
            log.info(`${label.padEnd(18)} warm=${warmStatus} autocomplete ERROR ${err.message.slice(0, 50)}`);
        }
    }

    // Does an empty init object strip impit's browser headers? The product passes {}.
    log.info('--- init shape: fetch(url) vs fetch(url, {}) ---');
    const page = `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(keywords)}`;
    for (const [label, init] of [['no init', undefined], ['empty {}', {}], ['empty headers', { headers: {} }],
        ['accept json', { headers: { accept: 'application/json' } }]]) {
        const ss = await makeSession('residential', Math.floor(Math.random() * 1e6));
        try {
            const res = init === undefined ? await ss.impit.fetch(page) : await ss.impit.fetch(page, init);
            const body = Buffer.from(await res.bytes()).toString('utf8');
            const ids = new Set([...body.matchAll(/data-jobid="(\d+)"/g)].map((m) => m[1]));
            log.info(`  ${label.padEnd(16)} ${res.status} ids=${ids.size} len=${body.length}`);
        } catch (err) { log.info(`  ${label.padEnd(16)} ERROR ${err.message.slice(0, 50)}`); }
    }

    // Header set: the product sets only accept-language; this recon also sent appid/systemid.
    log.info('--- constructor header sets ---');
    const target = `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(keywords)}`;
    const conf = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: 'US' });
    const AL = { 'accept-language': 'en-US,en;q=0.9' };
    const REPEATS = 5;
    const sets = [
        ['AL only', AL],
        ['AL + upgrade-insecure', { ...AL, 'upgrade-insecure-requests': '1' }],
        ['no custom headers', undefined],
    ];
    for (const [label, headers] of sets) {
        const tally = [];
        for (let rep = 0; rep < REPEATS; rep++) {
            const warmFirst = false;
            const imp = new Impit({
                browser: 'chrome', timeout: 30_000, cookieJar: new CookieJar(),
                proxyUrl: await conf.newUrl(`hdr_${Math.floor(Math.random() * 1e6)}`), headers,
            });
            if (warmFirst) { try { await imp.fetch('https://www.glassdoor.com/robots.txt'); } catch { /* ignore */ } }
            try {
                const res = await imp.fetch(target, {});
                const body = Buffer.from(await res.bytes()).toString('utf8');
                const ids = new Set([...body.matchAll(/data-jobid="(\d+)"/g)].map((m) => m[1]));
                tally.push(`${res.status}/${ids.size}`);
            } catch (err) { tally.push(`ERR`); }
        }
        const ok = tally.filter((t) => t.startsWith('200')).length;
        log.info(`  ${label.padEnd(22)} ${ok}/${REPEATS} ok   [${tally.join(' ')}]`);
    }

    // Glassdoor paginates with opaque cursors from the embedded payload. Find the param name.
    log.info('--- cursor pagination ---');
    {
        const conf2 = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: 'US' });
        const imp = new Impit({
            browser: 'chrome', timeout: 30_000, cookieJar: new CookieJar(),
            proxyUrl: await conf2.newUrl(`cur_${Math.floor(Math.random() * 1e6)}`),
            headers: { 'accept-language': 'en-US,en;q=0.9', 'upgrade-insecure-requests': '1' },
        });
        const base = `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(keywords)}`;
        const get = async (url) => {
            const res = await imp.fetch(url, {});
            const body = Buffer.from(await res.bytes()).toString('utf8');
            const ids = new Set([...body.matchAll(/data-jobid="(\d+)"/g)].map((m) => m[1]));
            const cur = [...body.matchAll(/\\"cursor\\":\\"([^\\"]+)\\",\\"pageNumber\\":(\d+)/g)]
                .map((m) => ({ cursor: m[1], page: Number(m[2]) }));
            const total = body.match(/\\"totalJobsCount\\":(\d+)/)?.[1] ?? null;
            return { status: res.status, ids, cur, total };
        };
        const p1 = await get(base);
        log.info(`  page1 ${p1.status} ids=${p1.ids.size} total=${p1.total} cursors=${p1.cur.map((c) => c.page).join(',')}`);
        const next = p1.cur.find((c) => c.page === 2);
        if (!next) { log.info('  no page-2 cursor found'); } else {
            for (const [label, url] of [
                ['p=2 only', `${base}&p=2`],
                ['pageCursor only', `${base}&pageCursor=${encodeURIComponent(next.cursor)}`],
                ['p=2 + pageCursor', `${base}&p=2&pageCursor=${encodeURIComponent(next.cursor)}`],
            ]) {
                const r = await get(url);
                const overlap = [...r.ids].filter((i) => p1.ids.has(i)).length;
                log.info(`  ${label.padEnd(18)} ${r.status} ids=${r.ids.size} overlapWithPage1=${overlap}`);
            }
        }
    }

    // SEO-indexable pagination: /Job/<kw>-jobs-SRCH_KO0,N_IP<page>.htm
    log.info('--- SEO _IP pagination ---');
    {
        const conf3 = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: 'US' });
        const imp = new Impit({
            browser: 'chrome', timeout: 30_000, cookieJar: new CookieJar(),
            proxyUrl: await conf3.newUrl(`seo_${Math.floor(Math.random() * 1e6)}`),
            headers: { 'accept-language': 'en-US,en;q=0.9', 'upgrade-insecure-requests': '1' },
        });
        const kwSlug = keywords.trim().replace(/\s+/g, '-').toLowerCase();
        const kl = keywords.trim().length;
        const get = async (url) => {
            const res = await imp.fetch(url, {});
            const body = Buffer.from(await res.bytes()).toString('utf8');
            const ids = new Set([...body.matchAll(/data-jobid="(\d+)"/g)].map((m) => m[1]));
            const locs = [...body.matchAll(/data-test="emp-location"[^>]*>([^<]{1,30})/g)].map((m) => m[1]);
            return { status: res.status, ids, locs };
        };
        const seen = new Set();
        for (let page = 1; page <= 4; page++) {
            const suffix = page === 1 ? '' : `_IP${page}`;
            const url = `https://www.glassdoor.com/Job/${kwSlug}-jobs-SRCH_KO0,${kl}${suffix}.htm`;
            const r = await get(url);
            const fresh = [...r.ids].filter((i) => !seen.has(i)).length;
            for (const i of r.ids) seen.add(i);
            log.info(`  IP${page} ${r.status} ids=${r.ids.size} new=${fresh} cumulative=${seen.size} locs=[${r.locs.slice(0, 2).join(' | ')}]`);
        }
        // Same, but scoped to a city via the IC<locId> segment (Bengaluru = 2940587).
        log.info('  -- with IC<locId> for a city --');
        const seen2 = new Set();
        for (let page = 1; page <= 3; page++) {
            const suffix = page === 1 ? '' : `_IP${page}`;
            const url = `https://www.glassdoor.com/Job/bengaluru-${kwSlug}-jobs-SRCH_IL.0,9_IC2940587_KO10,${10 + kl}${suffix}.htm`;
            const r = await get(url);
            const fresh = [...r.ids].filter((i) => !seen2.has(i)).length;
            for (const i of r.ids) seen2.add(i);
            log.info(`  city IP${page} ${r.status} ids=${r.ids.size} new=${fresh} locs=[${r.locs.slice(0, 2).join(' | ')}]`);
        }
    }

    // GET pagination is capped at 30. Can filter/sort params be used to harvest DIFFERENT 30s?
    log.info('--- query splitting ---');
    {
        const conf4 = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: 'US' });
        const imp = new Impit({
            browser: 'chrome', timeout: 30_000, cookieJar: new CookieJar(),
            proxyUrl: await conf4.newUrl(`split_${Math.floor(Math.random() * 1e6)}`),
            headers: { 'accept-language': 'en-US,en;q=0.9', 'upgrade-insecure-requests': '1' },
        });
        const base = `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(keywords)}`;
        const get = async (url) => {
            const res = await imp.fetch(url, {});
            const body = Buffer.from(await res.bytes()).toString('utf8');
            return {
                status: res.status,
                ids: new Set([...body.matchAll(/data-jobid="(\d+)"/g)].map((m) => m[1])),
                total: body.match(/\\"totalJobsCount\\":(\d+)/)?.[1] ?? null,
            };
        };
        const p1 = await get(base);
        log.info(`  baseline ids=${p1.ids.size} total=${p1.total}`);
        const all = new Set(p1.ids);
        for (const [label, qs] of [
            ['sortBy=date_desc', '&sortBy=date_desc'],
            ['fromAge=1', '&fromAge=1'],
            ['fromAge=3', '&fromAge=3'],
            ['fromAge=7', '&fromAge=7'],
            ['fromAge=14', '&fromAge=14'],
            ['fromAge=30', '&fromAge=30'],
            ['jobType=fulltime', '&jobType=fulltime'],
            ['jobType=contract', '&jobType=contract'],
            ['remoteWorkType=1', '&remoteWorkType=1'],
            ['seniority=entrylevel', '&seniorityType=entrylevel'],
            ['minSalary=100000', '&minSalary=100000'],
        ]) {
            const r = await get(base + qs);
            const overlap = [...r.ids].filter((i) => p1.ids.has(i)).length;
            const fresh = [...r.ids].filter((i) => !all.has(i)).length;
            for (const i of r.ids) all.add(i);
            log.info(`  ${label.padEnd(22)} ${r.status} ids=${r.ids.size} total=${String(r.total).padStart(5)} overlapBase=${String(overlap).padStart(2)} new=${fresh} union=${all.size}`);
        }
    }

    // Does paging hold up inside one warmed session?
    log.info('--- paging within one warmed session ---');
    const s = await makeSession('residential', 999);
    try { await s.impit.fetch('https://www.glassdoor.com/robots.txt'); } catch { /* best effort */ }
    for (let p = 1; p <= 4; p++) {
        const url = `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(keywords)}${p > 1 ? `&p=${p}` : ''}`;
        try {
            const res = await s.impit.fetch(url);
            const body = Buffer.from(await res.bytes()).toString('utf8');
            const ids = new Set([...body.matchAll(/data-jobid="(\d+)"/g)].map((m) => m[1]));
            log.info(`  p=${p} ${res.status} ids=${ids.size}`);
        } catch (err) { log.info(`  p=${p} ERROR ${err.message.slice(0, 50)}`); }
    }
    await Actor.exit();
}

const records = [];
const samples = {};

for (const tier of ['user', 'residential']) {
    let pool;
    try {
        pool = await Promise.all(Array.from({ length: sessions }, (_, i) => makeSession(tier, i)));
    } catch (err) {
        log.warning(`Tier ${tier} unavailable: ${err.message}`);
        continue;
    }

    if (warm) {
        await Promise.all(pool.map(async (s) => {
            const { rec } = await hit(s, T.warmUrl(keywords, location), 'warm');
            records.push(rec);
        }));
    }

    // Round-robin the requests across IPs, `concurrency` in flight.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
        while (next < requests) {
            const i = next++;
            const s = pool[i % pool.length];
            const { rec, body } = await hit(s, T.searchUrl(keywords, location, i * T.step), `search+${i * T.step}`);
            records.push(rec);
            if (rec.jobs > 0 && !samples[`search_${tier}`]) samples[`search_${tier}`] = body;
        }
    }));

    // One detail request, to price the expensive path.
    const sample = samples[`search_${tier}`];
    const id = sample ? T.firstId(sample) : null;
    const durl = id ? T.detailUrl(id) : null;
    if (durl) {
        const { rec, body } = await hit(pool[0], durl, 'detail');
        records.push(rec);
        if (!rec.blocked) samples[`detail_${tier}`] = body;
    }

    const tierRecs = records.filter((r) => r.tier === tier && r.label.startsWith('search'));
    const okRecs = tierRecs.filter((r) => !r.blocked && r.status === 200 && r.jobs > 0);
    const totalJobs = okRecs.reduce((n, r) => n + r.jobs, 0);
    log.info(`[${tier}] search requests=${tierRecs.length} ok=${okRecs.length} `
        + `blocked=${tierRecs.filter((r) => r.blocked).length} failed=${tierRecs.filter((r) => r.status === 0).length} jobs=${totalJobs}`);
    if (totalJobs) {
        log.info(`[${tier}] bytes/job: ${Math.round(okRecs.reduce((n, r) => n + r.bytes, 0) / totalJobs)} decoded, `
            + `${Math.round(okRecs.reduce((n, r) => n + r.gzip, 0) / totalJobs)} gzip (billed)`);
    }
    log.info(`[${tier}] requests survived per IP before first block: `
        + pool.map((s) => (s.blockedAt == null ? `${s.ok}+` : s.blockedAt)).join(', '));
}

for (const [k, v] of Object.entries(samples)) {
    await Actor.setValue(`SAMPLE_${source}_${k}`, v, { contentType: 'text/plain; charset=utf-8' });
}
await Actor.pushData(records);
await Actor.setValue('RECON', { source, keywords, location, records });
log.info(`Saved ${Object.keys(samples).length} sample(s): ${Object.keys(samples).join(', ')}`);
await Actor.exit();
