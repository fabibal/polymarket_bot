/**
 * Minimal statistics helpers for the dashboard's go-live / edge-significance
 * panels. Self-contained (no deps) so it can run in the bot container.
 *
 * The two-tailed p-value uses the exact Student's-t survival function via the
 * regularized incomplete beta function (Numerical Recipes style), so it stays
 * accurate at small n during the ramp, not just in the large-n normal limit.
 */

const Z_95 = 1.959963984540054; // two-tailed 95% normal critical value

function gammln(xx: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let x = xx;
  let y = xx;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += cof[j] / y; }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// Continued fraction for the incomplete beta function (Lentz's method).
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

// Regularized incomplete beta I_x(a,b).
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    gammln(a + b) - gammln(a) - gammln(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-tailed p-value for a one-sample Student's-t statistic with `df` d.o.f. */
export function studentTwoTailedP(t: number, df: number): number {
  if (!isFinite(t) || df <= 0) return 1;
  const x = df / (df + t * t);
  return betai(df / 2, 0.5, x);
}

export interface GroupStats {
  n: number;
  mean: number;
  std: number;       // sample standard deviation (n-1)
  se: number;        // standard error of the mean
  tStat: number;     // one-sample t vs 0
  pValue: number;    // two-tailed
  ciLow: number;     // 95% CI on the mean (normal approx)
  ciHigh: number;
}

/** One-sample summary stats for a numeric series (e.g. per-trade cost-adjusted PNL). */
export function groupStats(values: number[]): GroupStats {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, std: 0, se: 0, tStat: 0, pValue: 1, ciLow: 0, ciHigh: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, std: 0, se: 0, tStat: 0, pValue: 1, ciLow: mean, ciHigh: mean };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  const se = std / Math.sqrt(n);
  const tStat = se > 0 ? mean / se : 0;
  const pValue = se > 0 ? studentTwoTailedP(tStat, n - 1) : 1;
  return { n, mean, std, se, tStat, pValue, ciLow: mean - Z_95 * se, ciHigh: mean + Z_95 * se };
}
