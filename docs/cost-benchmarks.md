# Cost benchmarks

Measured, not guessed. Every run saves `RUN_STATS` in its key-value store (requests, failures, blocks,
bytes and requests per proxy tier). Copy the numbers here after each change that affects cost.

Formula: cost per 1,000 jobs = (CU used × CU price + residential GB × GB price) / jobs × 1,000.
Target: cost ≤ 25% of the event price.

| Date | Source | Mode | Jobs | Duration | Memory | Requests | Blocked | Residential MB | Cost / 1k | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-09 | linkedin | basic (100, no details) | 100 | 5 s (11.6 s wall incl. startup) | local | 10 | 0 | 0 | ≈ $0.001 | Direct container IP, no proxy. 291 KB decoded = 2.9 KB/job; wire ≈ 0.31 KB/job (gzip, measured 3.2 KB per 10-card page) |
| 2026-10-09 | linkedin | details (30) | 30 | 3 s | local | 33 | 0 | 0 | ≈ $0.002 | Direct container IP, no proxy. 1.51 MB decoded = 50 KB/job; wire ≈ 12 KB/job (detail gzips to ~24%) |

Cost / 1k above is compute only (256 MB, measured throughput ~20 jobs/s basic, ~10 jobs/s details, $0.13–0.20/CU),
since datacenter proxy is per-IP, not per-GB. If every request had to go residential ($8/GB) it would add
≈ $0.003/1k basic and ≈ $0.09/1k details: still under 6% of the event prices.

**LinkedIn field fill-rate (live, 2026-10-09):**

| Field | basic (n=100) | details (n=30) |
|---|---|---|
| id, url, title, company, location, companyLogo, postedAt, postedAtRaw | 100% | 100% |
| companyUrl | 99% | 100% |
| description, jobType, experienceLevel, industry, applicants | 0% | 100% |
| easyApply | 0% | 100% after the fix in this commit (was 0%) |
| salary | 0% | 23% |
| applyUrl, jobFunction | 0% | 0%: guest pages no longer include them |
| workType | 0% | 0%: only set from a single-value `workType` filter or remote/hybrid in the location text |
| companyRating, experienceYears, skills | 0% | 0%: not offered by LinkedIn |

## Recon findings (2026-10-09, direct from a cloud container IP, no proxy)

**LinkedIn: works over plain datacenter-style HTTP.** 43 requests, 0 blocks, 0 429s at the Actor's default
concurrency (3 queries, 8 details). Live markup matched the parser except apply info: guests no longer get
`code#applyUrl` or "Job function". The apply button's tracking name (`public_jobs_apply-link-onsite` /
`-offsite`) still gives Easy Apply vs company site (6/30 vs 24/30). **`sortBy=DD` is ignored unless `f_TPR` is set**:
with `postedWithin: "any"` the first page had jobs up to 1 year old, while with `f_TPR` they were all from the
last few days. `job-with-details` is described as including the "apply link", which LinkedIn guests no longer get.

**Naukri: search API needs a reCAPTCHA token from this IP.** Homepage and SEO pages return 200 (impit Chrome,
cookies `_t_ds`, `J`, ...), but `jobapi/v3/search` returns `406 {"message":"recaptcha required"}` even after
warm-up and with frontend headers (appid, systemid, clientid). SEO pages are a Next.js shell with no job data, and the site
runs Akamai Bot Manager (`/akam/` script; plain curl gets HTTP/2 resets). The detail API `jobapi/v4/job/{id}` is
**not** gated: it answered without a captcha (303 + JSON for an expired id). Bytes per job not measurable until
search works. Next step: test the search from an Indian residential IP, then the planned short browser step to mint
cookies/token and reuse them for HTTP.

**Glassdoor: blocked by Cloudflare.** Every page (.com and .co.in) and `POST /graph` returns 403 with
`cf-mitigated: challenge` ("Just a moment" managed challenge) for impit Chrome and Firefox. No CSRF token is reachable
over HTTP from this IP. Next step: test residential; most likely needs a browser step to pass the challenge and
get `cf_clearance` + token, then reuse them for GraphQL over HTTP.

