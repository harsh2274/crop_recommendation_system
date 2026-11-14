export const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/** Linear-interpolated percentile, q in [0, 1]. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (a: number[]) => percentile(a, 0.5);

export const round = (v: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
