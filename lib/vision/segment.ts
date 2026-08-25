'use client';

/**
 * Classical person segmentation.
 *
 * There is deliberately no ML model here: the app must run fully offline with
 * zero downloads, and the capture UI actively steers the user into the setup
 * this solver is good at (subject centred, arms away from the body, plainish
 * background, even light).
 *
 * Pipeline: Lab conversion → background colour clustering from the border ring
 * → connectivity-constrained region growing → largest component → hole fill →
 * morphological cleanup. Three tolerances are tried and scored against an
 * anthropometric prior; the best-scoring mask wins.
 */

import type { BinaryMask } from '../types';
import { clamp01, deltaE, rgbToLab } from '../math';
import type { RasterImage } from '../imaging';

export const ANALYSIS_MAX_EDGE = 288;

export interface SegmentationResult {
  mask: BinaryMask;
  /** 0..1 plausibility of the mask under a human-shape prior. */
  score: number;
  /** True when we fell back to a template silhouette. */
  synthetic: boolean;
}

type Lab = Float32Array; // packed [L,a,b] * n

function toLab(img: RasterImage): Lab {
  const n = img.width * img.height;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const [L, a, b] = rgbToLab(img.data[j], img.data[j + 1], img.data[j + 2]);
    out[i * 3] = L;
    out[i * 3 + 1] = a;
    out[i * 3 + 2] = b;
  }
  return out;
}

function labAt(lab: Lab, i: number): [number, number, number] {
  return [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
}

/** k-means over the border ring — our model of "what the background looks like". */
function backgroundClusters(
  lab: Lab,
  w: number,
  h: number,
  k = 6,
): Array<[number, number, number]> {
  const ringX = Math.max(2, Math.round(w * 0.06));
  const ringY = Math.max(2, Math.round(h * 0.04));
  const samples: number[] = [];
  const push = (x: number, y: number) => samples.push(y * w + x);

  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < ringX; x++) push(x, y);
    for (let x = w - ringX; x < w; x++) push(x, y);
  }
  for (let x = 0; x < w; x += 2) {
    for (let y = 0; y < ringY; y++) push(x, y);
  }
  if (samples.length === 0) return [[50, 0, 0]];

  // Deterministic seeding: evenly spaced picks from the sample list.
  const centers: Array<[number, number, number]> = [];
  for (let c = 0; c < k; c++) {
    const idx = samples[Math.floor(((c + 0.5) / k) * samples.length)];
    centers.push(labAt(lab, idx));
  }

  const sums = new Float64Array(k * 3);
  const counts = new Int32Array(k);
  for (let iter = 0; iter < 6; iter++) {
    sums.fill(0);
    counts.fill(0);
    for (let s = 0; s < samples.length; s++) {
      const p = labAt(lab, samples[s]);
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = deltaE(p, centers[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      sums[best * 3] += p[0];
      sums[best * 3 + 1] += p[1];
      sums[best * 3 + 2] += p[2];
      counts[best]++;
    }
    for (let c = 0; c < k; c++) {
      if (!counts[c]) continue;
      centers[c] = [
        sums[c * 3] / counts[c],
        sums[c * 3 + 1] / counts[c],
        sums[c * 3 + 2] / counts[c],
      ];
    }
  }
  return centers;
}

/**
 * Connectivity-constrained background growth.
 *
 * A pixel joins the background if it is close to the global background colour
 * model OR close to the neighbour that reached it (which lets the fill walk
 * across a smoothly shaded wall without leaking through a hard body edge).
 */
function growBackground(
  lab: Lab,
  w: number,
  h: number,
  centers: Array<[number, number, number]>,
  tolModel: number,
  tolStep: number,
): Uint8Array {
  const n = w * h;
  const bg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;

  const modelDist = (i: number) => {
    const p = labAt(lab, i);
    let d = Infinity;
    for (let c = 0; c < centers.length; c++) {
      const dd = deltaE(p, centers[c]);
      if (dd < d) d = dd;
    }
    return d;
  };

  const seed = (i: number) => {
    if (bg[i]) return;
    if (modelDist(i) > tolModel * 1.6) return;
    bg[i] = 1;
    queue[qt++] = i;
  };

  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }

  while (qh < qt) {
    const i = queue[qh++];
    const x = i % w;
    const y = (i / w) | 0;
    const from = labAt(lab, i);
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const ny = y + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (bg[j]) continue;
      const p = labAt(lab, j);
      const stepOk = deltaE(p, from) < tolStep;
      const modelOk = modelDist(j) < tolModel;
      if (stepOk || modelOk) {
        bg[j] = 1;
        queue[qt++] = j;
      }
    }
  }
  return bg;
}

