/** Small, dependency-free numeric helpers used across the pipeline. */

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number) => clamp(v, 0, 1);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number) =>
  a === b ? 0 : (v - a) / (b - a);

export function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-9));
  return t * t * (3 - 2 * t);
}

/** Polynomial smooth minimum — the C1 blend that makes SDF unions organic. */
export function smin(a: number, b: number, k: number) {
  if (k <= 0) return Math.min(a, b);
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}

/** Smooth maximum (used for subtractions / creases). */
export function smax(a: number, b: number, k: number) {
  return -smin(-a, -b, k);
}

export function mean(xs: ArrayLike<number>) {
  if (xs.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s / xs.length;
}

export function median(xs: number[]) {
  if (xs.length === 0) return 0;
  const a = xs.slice().sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

/** Percentile with linear interpolation, p in [0,1]. */
export function percentile(xs: number[], p: number) {
  if (xs.length === 0) return 0;
  const a = xs.slice().sort((q, r) => q - r);
  const idx = clamp(p, 0, 1) * (a.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lerp(a[lo], a[hi], idx - lo);
}

/** In-place 1D box blur, `radius` taps each side, `passes` times (≈ gaussian). */
export function smooth1D(src: Float64Array, radius: number, passes = 2) {
  const n = src.length;
  if (n === 0 || radius < 1) return src;
  let cur = src;
  const tmp = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      let c = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        s += cur[j];
        c++;
      }
      tmp[i] = s / (c || 1);
    }
    cur.set(tmp);
  }
  return cur;
}

/**
 * Monotone cubic Hermite interpolator (Fritsch–Carlson).
 *
 * Used for every anatomical profile curve: unlike Catmull-Rom it never
 * overshoots, so a waist measurement can't produce a phantom bulge above it.
 */
export class MonotoneCurve {
  private readonly xs: number[];
  private readonly ys: number[];
  private readonly ms: number[];

  constructor(points: Array<[number, number]>) {
    const pts = points.slice().sort((a, b) => a[0] - b[0]);
    this.xs = pts.map((p) => p[0]);
    this.ys = pts.map((p) => p[1]);
    const n = this.xs.length;
    const dx: number[] = [];
    const dy: number[] = [];
    const slope: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      dx[i] = this.xs[i + 1] - this.xs[i] || 1e-9;
      dy[i] = this.ys[i + 1] - this.ys[i];
      slope[i] = dy[i] / dx[i];
    }
    const m: number[] = new Array(n);
    m[0] = slope[0] ?? 0;
    m[n - 1] = slope[n - 2] ?? 0;
    for (let i = 1; i < n - 1; i++) {
      if (slope[i - 1] * slope[i] <= 0) m[i] = 0;
      else m[i] = (slope[i - 1] + slope[i]) / 2;
    }
    // Enforce monotonicity.
    for (let i = 0; i < n - 1; i++) {
      if (slope[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / slope[i];
      const b = m[i + 1] / slope[i];
      const h = Math.hypot(a, b);
      if (h > 3) {
        const t = 3 / h;
        m[i] = t * a * slope[i];
        m[i + 1] = t * b * slope[i];
      }
    }
    this.ms = m;
  }

  at(x: number): number {
    const { xs, ys, ms } = this;
    const n = xs.length;
    if (n === 0) return 0;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const h = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[lo] + h10 * h * ms[lo] + h01 * ys[hi] + h11 * h * ms[hi];
  }
}

/**
 * Perimeter of the superellipse |x/a|^n + |z/b|^n = 1, by quadrature.
 * Human cross-sections are much closer to n≈2.6–3.0 than to an ellipse (n=2),
 * which is why an ellipse formula under-reports chest circumference by ~8%.
 */
export function superellipsePerimeter(a: number, b: number, n: number, steps = 256) {
  let prevX = a;
  let prevZ = 0;
  let per = 0;
  const inv = 2 / n;
  for (let i = 1; i <= steps; i++) {
    const th = (i / steps) * (Math.PI * 2);
    const c = Math.cos(th);
    const s = Math.sin(th);
    const x = Math.sign(c) * Math.pow(Math.abs(c), inv) * a;
    const z = Math.sign(s) * Math.pow(Math.abs(s), inv) * b;
    per += Math.hypot(x - prevX, z - prevZ);
    prevX = x;
    prevZ = z;
  }
  return per;
}

/** sRGB → CIE L*a*b*. Input 0..255, output L 0..100, a/b roughly -128..127. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = f(r);
  const G = f(g);
  const B = f(b);
  // D65
  let X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  let Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  let Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const g3 = (t: number) =>
    t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  X = g3(X);
  Y = g3(Y);
  Z = g3(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

export function deltaE(
  a: [number, number, number],
  b: [number, number, number],
) {
  // Weighted CIE76 — luminance is down-weighted so shadows on a wall don't
  // read as "different material" during background flood fill.
  const dL = (a[0] - b[0]) * 0.55;
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** Yield to the browser so long solves keep the UI at 60fps. */
export const nextFrame = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });
