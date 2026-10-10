# Cost benchmarks

Measured, not guessed. Every run saves `RUN_STATS` in its key-value store (requests, failures, blocks,
bytes and requests per proxy tier). Copy the numbers here after each change that affects cost.

Formula: cost per 1,000 jobs = (CU used × CU price + residential GB × GB price) / jobs × 1,000.
Target: cost ≤ 25% of the event price.

Refresh the raw measurements with:

```bash
node tools/recon-linkedin.mjs                 # bytes/job + selector audit, no proxy
cd tools/recon-actor && apify run             # block rate and bytes per proxy tier
```

---

## 1. Measured payload sizes (2026-10-10, LinkedIn guest endpoints)

gzip is what matters: proxy traffic is billed on the wire, and LinkedIn serves these compressed.

| Request | Jobs returned | Decoded | gzip (billed) | gzip per job |
|---|---|---|---|---|
| `seeMoreJobPostings/search` (IN) | 10 | 29.6 KB | 3.24 KB | **324 B** |
| `seeMoreJobPostings/search` (US) | 10 | 30.4 KB | 2.94 KB | **294 B** |
| `jobPosting/{id}` (detail) | 1 | 72.8 KB | 7.95 KB | **7,945 B** |

**A detail request costs ~25× a listed job in proxy traffic.** That ratio is the whole reason
`fetchDetails` is a separate, higher-priced event, and why we dedupe before enriching.

## 2. Actual platform-billed cost (ground truth)

These are not estimates. They are what Apify billed for real production runs of this Actor
at 256 MB, read back from the run's own `usageTotalUsd`.

| Date | Mode | Jobs | Duration | CU | Residential GB | Billed USD | **USD / 1,000 jobs** |
|---|---|---|---|---|---|---|---|
| 2026-10-10 | basic (`react developer`, IN) | 60 | 4 s | 0.000431 | 0 | $0.0000736 | **$0.0012** |
| 2026-10-10 | details (`software engineer`, US) | 40 | 3 s | 0.000300 | 0 | $0.0004125 | **$0.0103** |

Both runs used **zero residential traffic**: datacenter plus session rotation was enough, so the
expensive tier never engaged. Throughput was ~15 jobs/second basic and ~13 jobs/second with
full details, including Actor startup.

### Margin at the planned prices

Developer keeps 0.8 × revenue.

| Event | Price / 1k | We keep | **Measured** cost | Cost as % of revenue | Margin |
|---|---|---|---|---|---|
| `job` | $0.60 | $0.48 | $0.0012 | 0.26% | **99.7%** |
| `job-with-details` | $1.60 | $1.28 | $0.0103 | 0.80% | **99.2%** |

Target was ≤25% of revenue. Measured is **under 1%**, i.e. ~30–100× more headroom than required.

## 3. Modelled cost per 1,000 jobs (for sensitivity)

Compute at 256 MB = 0.25 CU/hour ≈ $1.4e-5 per second at $0.20/CU (the pessimistic end of $0.13–0.20).
Residential priced at $8/GB. Datacenter proxy is included in the subscription per IP, so its
marginal traffic cost is effectively zero.

| Mode | Proxy traffic / 1k | Proxy cost / 1k | Compute / 1k | **Total / 1k** |
|---|---|---|---|---|
| basic, datacenter | 324 KB | ~$0.000 | ~$0.0004 (≈30 s) | **~$0.0005** |
| basic, residential | 324 KB | $0.0024 | ~$0.0004 | **~$0.003** |
| details, datacenter | 8.3 MB | ~$0.000 | ~$0.0017 (≈120 s) | **~$0.002** |
| details, residential | 8.3 MB | $0.0616 | ~$0.0017 | **~$0.064** |

### Modelled margin (worst case, residential for every request)

Developer keeps 0.8 × revenue.

| Event | Price / 1k | We keep | Worst-case cost | Cost as % of revenue | Margin |
|---|---|---|---|---|---|
| `job` | $0.60 | $0.48 | $0.003 | 0.6% | **99.4%** |
| `job-with-details` | $1.60 | $1.28 | $0.064 | 5.0% | **95.0%** |

Target was ≤25%. We are at 0.6–5%, i.e. **5–40× more headroom than required**, even assuming
residential proxy for every request. A 5× blow-up in retries still leaves >90% margin.

### Pricing conclusion

The most-used competing LinkedIn jobs Actor charges about **$1.00 per 1,000** for one source.
Our cost structure lets us undercut that and keep a ~99% margin:

| Event | Recommended | Net to us | Cost | Margin | Rationale |
|---|---|---|---|---|---|
| `job` | **$0.40 / 1k** | $0.32 | $0.0012 | **99.6%** | 60% below the market leader, 3 sources instead of 1 |
| `job-with-details` | **$1.20 / 1k** | $0.96 | $0.0103 | **98.9%** | still below competitors' detail tiers |