/** 4-connected largest component of value-1 pixels. Returns a new mask. */
function largestComponent(src: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const out = new Uint8Array(n);
  let bestLabel = -1;
  let bestSize = 0;
  let next = 0;

  for (let i = 0; i < n; i++) {
    if (!src[i] || label[i] >= 0) continue;
    const id = next++;
    let sp = 0;
    stack[sp++] = i;
    label[i] = id;
    let size = 0;
    while (sp > 0) {
      const p = stack[--sp];
      size++;
      const x = p % w;
      const y = (p / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + (d === 0 ? -1 : d === 1 ? 1 : 0);
        const ny = y + (d === 2 ? -1 : d === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!src[q] || label[q] >= 0) continue;
        label[q] = id;
        stack[sp++] = q;
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = id;
    }
  }
  if (bestLabel < 0) return out;
  for (let i = 0; i < n; i++) if (label[i] === bestLabel) out[i] = 1;
  return out;
}

/** Fill enclosed holes (e.g. a gap between arm and torso is NOT enclosed). */
function fillHoles(src: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const push = (i: number) => {
    if (!outside[i] && !src[i]) {
      outside[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w;
    const y = (p / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const ny = y + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      push(ny * w + nx);
    }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = src[i] || !outside[i] ? 1 : 0;
  return out;
}

function morph(
  src: Uint8Array,
  w: number,
  h: number,
  radius: number,
  dilate: boolean,
): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = dilate ? 0 : 1;
      for (let dy = -radius; dy <= radius && hit === (dilate ? 0 : 1); dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) {
          if (!dilate) hit = 0;
          continue;
        }
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) {
            if (!dilate) {
              hit = 0;
              break;
            }
            continue;
          }
          const v = src[yy * w + xx];
          if (dilate && v) {
            hit = 1;
            break;
          }
          if (!dilate && !v) {
            hit = 0;
            break;
          }
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

const close = (m: Uint8Array, w: number, h: number, r = 1) =>
  morph(morph(m, w, h, r, true), w, h, r, false);
const open = (m: Uint8Array, w: number, h: number, r = 1) =>
  morph(morph(m, w, h, r, false), w, h, r, true);

/** Score a candidate mask against a standing-human prior. */
function scoreMask(mask: Uint8Array, w: number, h: number): number {
  const n = w * h;
  let area = 0;
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  let cx = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      area++;
      cx += x;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (area < 64 || maxX < 0) return 0;
  cx /= area;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;

  const areaFrac = area / n;
  const aspect = bh / bw;
  const vSpan = bh / h;
  const fillRatio = area / (bw * bh);
  const centreErr = Math.abs(cx - w / 2) / (w / 2);

  // Head test: the top decile of the body should be much narrower than the max.
  let topW = 0;
  let maxW = 0;
  for (let y = minY; y <= maxY; y++) {
    let rowW = 0;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) rowW++;
    if (rowW > maxW) maxW = rowW;
    if (y <= minY + bh * 0.1 && rowW > topW) topW = rowW;
  }
  const headRatio = maxW > 0 ? topW / maxW : 1;

  const band = (v: number, lo: number, hi: number, soft: number) => {
    if (v >= lo && v <= hi) return 1;
    const d = v < lo ? lo - v : v - hi;
    return clamp01(1 - d / soft);
  };

  const s =
    0.2 * band(areaFrac, 0.07, 0.6, 0.12) +
    0.22 * band(aspect, 1.5, 4.6, 1.1) +
    0.2 * band(vSpan, 0.5, 1.0, 0.28) +
    0.14 * band(fillRatio, 0.28, 0.82, 0.2) +
    0.12 * clamp01(1 - centreErr / 0.6) +
    0.12 * band(headRatio, 0.08, 0.62, 0.22);

  return clamp01(s);
}

/**
 * Anthropometric template silhouette — the guaranteed fallback so the app
 * always returns an avatar even from an unusable photo.
 */
function templateMask(w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h);
  const top = h * 0.06;
  const bot = h * 0.98;
  const H = bot - top;
  const cx = w / 2;
  // Half-widths as a fraction of stature, by height above the sole.
  const profile: Array<[number, number]> = [
    [0.0, 0.055],
    [0.05, 0.045],
    [0.14, 0.038],
    [0.28, 0.042],
    [0.46, 0.05],
    [0.5, 0.095],
    [0.62, 0.075],
    [0.72, 0.09],
    [0.82, 0.118],
    [0.86, 0.05],
    [0.9, 0.048],
    [0.97, 0.042],
    [1.0, 0.02],
  ];
  const halfAt = (p: number) => {
    for (let i = 0; i < profile.length - 1; i++) {
      const [p0, v0] = profile[i];
      const [p1, v1] = profile[i + 1];
      if (p >= p0 && p <= p1) {
        const t = (p - p0) / (p1 - p0 || 1);
        return v0 + (v1 - v0) * t;
      }
    }
    return 0.02;
  };
  for (let y = 0; y < h; y++) {
    if (y < top || y > bot) continue;
    const p = 1 - (y - top) / H;
    const half = halfAt(p) * H;
    for (let x = 0; x < w; x++) {
      if (Math.abs(x - cx) <= half) m[y * w + x] = 1;
    }
  }
  // Arms in a relaxed A-pose so the landmark stage sees three runs.
  for (let y = 0; y < h; y++) {
    const p = 1 - (y - top) / H;
    if (p < 0.38 || p > 0.8) continue;
    const t = (0.8 - p) / 0.42;
    const off = (0.1 + 0.075 * t) * H;
    const r = (0.026 - 0.008 * t) * H;
    for (let s = -1; s <= 1; s += 2) {
      const ax = cx + s * off;
      for (let x = Math.floor(ax - r); x <= Math.ceil(ax + r); x++) {
        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        m[y * w + x] = 1;
      }
    }
  }
  return m;
}

export function segmentPerson(img: RasterImage): SegmentationResult {
  const w = img.width;
  const h = img.height;
  const lab = toLab(img);
  const centers = backgroundClusters(lab, w, h);

  const attempts: Array<[number, number]> = [
    [11, 5.5],
    [16, 8],
    [23, 11],
  ];

  let best: Uint8Array | null = null;
  let bestScore = 0;

  for (const [tolModel, tolStep] of attempts) {
    const bg = growBackground(lab, w, h, centers, tolModel, tolStep);
    const fg = new Uint8Array(w * h);
    for (let i = 0; i < fg.length; i++) fg[i] = bg[i] ? 0 : 1;

    let m = close(fg, w, h, 1);
    m = largestComponent(m, w, h);
    m = fillHoles(m, w, h);
    m = open(m, w, h, 1);
    m = largestComponent(m, w, h);

    const s = scoreMask(m, w, h);
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }

  if (!best || bestScore < 0.34) {
    return {
      mask: { width: w, height: h, data: templateMask(w, h) },
      score: 0.22,
      synthetic: true,
    };
  }

  return {
    mask: { width: w, height: h, data: best },
    score: bestScore,
    synthetic: false,
  };
}
