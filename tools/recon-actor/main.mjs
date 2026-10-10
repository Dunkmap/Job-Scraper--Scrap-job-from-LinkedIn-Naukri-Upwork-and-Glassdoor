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
const T = TARGETS[source];

/** One sticky proxy session = one IP, with its own cookie jar. */
async function makeSession(tier, n) {
    const id = `recon_${tier}_${n}`;
    const conf = tier === 'residential'
        ? await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: source === 'naukri' ? 'IN' : 'US' })
        : proxy;
    return {
        id, tier, blockedAt: null, ok: 0, blocked: 0, failed: 0,
        impit: new Impit({
            browser: 'chrome',
            timeout: 30_000,
            proxyUrl: conf ? await conf.newUrl(id) : undefined,
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
