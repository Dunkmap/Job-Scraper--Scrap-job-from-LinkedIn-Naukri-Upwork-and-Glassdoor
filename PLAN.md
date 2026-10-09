# Ultimate Job Scraper: plan

One Apify Actor that searches **LinkedIn, Naukri and Glassdoor** in a single run and returns
one unified, deduplicated dataset. Goals in priority order: **fast, cheap to run, rich and reliable output.**

---

## 1. Business model (why each technical choice matters)

| Fact (2026) | Consequence for us |
|---|---|
| Rental pricing is retired (no new rentals since 1 Apr 2026, fully retired 1 Oct 2026). **Pay-per-event (PPE)** is the model. | We charge per job result. |
| Developer profit = **0.8 × revenue − platform costs** (compute + proxy + storage). Only paid-plan users count. | Every CU-second and every proxy MB comes out of *our* margin. |
| Compute ≈ $0.13–0.20 per CU (1 CU = 1 GB RAM × 1 hour). | Run at **256 MB**, HTTP-only. A browser would need 2–4 GB, which is 8–16× the cost. |
| Residential proxy ≈ $7–8 per GB. Datacenter proxy is included in the plan, per IP. | **Proxy traffic is our largest cost.** Use datacenter by default and residential only as a per-request fallback. |
| Competitor LinkedIn jobs Actors charge $0.30–$5.00 per 1,000. The most-used one is about $1/1k. | Our edge: 3 sources in 1 Actor, more fields, dedupe, "only new jobs" mode, at a competitive price. |

### Proposed PPE events (tune after real cost benchmarks)

| Event | Price | When charged |
|---|---|---|
| `apify-actor-start` | default $0.00005 | automatic |
| `job` | **$0.60 / 1,000** | each job pushed with basic fields (title, company, location, date, URL, salary if shown) |
| `job-with-details` | **$1.60 / 1,000** | each job pushed with full details (description, criteria, applicants, Easy Apply flag) instead of `job` |

One event per item (not "basic + extra") so that the SDK's budget limiting stays exact: an item is
either stored and charged once, or not stored at all.
This way users who only need basic listings pay little, and we're never out of pocket on the expensive
detail requests. Target margin: **platform cost ≤ 25% of revenue** for every source.

---

## 2. Tech stack

- **TypeScript + Apify SDK v3**, Node 22. **No Crawlee RequestQueue**: every queue operation is a billed storage
  API call, and our pagination is fully predictable, so a small in-memory loop with a semaphore is faster and cheaper.
- **`impit`** HTTP client (Apify's Rust client that matches browser TLS fingerprints, and the successor to
  got-scraping). It gets past most fingerprint-based blocking without a browser.
- **cheerio** for HTML fragments (LinkedIn). JSON APIs are parsed directly (Naukri, Glassdoor).
- **No Playwright in the default image.** If a source ever *requires* a browser, it gets its own optional
  fallback path, which runs once only to mint cookies/tokens and is then reused for HTTP calls.
- Docker base `apify/actor-node:22` (small image, fast cold start).

### Why not Python?
Both work. The Node SDK has first-class PPE helpers, Crawlee JS's impit integration is official and
documented, and `actor-node` images start faster. That means less billed time on every run.

---

## 3. How each source is scraped

