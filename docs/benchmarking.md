# Benchmarking

How this repository measures whether a change makes `InMemoryCacheRs` faster or slower,
per PR and over time. The measurements come from the
[performance probe](probes/cache-performance-probe.mjs) (200 measurements in 14 sections);
everything below is about running it so the numbers can be trusted.

## What makes a number trustworthy

Shared CI runners are noisy: a single run swings microsecond measurements by tens of
percent even when nothing changed. So every comparison follows four rules.

1. **Same machine, same job, interleaved, symmetric.** Base and head are measured by one
   runner, in alternating order, never compared with numbers from another machine. Each
   side runs the same probe (head's, copied into the base checkout) inside its own
   checkout, against its own build and `node_modules`, so no process mixes two copies of
   Apollo Client or `graphql`. (Mixing them skewed the first benchmarks by up to 10×.)
2. **Apollo's `InMemoryCache` is the noise control.** It is identical code on both sides,
   so however far its timings move between the base and head runs is that job's noise.
   The *noise band* is the 90th percentile of that movement across all measurements.
3. **Significant means both:** the median moved by more than the noise band, **and** the
   base and head runs do not overlap at all. With 7 runs per side, two sets of runs of
   identical code fail to overlap by chance only 0.06% of the time (2 in C(14, 7)), so
   across 200 measurements a phantom change shows up about once in eight benchmarks.
   Anything else is reported as within noise.
4. **Ratios, not absolute times.** Head ÷ base shows what a PR did; `InMemoryCacheRs` ÷
   `InMemoryCache` shows how far the port has come. Neither depends on the runner.

Every section runs in a fresh Node process, 7 times per configuration (a configuration
is one cache on one side), with 25 timed repetitions per measurement.

## On a PR

Add the **`benchmark`** label. [`benchmark.yml`](../.github/workflows/benchmark.yml)
compares the PR head with its merge base, splits the sections across four parallel jobs
(each measures all four configurations of its sections on one runner), and posts one
comment on the PR, updated in place. It takes about 1 h 45 min: the slowest group of
sections (and section 7 on its own) is that long on GitHub's runners, which measured
about 2.6× slower than a recent laptop.

The label stays on: every push re-runs the benchmark (a new push cancels the running
one), and **merging waits for it**. The `Benchmark gate` check, required on `main`,
passes on a PR without the label, and on a labelled PR only once a benchmark of its
current commit has succeeded: it starts with the benchmark and stays pending until the
report is in ([`gate.mjs`](../scripts/bench/gate.mjs)). Removing the label opts out and
releases the gate. Changing other labels neither cancels a running benchmark nor passes
the gate. `Lint and typecheck` and `Tests and behaviour parity` are required too, and
every required check must have run against the latest `main` (the branch must be up to
date), for every PR, with no bypass.

You can also run the workflow by hand from the Actions tab (“Benchmark”, *Run workflow*)
for any branch, against any base, optionally posting to a PR.

The comment shows how many measurements got faster or slower beyond noise, the noise
band, `InMemoryCacheRs ÷ InMemoryCache`, the WASM size, a table of the significant
changes, and every measurement in a collapsed table. The raw samples are in the run's
artifacts.

## Over time

[`benchmark-history.yml`](../.github/workflows/benchmark-history.yml) runs nightly. When
`main` has changed since the last recorded run, it measures `InMemoryCacheRs` and
`InMemoryCache` on one runner (3 runs, full precision) and appends the result to the
**`benchmarks`** branch:

- `history.jsonl`: one line per measured commit
- `README.md`: the latest result and every run, readable on GitHub as is
- `index.html`: a trend chart of `InMemoryCacheRs ÷ InMemoryCache`, overall and per
  measurement (enable GitHub Pages for the `benchmarks` branch to serve it)
- `runs/`: the raw samples of each run

The trend plots the ratio because it is measured within one job: nights on different
runner hardware stay comparable.

## Locally

The workflows call the same scripts, so a local run follows exactly the CI path:

```bash
npm run bench:pr -- --base main                          # full comparison (slow)
npm run bench:pr -- --base main --quick --sections=1,2   # a quick look
```

`bench:pr` builds this checkout, builds the base in a temporary git worktree with its
own lockfile and pinned toolchain, copies head's probe into it, measures both, and
prints the comment. Useful
options: `--runs=N`, `--sections=1,2,3`, `--quick` (7 repetitions instead of 25),
`--out result.json` (keep the raw samples instead of printing). `npm run
probe:compare` is the lighter tool for this checkout alone: both caches, no base.

## Files

| File | Role |
| --- | --- |
| [`scripts/bench/pr.mjs`](../scripts/bench/pr.mjs) | Builds head and base, runs the comparison |
| [`scripts/bench/run.mjs`](../scripts/bench/run.mjs) | Runs the probe for every configuration, interleaved |
| [`scripts/bench/stats.mjs`](../scripts/bench/stats.mjs) | Noise band and significance |
| [`scripts/bench/report.mjs`](../scripts/bench/report.mjs) | The PR comment and the history summary |
| [`scripts/bench/comment.mjs`](../scripts/bench/comment.mjs) | Keeps the one PR comment up to date |
| [`scripts/bench/gate.mjs`](../scripts/bench/gate.mjs) | The `Benchmark gate` merge check |
| [`scripts/bench/history.mjs`](../scripts/bench/history.mjs), [`trend.html`](../scripts/bench/trend.html) | The `benchmarks` branch |

`npm run test:tooling` tests them.