Set these in Apify Console → Monetization. There is **no pricing field in `actor.json`**; PPE prices
are configured in the Console only (verified against the Actor definition docs, 2026-10-10). The
Actor must charge exactly the event names `job` and `job-with-details`.

## 4. Block rate and throughput

Throughput, not bytes, is the real constraint: LinkedIn rate-limits per IP aggressively.

| Date | Source | Tier | Reqs | OK | Blocked | Sessions | Notes |
|---|---|---|---|---|---|---|---|
| 2026-10-10 | linkedin | home IP (no proxy) | 12 | 12 | 0 | 1 | cold start, 10 jobs/request |
| 2026-10-10 | linkedin | home IP (continued) | ~15 | 0 | all | 1 | HTTP 999/429 after ~15-25 requests from one IP |
| 2026-10-10 | linkedin | Apify datacenter | 24 | 24 | **0%** | 8 | 3 req/IP - clean |
| 2026-10-10 | linkedin | Apify datacenter | 100 | 66 | **34%** | 10 | 10 req/IP - IPs die after ~5 |
| 2026-10-10 | linkedin | Apify datacenter | 100 | 76 | **23%** | 40 | 2-3 req/IP - still blocked |
| 2026-10-10 | linkedin | Apify residential | 24 | 21 | 12% | 8 | |
| 2026-10-10 | linkedin | Apify residential | 100 | 94 | **5%** | 10 | |
| 2026-10-10 | linkedin | Apify residential | 100 | 92 | **5%** | 40 | consistently ~5% |

**Findings**

- A single IP serves roughly **15-25 guest-API requests** (150-250 jobs) before LinkedIn returns
  HTTP 999 or 429, and recovery takes minutes. Large runs therefore need IP rotation, not higher
  concurrency on one IP. `HttpClient` retires a session after **5 uses** for this reason.
- **Datacenter blocks ~23-34% under sustained load, residential ~5%** - the opposite of the usual
  assumption. Spreading the same 100 requests over 40 IPs instead of 10 only moved datacenter from
  34% to 23%, so the limit is not purely per-IP: Apify's datacenter range is already known to
  LinkedIn. Residential stayed at ~5% regardless of spread.
- Despite that, **real production runs used zero residential traffic** (section 2), because at
  realistic pacing the free tier succeeds and only genuine blocks escalate. Datacenter-first with
  escalation **on the first block** is therefore both the cheapest and the fastest strategy, and is
  what `HttpClient.fetch` implements.
- **Cookie warming is not needed and is counter-productive.** The public `/jobs/search` page
  returned **999** while the guest API on the same IP returned **200**. Warming spends a request
  (and 270 KB) to gain nothing, so the Actor does not do it.
- The guest API needs **no cookies, no login and no CSRF token**, which is why this stays HTTP-only.

## 5. Field fill rates

Empty columns are what lose Store users, so these are tracked like costs. Measured on the two
production runs in section 2 (60 basic jobs, 40 detailed jobs), not on hand-made fixtures.
Re-check with `npx tsx tools/fill-rate.mts`.

| Field | Basic run (n=60) | Details run (n=40) | Note |
|---|---|---|---|
| id, source, sourceJobId, url, title, company, companyUrl, companyLogo, location, postedAt, postedAtRaw | 100% | 100% | |
| activelyHiring, earlyApplicant | 100% | 100% | free signals most competitors drop |
| description, descriptionHtml | - | 100% | detail only, avg **6,034 chars** |
| easyApply, applicants, jobType, industry | - | 100% | detail only |
| experienceYears | - | **78%** | recovered from description text; LinkedIn has no such field, so competitors do not have it |
| experienceLevel | - | 32% | often absent or "Not Applicable", normalised to null |
| salary | 0% | 2% | **detail-only**, and LinkedIn publishes pay on few listings. Search cards carry no salary markup at all |
| workType | 5% | 2% | only when the listing or the user's filter states it; never guessed from the description |
| jobFunction | - | 0% | **not served**: LinkedIn guest pages expose exactly 3 criteria (Seniority level, Employment type, Industries) |
| skills, companyRating | 0% | 0% | not in LinkedIn guest markup; Naukri and Glassdoor supply these |

Fields that LinkedIn genuinely does not expose stay `null` rather than being inferred. One sampled
posting advertised "remote working opportunities" as a perk while stating fixed office hours, so
guessing `workType` from description text would have mislabelled it.

---

## 6. Source viability (2026-10-10, measured on the Apify platform)

