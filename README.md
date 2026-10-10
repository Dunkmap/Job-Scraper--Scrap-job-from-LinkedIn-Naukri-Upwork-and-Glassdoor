# Ultimate Job Scraper (LinkedIn + Glassdoor)

Apify Actor that scrapes job postings from **LinkedIn and Glassdoor in one run** into a single,
deduplicated dataset with one consistent schema. HTTP-only, no browser, no login.

See `PLAN.md` for architecture and `docs/cost-benchmarks.md` for measured costs and the
reverse-engineering notes behind every source.

## Status

| Source | State | What it gives you |
|---|---|---|
| **LinkedIn** | Verified against live responses | Full description, applicant count, employment type, industry, Easy Apply, required experience (parsed from the description), "Actively Hiring" / "Be an early applicant" badges |
| **Glassdoor** | Verified against live responses | Salary (with employer-provided vs estimated), skills, company rating, description snippet, job function, Easy Apply |
| Naukri | **Dropped** | Its API answers `recaptcha required` (406) to every request and its HTML page contains no job data. See `docs/cost-benchmarks.md` §6 |

The two sources are complementary: Glassdoor supplies salary, skills and company ratings that
LinkedIn's public pages never expose, and LinkedIn supplies volume and full descriptions.

## Known limits

- **Glassdoor returns 30 jobs per keyword + location.** Its GET search cannot be paginated
  (verified against `?p=`, `?pageCursor=` and the SEO `_IP` URLs). Use more keywords or locations
  for more results. Full pagination needs its GraphQL endpoint and is not implemented yet.
- **LinkedIn salary is detail-only** and rarely published outside the US; search cards carry no
  salary markup at all. Turn on `fetchDetails` to get it where it exists.
- Glassdoor requires a residential proxy; LinkedIn runs fine on datacenter.
- **One LinkedIn query returns ~854-868 unique jobs** before its ~1,000 cap. Use several keywords
  or locations for more; query splitting is not implemented yet.
- Turn memory up to **512 MB when using `fetchDetails`** - it is 2.1x faster than 256 MB for 17%
  more cost. Basic runs are cheapest at the 256 MB default.
- Fields a site genuinely does not expose are returned as `null`, never guessed.

## Pricing (pay-per-event)

Set in Apify Console → Monetization; there is no pricing field in `actor.json`. The Actor charges
exactly two event names:

| Event | Charged when | Suggested price |
|---|---|---|
| `job` | a job is stored with basic fields | $0.40 / 1,000 |
| `job-with-details` | a job is stored with the full description and criteria | $1.20 / 1,000 |

Measured platform cost at scale (854 and 500-job runs, read after usage settled):
**$0.0075 per 1,000** basic jobs and **$0.0295 per 1,000** with full details - about 2-3% of
revenue, so roughly a 97% margin. See `docs/cost-benchmarks.md` §8.

Throughput: ~854 jobs in 87 s basic (256 MB), or 500 fully-detailed jobs in 98 s (512 MB).

## Develop

```bash
npm install
npm test            # parser tests against real captured fixtures
npm run typecheck

echo '{"keywords":["react developer"],"locations":["India"],"maxItemsPerSource":5,"proxyConfiguration":{"useApifyProxy":false}}' \
  > storage/key_value_stores/default/INPUT.json
npm run start:dev
```

### Keeping the parsers honest

Both parsers are tested against **real captured responses** in `test/fixtures/`, so a markup change
fails CI instead of silently returning rows of nulls.

```bash
node tools/recon-linkedin.mjs        # refresh LinkedIn fixtures + audit every selector
npx tsx tools/fill-rate.mts          # per-field fill rates
cd tools/recon-actor && apify push   # block rates, bytes/job and site probes on the platform
```

`tools/recon-actor` is an internal Actor used to measure block rates per proxy tier and to probe a
site before a parser is written for it. It is not published.
