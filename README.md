# Ultimate Job Scraper (LinkedIn, Naukri, Glassdoor)

Apify Actor that scrapes jobs from several boards in one run into one clean, deduplicated dataset.
See `PLAN.md` for the architecture and roadmap.

## Status
- LinkedIn: implemented (parsers awaiting verification against live responses)
- Naukri: planned
- Glassdoor: planned

## Develop
```bash
npm install
npm test          # unit tests
npm run typecheck
echo '{"keywords":["react developer"],"locations":["India"],"maxItemsPerSource":5,"proxyConfiguration":{"useApifyProxy":false}}' \
  > storage/key_value_stores/default/INPUT.json
npm run start:dev
```