| Source | Method | Pagination / limits | Main risk | Mitigation |
|---|---|---|---|---|
| **LinkedIn** | Guest endpoint `linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search` (HTML `<li>` fragments, no login). Details via `/jobs-guest/jobs/api/jobPosting/{id}`. | `start` in steps of 10/25. Filters: `f_TPR` (posted within), `f_WT` (remote), `f_JT` (type), `f_E` (experience), `geoId`, `sortBy=DD`. ~1,000 results/query cap → **split queries** by time window or location to go deeper. | 429s and auth-wall redirects | Session pool and rotating datacenter IPs, back off on 429, per-request residential retry |
| **Naukri** | Internal JSON API `naukri.com/jobapi/v3/search` (and the job-detail API). Rich JSON in one call: salary, experience, skills, and often the full description. | `pageNo`, ~20 per page | reCAPTCHA (HTTP 406) on "cold" IPs | Warm the session (homepage → cookies → API), Indian proxy group, impit Chrome fingerprint. If still blocked, mint cookies once with a short browser step, then reuse them for HTTP. |
| **Glassdoor** | Internal GraphQL (BFF) endpoint on each country domain. CSRF token is scraped from page HTML once per session. | Cursor pagination, ~900 per search | Cloudflare and frequent layout changes | Use GraphQL rather than HTML (layout changes don't break JSON), impit TLS fingerprint, sticky sessions, token reuse |

**Step 0 of the build is a recon spike** for each source. We capture real requests and measure the
**bytes per job** (compressed), block rate on datacenter vs residential, and the maximum safe
concurrency. The numbers go into `docs/cost-benchmarks.md` and decide the final prices.

---

## 4. Speed and cost techniques (the core of profitability)

1. **HTTP only, 256 MB memory, high concurrency.** Most time is spent waiting on network, so this is cheap.
2. **Always send `Accept-Encoding: gzip, br`**, because proxy traffic is billed on the wire. Request only the endpoints
   we need: no images/CSS/JS, and never full HTML pages when an API or fragment exists.
3. **Search first, dedupe, then enrich.** Detail requests are 5–20× more expensive than listing requests, so we only
   fetch details for unique job IDs, and only when the user asked for them.
4. **Proxy ladder per request:** no proxy (if the site allows it) → datacenter → residential, for that request only.
   Track the block rate per source, and if a source needs residential most of the time, record that in the cost docs.
5. **Stop at the exact limit.** We never fetch page N+1 when `maxItems` is already reached, and we stop when
   `eventChargeLimitReached` is set (the user's max-charge cap).
6. **Batch writes:** push results to the dataset in chunks of about 50 (fewer API calls and less storage overhead),
   and charge events in the same batches.
7. **Run the sources in parallel** inside one run, each with its own concurrency/rate limits.
8. **Query splitting** for big searches, by time window and location, to get past the per-query caps (LinkedIn
   ~1k, Glassdoor ~900) without wasted requests.
9. **"Only new jobs" mode** (killer feature for scheduled runs): a named key-value store keeps the job IDs
   already seen. Repeat runs skip them before fetching details, so a run is cheaper for us *and* for the user.
10. **Lean output:** no raw HTML in the dataset, and description as text plus optional HTML (behind a flag).

---

## 5. Input (what users configure)

```jsonc
{
  "keywords": ["react developer"],            // one or more
  "locations": ["Bangalore", "Remote"],
  "sources": ["linkedin", "naukri", "glassdoor"],
  "maxItemsPerSource": 100,
  "postedWithin": "week",                      // 24h | week | month | any
  "workType": ["remote", "hybrid", "onsite"],
  "jobType": ["full-time", "contract", "internship"],
  "experienceLevel": ["entry", "mid", "senior"],
  "fetchDetails": false,                       // full description, skills, etc. Charged extra.
  "onlyNewJobs": false,                        // skip jobs seen in previous runs
  "dedupeAcrossSources": true,
  "startUrls": [],                             // optional: paste any search URL from a supported site
  "proxyConfiguration": { "useApifyProxy": true }
}
```

## 6. Unified output schema

`id, source, sourceJobId, url, applyUrl, title, company, companyUrl, companyLogo, companyRating (Glassdoor),
location, city, country, workType, jobType, experienceLevel, experienceYears {min,max},
salary {min,max,currency,period,raw}, skills[], postedAt (ISO), postedAtRaw, applicants,
easyApply, description (text), descriptionHtml (optional), industry, function, scrapedAt`

Every field is always present. Missing values are `null`, never `undefined`, so CSV/Excel exports keep stable columns.
We'll also add a dataset **views** definition for the Apify Console (overview table, salary view).

---

## 7. Project layout

```
.actor/            actor.json, input_schema.json, dataset_schema.json, pay_per_event.json
src/
  main.ts          input → plan queries → run sources in parallel → finish
  core/            http client (impit + proxy ladder), session handling, charging, dedupe, normalizer
  sources/
    linkedin/      search.ts, detail.ts, parse.ts, filters.ts
    naukri/        ...
    glassdoor/     ...
  schema.ts        unified Job type plus a zod validator
test/fixtures/     saved real responses → parser unit tests (run offline in CI)
docs/cost-benchmarks.md
```

## 8. Quality and Store ranking

- Parser unit tests on saved fixtures in CI on every push.
- **Daily scheduled health-check run** on Apify for each source (5 jobs each), with alerts when a run fails or the
  field fill-rate drops. That's how we fix breakages before users notice. Store ranking punishes failed runs.
- Clear errors when a source is blocked. The other sources still finish, and the user is never charged for
  jobs that weren't delivered.
- A README written for SEO (keywords: LinkedIn jobs scraper, Naukri scraper, Glassdoor jobs API, job
  aggregator), with example output, a pricing table, and integration examples (Make, Zapier, n8n, API).

---

## 9. Roadmap

| Phase | Deliverable |
|---|---|
| **0. Recon** | Capture live requests for each source, measure bytes/job and block rates, write `docs/cost-benchmarks.md` |
| **1. Core + LinkedIn** | Project skeleton, impit/proxy ladder, PPE charging, unified schema, LinkedIn search and details, tests |
| **2. Naukri** | Search and detail via the JSON API, session warming and the reCAPTCHA fallback |
| **3. Glassdoor** | GraphQL search and details, CSRF token handling |
| **4. Polish and publish** | Only-new mode, cross-source dedupe, query splitting, README/SEO, dataset views, health-check schedule, Store listing |
| **Later** | Publish cheap single-source Actors (e.g. "Naukri Jobs Scraper") from the same code, for more Store search hits |

## 10. Risks

- Sites change internal APIs without notice. Mitigation: fixture tests, daily health checks, and fast patches.
- Terms of service: all of these sites restrict automated access. We only collect public job postings, never
  personal profile data or logged-in content, and we don't ask users for their account cookies.
- Price war on the Store. We compete on multi-source coverage, data quality and "only new" mode, not just on price.