| Source | Datacenter | Residential | gzip / job | Verdict |
|---|---|---|---|---|
| **LinkedIn** | works (23-34% blocked under load) | works (~5% blocked) | **324 B** basic, 7.9 KB detail | **Shipping.** Cheapest source by far |
| **Glassdoor** | **100% blocked** (3/3) | **works, 3/3 OK, 90 jobs** | **5,844 B** | **Viable, residential-only** |
| **Naukri** | n/a | homepage 200, API **406** | - | **Blocked without a browser** |

### Naukri: why it is blocked

`jobapi/v3/search` answers every request with:

```json
{"message":"recaptcha required","statusCode":406,"validationErrors":[],"data":null}
```

This was reproduced from a residential Indian IP on a session that had just loaded the homepage
successfully (200, 14 KB), across **six** header/endpoint variants: `appid`+`systemid`,
`systemid=109`, `accept: application/json`, `+referer`+`x-requested-with`, `+clientid`, and no
custom headers at all. The gate is not cookies and not headers.

The HTML search page is not an alternative: it returns 200 / 36 KB but is a **Next.js App Router
shell with zero job data** — 0 bytes of visible text, and its 11 `__next_f` RSC flight chunks
contain only CSS and asset preloads. Listings are fetched client-side from the gated API.

So Naukri needs one of:

1. **A browser step** to mint a reCAPTCHA token / cookies, then reuse them for cheap HTTP API
   calls. A browser needs 2-4 GB vs our 256 MB, so it is 8-16× compute **while it runs**; it is
   only economic if one token serves many requests. Unverified — needs a spike.
2. An unblocking service (extra per-request cost).
3. **Dropping Naukri**, as the plan already dropped Upwork.

### Glassdoor: cost note

Glassdoor's search HTML is heavy — ~940 KB decoded (175 KB gzip) per 30-job page, i.e. **5,844 B
gzip per job, 18× LinkedIn's 324 B**. Residential is mandatory (datacenter is 100% blocked), so
this traffic is billed at ~$8/GB:

- **~$0.047 per 1,000 jobs** — about 10% of revenue at $0.60/1k, vs 0.26% for LinkedIn.

Still profitable, but it makes Glassdoor ~40× more expensive per job than LinkedIn. Moving to the
GraphQL endpoint (as planned) should cut this substantially and is the first optimisation to make
once Glassdoor ships.

---

## 7. Glassdoor, implemented (2026-10-10)

### What it took to get a 200

Glassdoor fingerprints the **request header shape**, not just the TLS handshake. Measured over
5 repeats each, on fresh residential sessions:

| Headers sent | Success |
|---|---|
| impit's bare Chrome profile | **0/5** |
| `accept-language` only | **0/5** |
| `accept-language` + `upgrade-insecure-requests: 1` | **4/5** |
| overriding `accept` with our own value | 0/5 |

So the Actor sends `upgrade-insecure-requests` (a real Chrome navigation header) and never
overrides `accept`. Two further requirements, each found by a failing run:

- **A cookie jar.** Without one every request 403s. Cookies are now on by default in `HttpClient`.
- **Residential, pinned to the US.** Datacenter is blocked 100%; unpinned residential exits also
  returned 403. `robots.txt` (6 KB) warms each new session.

A false lead worth recording: deterministic proxy session ids such as `glassdoor_residential_1`
make every run reuse the *same* IPs, including ones a previous run got blocked on. Session ids are
now scoped per run. That was not the cause of the 403s, but it is a real bug.

### The 30-result cap

Glassdoor's GET search returns 30 jobs and **cannot be paginated**. Every one of these returned the
identical 30 job ids: `?p=2`, `?p=3`, `?pageCursor=<cursor>`, `?p=2&pageCursor=<cursor>`, and the
SEO `_IP2`/`_IP3`/`_IP4` URLs. The page payload carries opaque `paginationCursors`
(`[{cursor, pageNumber}]`) and `totalJobsCount` (4,473 for one sample), but those belong to a POST
against its GraphQL endpoint; `/graph` answers 403 to anything simpler, and `/api/csrftoken` is 404.

The Actor therefore fetches **one page per query and stops**. Before this was understood it fetched
4 pages and discarded 90 duplicates, wasting ~525 KB gzip (~$0.004) of residential traffic per
query for zero extra jobs. More Glassdoor results per run currently means more keywords/locations.

Its search is also **session-stateful**: changing a filter param shifts the session's result set, so
later requests on that session inherit it. That invalidates naive A/B probing of filter params, and
is why age/work-type/job-type filtering is applied locally from the embedded payload instead of
through URL params.

### Location

`locKeyword`, `typedLocation` and `locName` are all ignored; the page derives location from the
proxy IP (`ipLocation` in the payload). What works is Glassdoor's own ids:

