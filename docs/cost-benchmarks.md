# Cost benchmarks

Measured, not guessed. Every run saves `RUN_STATS` in its key-value store (requests, failures, blocks,
bytes and requests per proxy tier). Copy the numbers here after each change that affects cost.

Formula: cost per 1,000 jobs = (CU used × CU price + residential GB × GB price) / jobs × 1,000.
Target: cost ≤ 25% of the event price.

| Date | Source | Mode | Jobs | Duration | Memory | Requests | Blocked | Residential MB | Cost / 1k | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| _pending_ | linkedin | basic | | | 256 MB | | | | | Waiting for network access for recon |
