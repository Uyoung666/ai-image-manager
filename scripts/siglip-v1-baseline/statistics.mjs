/** Deterministic R-7 percentile and aggregation helpers for baseline reports. */

function finiteNumbers(values) {
  return values.filter(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
}

function round(value) {
  return Number(value.toFixed(3));
}

export function quantile(values, probability) {
  const sorted = finiteNumbers(values).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const bounded = Math.max(0, Math.min(1, probability));
  const position = (sorted.length - 1) * bounded;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

export function summarizeDistribution(values) {
  const finite = finiteNumbers(values);
  if (finite.length === 0) {
    return {
      count: 0,
      min: 0,
      p5: 0,
      p50: 0,
      median: 0,
      p95: 0,
      max: 0,
      range: 0,
      method: "linear-interpolation-r7",
    };
  }
  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  return {
    count: finite.length,
    min: round(minimum),
    p5: round(quantile(finite, 0.05)),
    p50: round(quantile(finite, 0.5)),
    median: round(quantile(finite, 0.5)),
    p95: round(quantile(finite, 0.95)),
    max: round(maximum),
    range: round(maximum - minimum),
    method: "linear-interpolation-r7",
  };
}

export function summarizeIntegerDistribution(values) {
  const summary = summarizeDistribution(values);
  const histogram = {};
  for (const value of finiteNumbers(values)) {
    const key = String(value);
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return { ...summary, histogram };
}

export function pickMedianTrial(trials, getValue) {
  if (trials.length === 0) {
    throw new Error("Cannot select a median trial from an empty collection");
  }
  return [...trials].sort((left, right) => getValue(left) - getValue(right))[
    Math.floor((trials.length - 1) / 2)
  ];
}
