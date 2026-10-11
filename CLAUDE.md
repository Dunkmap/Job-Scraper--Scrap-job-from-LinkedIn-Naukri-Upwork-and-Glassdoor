# Project memory

## Guiding principle (from the owner — always follow)

> "Everything should be like the way that you are building this for making a good money from Apify."

This Actor is a commercial product on the Apify Store. Every decision must be judged on:

1. **Speed**: users pick the fastest Actor. HTTP-only, high concurrency, no browser unless there's no other way.
2. **Low cost to us**: under pay-per-event pricing, *we* pay the compute and proxy costs out of our 80% share.
   Profit = 0.8 × revenue − platform costs. Every MB of proxy traffic and every CU-second counts.
3. **Reliable, rich output**: one clean, unified schema across all sources, with no empty or broken results.
   Stability drives Store ranking and repeat users.

Before adding a feature, ask: does it make the Actor faster, cheaper to run, or more valuable per result?
Research every detail (endpoints, payload sizes, proxy needs). Measure, don't guess.

## Working rules

- See `PLAN.md` for architecture, pricing, and roadmap.
- Default to datacenter proxy. Escalate to residential only per-request, on block.
- Never fetch a detail page for a job that's already been seen (dedupe first, then enrich).
- Respect `maxItems` and the user's max-charge limit (`eventChargeLimitReached`). Stop the moment they're hit.
- Track cost per 1,000 results for every source in `docs/cost-benchmarks.md` after each change that affects it.
- Keep replies to the owner short: result first, few lines, no long explanations unless asked.
