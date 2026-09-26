# Benchmarking

How this repository measures whether a change makes `InMemoryCacheRs` faster or slower,
and larger or smaller, per PR and over time. The measurements come from the
[performance probe](probes/cache-performance-probe.mjs) (200 measurements in 14 sections)
and the [memory probe](probes/cache-memory-probe.mjs) ([Memory](#memory)).
Everything below is about running them so the numbers can be trusted.

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
current commit has succeeded ([`gate.mjs`](../scripts/bench/gate.mjs)). It is a commit
status, set by `benchmark-comment.yml` after every push, label change and benchmark:
pending while the benchmark runs, then success or failure. Removing the label opts out and
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

## Memory

Speed is half the comparison. The [memory probe](probes/cache-memory-probe.mjs) measures
what each cache holds and how much garbage it makes, and it runs through the same
pipeline as the performance probe: the same fresh process per section, the same
interleaving, and Apollo as the noise control. The PR comment has a Memory section
after the Performance one. The nightly history records both, and its trend page plots
either.

```bash
npm run probe:memory -- --runs=5                        # both reports, for Apollo
npm run probe:memory -- --cache=rs --sections=1,3       # InMemoryCacheRs, two sections
npm run probe:compare -- --probe=memory --runs=3        # side by side, with ratios
npm run bench:pr -- --base main --probe=memory          # head vs base, like CI
```

**What it measures.** Three kinds of result:

| Kind | Question | How |
| --- | --- | --- |
| **Retained bytes** | What does the cache keep alive: store, result memo, watches, layers? | the difference between two settled heaps: collect garbage until the heap stops shrinking, including finalizer turns |
| **Allocated bytes** | How much garbage does an operation create, whether or not it survives? | the heap's growth over the operation, plus what every collection during it reclaimed, as reported by `v8.GCProfiler` |
| **Checks** | Does memory come back: after eviction, after dropping a cache, under a steady workload? | pass or fail with a stated tolerance. A ratio cannot express these, because the healthy value is zero |

The sections, each in its own process:

1. Retained footprint against list size: store, the read memo, a watched query.
2. Retained footprint by data shape.
3. Allocation per operation: writes, reads, broadcasts, batches.
4. Watches, distinct documents and optimistic layers.
5. Steady workloads, which must plateau.
6. Reclamation: evict plus `gc()`, dropping a cache, reusing WASM memory.

**WASM is counted by what is in use.** A WASM module's linear memory only grows, and
JavaScript cannot see inside it. The crate's global allocator counts bytes in use, the
peak, and the total ever allocated (`wasm/src/heap_stats.rs`). The probe charges a cache
for its bytes in use, and its allocation measurements include WASM allocations. A build
that predates the counters falls back to the growth of linear memory.

**Traps the harness avoids.** Each of these produced a wrong number during development:

- **A cache in an async function's local variable.** V8 saves a suspended async
  function's registers. A local read after one `await` stays reachable through that
  saved state even after the code is done with it, so a leak check reads a leak. A local
  never read after an `await` is not saved, so a retained measurement reads zero. The
  harness holds measured objects in a registry by id, and touches them only inside
  synchronous callbacks (`hold`, `use`, `drop` in
  [`memory-harness.mjs`](probes/memory-harness.mjs)).
- **Documents built with `gql`.** graphql-tag keeps every document it has parsed, so
  per-document costs would never come back. Churned documents are built with `graphql`'s
  `parse`.
- **One-time costs.** Compiled code, parsed documents and module-level caches are paid
  by an unmeasured warm-up run of each workload at a small size.
- **Payload memory.** Payloads are built inside the measured step and dropped after it.
  A retained measurement therefore counts what the cache keeps of them (Apollo stores
  leaf values by reference), and nothing the probe keeps.

**Reading a result.**
- Retained measurements are deterministic to within a few KiB.
- Allocation is the median of several repetitions and is almost as steady.
- The report gives memory its own noise band, because memory is far less noisy than
  timing, and says *smaller* and *larger* instead of *faster* and *slower*.
- A check that fails for both caches describes Apollo's behaviour, not a regression. The
  comment calls out checks that passed on the base and fail on the PR.

The committed Apollo baseline is
[`probes/cache-memory-probe.log`](probes/cache-memory-probe.log) (five runs, rendered
from [`probes/cache-memory-probe.json`](probes/cache-memory-probe.json)). The
[performance guide's Part 10](performance/10-memory.md) interprets it.

## Files

| File | Role |
| --- | --- |
| [`docs/probes/cache-memory-probe.mjs`](probes/cache-memory-probe.mjs), [`memory-harness.mjs`](probes/memory-harness.mjs) | The memory probe and its measurement primitives |
| [`wasm/src/heap_stats.rs`](../wasm/src/heap_stats.rs) | The WASM heap counters the memory probe reads |
| [`scripts/bench/pr.mjs`](../scripts/bench/pr.mjs) | Builds head and base, runs the comparison |
| [`scripts/bench/run.mjs`](../scripts/bench/run.mjs) | Runs the probe for every configuration, interleaved |
| [`scripts/bench/stats.mjs`](../scripts/bench/stats.mjs) | Noise band and significance |
| [`scripts/bench/report.mjs`](../scripts/bench/report.mjs) | The PR comment and the history summary |
| [`scripts/bench/comment.mjs`](../scripts/bench/comment.mjs) | Keeps the one PR comment up to date |
| [`scripts/bench/gate.mjs`](../scripts/bench/gate.mjs) | The `Benchmark gate` merge check |
| [`scripts/bench/history.mjs`](../scripts/bench/history.mjs), [`trend.html`](../scripts/bench/trend.html) | The `benchmarks` branch |

`npm run test:tooling` tests them.
