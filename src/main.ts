import { Actor, log } from 'apify';
import { createProxies, HttpClient } from './core/http.js';
import { JobSink } from './core/sink.js';
import { linkedin } from './sources/linkedin.js';
import type { Source } from './sources/source.js';
import type { Input, SearchQuery, SourceName } from './types.js';

const SOURCES: Partial<Record<SourceName, Source>> = { linkedin };

await Actor.init();

const raw = (await Actor.getInput<Partial<Input>>()) ?? {};
const input: Input = {
    keywords: (raw.keywords ?? []).map((k) => k.trim()).filter(Boolean),
    locations: (raw.locations?.length ? raw.locations : ['']).map((l) => l.trim()),
    sources: raw.sources?.length ? raw.sources : ['linkedin', 'naukri', 'glassdoor'],
    maxItemsPerSource: raw.maxItemsPerSource ?? 100,
    postedWithin: raw.postedWithin ?? 'any',
    workType: raw.workType ?? [],
    jobType: raw.jobType ?? [],
    experienceLevel: raw.experienceLevel ?? [],
    fetchDetails: raw.fetchDetails ?? false,
    onlyNewJobs: raw.onlyNewJobs ?? false,
    dedupeAcrossSources: raw.dedupeAcrossSources ?? true,
    includeDescriptionHtml: raw.includeDescriptionHtml ?? false,
    proxyConfiguration: raw.proxyConfiguration ?? { useApifyProxy: true },
};

if (!input.keywords.length) {
    await Actor.fail('Please provide at least one keyword, e.g. "react developer".');
}

const queries: SearchQuery[] = input.keywords.flatMap((keyword) => input.locations.map((location) => ({ keyword, location })));
const active = input.sources.filter((name) => {
    if (SOURCES[name]) return true;
    log.warning(`Source "${name}" is not available yet and will be skipped.`);
    return false;
});

const sink = new JobSink({ ...input, sources: active });
await sink.init();

const started = Date.now();
const clients: Record<string, HttpClient> = {};

await Promise.all(active.map(async (name) => {
    const source = SOURCES[name]!;
    const { proxy, residentialProxy } = await createProxies(input.proxyConfiguration, source.residentialCountry);
    const http = new HttpClient({ name, proxy, residentialProxy, isBlocked: source.isBlocked, headers: { 'accept-language': 'en-US,en;q=0.9' } });
    clients[name] = http;
    try {
        await source.run({ input, sink, http }, queries);
    } catch (err) {
        // One broken source must never fail the whole run: the others still deliver.
        log.exception(err as Error, `Source ${name} failed`);
    }
}));

await sink.close();

// Per-run cost telemetry. This is what we use to tune prices and the proxy strategy (see docs/cost-benchmarks.md).
const summary = sink.summary();
const stats = {
    durationSec: Math.round((Date.now() - started) / 1000),
    ...summary,
    http: Object.fromEntries(Object.entries(clients).map(([name, c]) => [name, c.stats])),
};
await Actor.setValue('RUN_STATS', stats);
log.info(`Done in ${stats.durationSec}s. Jobs per source: ${JSON.stringify(summary.pushed)}. `
    + `Skipped duplicates: ${summary.skippedDuplicates}, already seen: ${summary.skippedSeen}.`);

const total = Object.values(summary.pushed).reduce((a, b) => a + b, 0);
const unreachable = Object.entries(clients).filter(([, c]) => c.stats.requests > 0 && c.stats.failures >= c.stats.requests).map(([n]) => n);
const note = unreachable.length ? ` Could not reach: ${unreachable.join(', ')}. Try again later or use a different proxy.` : '';
await Actor.exit((total ? `Scraped ${total} jobs.` : 'No jobs found for this search.') + note);