```
GET /autocomplete/location?term=Bangalore&locationTypeFilters=CITY,STATE,COUNTRY
 -> [{"locationId":2940587,"locationType":"C","locationName":"Bengaluru", ...}]
GET /Job/jobs.htm?sc.keyword=<kw>&locT=C&locId=2940587
```

### Measured output (production run, 2 keywords x Bangalore, 139 jobs, 4 s, $0.00286)

**$0.0206 per 1,000 jobs** for the two sources combined. The sources are complementary, which is
the product's main selling point over single-source competitors:

| Field | LinkedIn (basic, n=80) | Glassdoor (n=59) |
|---|---|---|
| title, company, location, url, postedAt | 100% | 100% |
| description | 0% (needs detail fetch) | **100%** (snippet included free) |
| salary | 0% | **75%**, with `salary.source` saying employer-provided vs estimated |
| skills | 0% | **100%** |
| companyRating | 0% | **86%** |
| jobFunction | 0% | **100%** |
| easyApply | 0% (needs detail fetch) | **100%** |
| jobType | 0% | 49% |
| activelyHiring / earlyApplicant | **100%** | n/a |

Glassdoor costs ~$0.046 per 1,000 jobs against LinkedIn's $0.0012 (residential, and ~175 KB gzip
per 30-job page), so it is ~38x more expensive per job while supplying the richer fields. Both stay
far inside the margin target.

---

## 8. Scale test: 1,000 jobs, measured end to end (2026-10-10)

### Correction to sections 2-3

**Apify's `usageTotalUsd` lags for several minutes after a run finishes.** The figures first
recorded in section 2 were read immediately and were too low by ~6x: the 60-job run read
$0.0000736 at the time and settled at **$0.00050**. Every number below was re-read after
settling, and re-read twice to confirm it had stopped moving. Treat sections 2-3 as superseded
by this section.

### Results

| Mode | Memory | Jobs | Duration | Billed | **USD / 1,000** | CU | Residential |
|---|---|---|---|---|---|---|---|
| basic | 256 MB | 854 | 87 s | $0.006431 | **$0.0075** | 0.0061 | 0.09 MB |
| basic | 512 MB | 868 | 83 s | $0.007215 | $0.0083 | 0.0116 | 0.05 MB |
| details | 256 MB | 500 | 210 s | $0.012618 | **$0.0252** | 0.0146 | 0.82 MB |
| details | 512 MB | 500 | 98 s | $0.014734 | $0.0295 | 0.0136 | 1.11 MB |
| details | 1024 MB | 500 | 58 s | $0.021705 | $0.0434 | 0.0162 | 1.93 MB |

One LinkedIn query yields about **854-868 unique jobs** before the ~1,000 cap bites (146 and 132
of the results were repeats). Getting past that needs query splitting by time window or location.

### What actually drives the cost

For a basic run the proxy is nearly free (0.09 MB residential across 854 jobs) and the bill is
dominated by **dataset writes plus compute**, not traffic. Dataset writes are billed per item, so
batching does not reduce them: there is a hard floor of roughly $0.005 per 1,000 jobs just for
storing results. That is the opposite of the assumption in PLAN.md that proxy traffic would be our
largest cost - true only for Glassdoor.

### Memory

Memory only matters for `fetchDetails`:

- **basic: 256 MB.** 512 MB is 4 s faster over 854 jobs and 10% dearer - not worth it.
- **details: 512 MB.** 2.1x faster than 256 MB for 17% more. 1024 MB is 3.6x faster but 72%
  dearer, and the extra speed also raises the block rate, which is why residential traffic climbs
  from 0.82 MB to 1.93 MB across the three runs.

`defaultMemoryMbytes` stays 256 because `fetchDetails` defaults to false; the input schema tells
users to raise it when they turn details on. `maxMemoryMbytes` is now 2048 so they can.

### Margin at the recommended prices (settled figures)

| Event | Price / 1k | We keep | Measured cost | Cost as % of revenue | Margin |
|---|---|---|---|---|---|
| `job` | $0.40 | $0.32 | $0.0075 | 2.3% | **97.7%** |
| `job-with-details` | $1.20 | $0.96 | $0.0295 | 3.1% | **96.9%** |

Still far inside the 25% target, and the conclusion of section 3 is unchanged: we can undercut the
~$1.00/1k market leader and keep ~97%.

### Quality at scale (500 detailed jobs)

500/500 enriched, 500/500 unique ids. description 100% (avg 3,173 chars, max 10,412),
applicants 100%, easyApply 100%, jobType 100%, industry 100%, experienceYears 77%,
experienceLevel 36%, salary 9% (Indian listings rarely publish pay), workType 8%.

Block rate at this pace was **5/105 requests (4.8%)** on datacenter, and all 5 escalated to
residential and succeeded - the proxy ladder behaving as designed, against the 23-34% measured
under deliberately aggressive concurrency in section 4.
