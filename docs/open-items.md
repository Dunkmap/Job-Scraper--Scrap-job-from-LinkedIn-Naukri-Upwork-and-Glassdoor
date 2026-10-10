# Open items

Last updated 2026-10-11. State of play: LinkedIn and Glassdoor both work, verified against live
responses, and the Actor is deployed (`jZYn3CzbfLB9PTRuQ`). Costs and findings are in
`cost-benchmarks.md`.

## 1. Glassdoor returns fewer jobs than the page holds (IN PROGRESS, answer not yet confirmed)

**The question:** a Glassdoor-only run (`maxItemsPerSource: 100`, "react developer" / "India",
run `KkGmIVGNkgp9LDpTL`) returned **19 jobs**. Is that a bug, or does Glassdoor only have 19?

**What is already known from that run's `RUN_STATS`:**

- 2 requests, **0 blocked, 0 failures** — so nothing was blocked and the page came back fine.
- `pushed: 19`, `skippedDuplicates: 1`.
- Only 1 search page was fetched, which is correct: Glassdoor's GET search is capped at 30 and
  cannot be paginated (see `cost-benchmarks.md` §7). So **the ceiling for one keyword+location is
  30, never 100** — `maxItemsPerSource: 100` cannot be reached from a single query.
- That leaves ~10 listings unaccounted for between the expected 30 and 19 + 1 duplicate.

**Leading explanations, in order of likelihood:**

1. Glassdoor's `jobListings` payload pads the result set with listings that repeat (sponsored slots
   reappearing), so the 30 cards are not 30 distinct jobs.
2. `mapListing` returns null for rows with no `listingId`/title and they are skipped silently.
3. `dedupeAcrossSources` was true, and `crossSourceKey` is `title|company|city`. **This drops
   same-title/company/city rows even within a single source** — e.g. one employer posting
   "React Developer / Bengaluru" several times. Worth deciding whether that is desirable for a
   single-source run.
4. The India page genuinely held fewer than 30 listings.

**Already done:** `src/sources/glassdoor.ts` now logs the full accounting per page —
`N listings on page 1 -> X new, Y filtered out by your options, Z unusable, W already seen`.
Built and pushed, but **not yet run**.

**Next step:** re-run that exact input and read the new log line. That single line distinguishes
explanation 1/2 (padding or unusable rows) from 3 (our dedupe) immediately. Then decide whether
`dedupeAcrossSources` should apply within one source, and whether to surface the real ceiling to
users (e.g. warn when `maxItemsPerSource` > 30 and only Glassdoor is selected).

## 2. LinkedIn query splitting (highest value feature work)

One LinkedIn query yields only ~854-868 unique jobs before its ~1,000 cap, and the remaining page
budget is repeats. Split each query by time window (`f_TPR`) and/or location to go deeper. This is
the single biggest lever on "jobs per run", which is what buyers compare.

## 3. Glassdoor GraphQL pagination

Would lift Glassdoor from 30 per query to ~900. Needs a POST to `/graph` with the opaque
`paginationCursors` already present in the page payload; `/graph` 403s on anything simpler and
`/api/csrftoken` is 404. Notes in `cost-benchmarks.md` §7.

## 4. Launch polish

- `startUrls` is in PLAN.md and the README but is not implemented, and is not in the input schema.
- **Set the pay-per-event prices in Apify Console → Monetization.** Nothing in the repo can do
  this. The Actor charges exactly `job` and `job-with-details`; recommended $0.40 and $1.20 per
  1,000 (measured cost $0.0075 and $0.0295, so ~97% margin).
- CI workflow to run the fixture tests on push.
- Daily health-check schedule per source, with alerts on failure or a drop in field fill rates.
- README/Store listing SEO pass.

## 5. Smaller things noticed but not chased

- `experienceLevel` fills only 32-36% on LinkedIn and 0% on Glassdoor; Glassdoor's extracted
  attributes do carry levels ("Mid-level") but they were absent from the sampled Indian listings.
- `applyUrl` is 0% on LinkedIn: current guest pages hide it behind a sign-in modal. `easyApply` is
  derived from the off-site apply marker instead, which does work.
- The `warmUrl` session warm-up was superseded by the header fix and is now unused by both
  sources; `HttpClient` still supports it.
