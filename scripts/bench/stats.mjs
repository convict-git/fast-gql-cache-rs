/**
 * Statistics for the benchmark comparison. Every measurement is a set of
 * per-run medians (one per fresh-process run), for each cache on each side.
 */

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function geomean(ratios) {
  return Math.exp(
    ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length
  );
}

/**
 * The run's noise band, as a log-ratio: the 90th percentile (nearest rank) of
 * how far Apollo's `InMemoryCache` moved between the base and head runs. That
 * cache is the same code on both sides, so any movement is noise.
 */
export function noiseBand(aaRatios) {
  const deviations = aaRatios
    .map((r) => Math.abs(Math.log(r)))
    .sort((a, b) => a - b);
  return deviations[Math.ceil(0.9 * deviations.length) - 1];
}

/**
 * Head vs base for one measurement: significant when the medians differ by
 * more than the noise band AND the two sets of runs do not overlap at all.
 */
export function classify(base, head, band) {
  const ratio = median(head) / median(base);
  const separated =
    Math.max(...head) < Math.min(...base) ||
    Math.min(...head) > Math.max(...base);
  const verdict =
    !separated || Math.abs(Math.log(ratio)) <= band ? "noise"
    : ratio < 1 ? "faster"
    : "slower";
  return { ratio, verdict };
}
