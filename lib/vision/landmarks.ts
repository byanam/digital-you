'use client';

/**
 * Silhouette → 2D anatomical landmarks.
 *
 * The capture guide asks for a relaxed A-pose, which means each torso scanline
 * decomposes into [arm | torso | arm] runs. Working on the *central run* rather
 * than the full row width is what makes the chest/waist/hip breadths usable —
 * a plain row-width profile would silently include both arms.
 */

import type {
  BinaryMask,
  CaptureView,
  Landmarks2D,
  Run,
  RowStats,
  SilhouetteAnalysis,
} from '../types';
import { clamp, clamp01, median, smooth1D } from '../math';

function extractRuns(mask: BinaryMask, y: number): Run[] {
  const { width, data } = mask;
  const runs: Run[] = [];
  let start = -1;
  const base = y * width;
  for (let x = 0; x < width; x++) {
    const on = data[base + x] === 1;
    if (on && start < 0) start = x;
    else if (!on && start >= 0) {
      runs.push({ x0: start, x1: x - 1 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ x0: start, x1: width - 1 });
  // Merge runs separated by a 1px gap (segmentation speckle).
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.x0 - last.x1 <= 2) last.x1 = r.x1;
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.x1 - r.x0 >= 1);
}

function runContaining(runs: Run[], x: number): Run | null {
  for (const r of runs) if (x >= r.x0 && x <= r.x1) return r;
  // Nearest run when the axis falls in a gap (e.g. between the legs).
  let best: Run | null = null;
  let bestD = Infinity;
  for (const r of runs) {
    const d = x < r.x0 ? r.x0 - x : x - r.x1;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return bestD <= 6 ? best : null;
}

/** Pick the run that most plausibly is the torso: widest run near the axis. */
function torsoRun(runs: Run[], axisX: number): Run | null {
  if (runs.length === 0) return null;
  if (runs.length === 1) return runs[0];
  let best: Run | null = null;
  let bestScore = -Infinity;
  for (const r of runs) {
    const w = r.x1 - r.x0 + 1;
    const c = (r.x0 + r.x1) / 2;
    const contains = axisX >= r.x0 && axisX <= r.x1 ? 1 : 0;
    const score = w * (contains ? 2.2 : 1) - Math.abs(c - axisX) * 1.4;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

interface Extent {
  crownY: number;
  soleY: number;
  minX: number;
  maxX: number;
  area: number;
}

function bodyExtent(mask: BinaryMask): Extent {
  const { width, height, data } = mask;
  let crownY = -1;
  let soleY = -1;
  let minX = width;
  let maxX = -1;
  let area = 0;
  for (let y = 0; y < height; y++) {
    const base = y * width;
    let rowHas = false;
    for (let x = 0; x < width; x++) {
      if (!data[base + x]) continue;
      rowHas = true;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    if (rowHas) {
      if (crownY < 0) crownY = y;
      soleY = y;
    }
  }
  return { crownY, soleY, minX, maxX, area };
}

/** Convert "fraction of stature above the sole" to an image row. */
function pToY(p: number, crownY: number, pixelHeight: number) {
  return crownY + (1 - p) * pixelHeight;
}

interface BandResult {
  y: number;
  p: number;
  value: number;
}

/**
 * Search a normalised height band for an extremum of the torso-run width.
 * The width profile is pre-smoothed to kill single-row segmentation noise.
 */
function findBand(
  widths: Float64Array,
  crownY: number,
  pixelHeight: number,
  pLo: number,
  pHi: number,
  mode: 'max' | 'min',
): BandResult {
  const yLo = Math.round(pToY(pHi, crownY, pixelHeight));
  const yHi = Math.round(pToY(pLo, crownY, pixelHeight));
  let bestY = Math.round((yLo + yHi) / 2);
  let bestV = mode === 'max' ? -Infinity : Infinity;
  for (let y = Math.min(yLo, yHi); y <= Math.max(yLo, yHi); y++) {
    if (y < 0 || y >= widths.length) continue;
    const v = widths[y];
    if (v <= 0) continue;
    if (mode === 'max' ? v > bestV : v < bestV) {
      bestV = v;
      bestY = y;
    }
  }
  if (!isFinite(bestV)) bestV = 0;
  return {
    y: bestY,
    p: clamp01(1 - (bestY - crownY) / pixelHeight),
    value: bestV,
  };
}

/** Mean torso width across a ±band around y, ignoring empty rows. */
function bandMean(widths: Float64Array, y: number, halfPx: number) {
  let s = 0;
  let c = 0;
  for (let i = Math.round(y - halfPx); i <= Math.round(y + halfPx); i++) {
    if (i < 0 || i >= widths.length) continue;
    if (widths[i] <= 0) continue;
    s += widths[i];
    c++;
  }
  return c ? s / c : 0;
}

/** Which way is the subject facing in a profile shot? The toes give it away. */
function detectFacing(
  rows: RowStats[],
  crownY: number,
  pixelHeight: number,
): 1 | -1 {
  const ankleY = Math.round(pToY(0.09, crownY, pixelHeight));
  const toeY0 = Math.round(pToY(0.035, crownY, pixelHeight));
  const toeY1 = Math.round(pToY(0.004, crownY, pixelHeight));

  const ankleCentres: number[] = [];
  for (let y = ankleY - 3; y <= ankleY + 3; y++) {
    const r = rows[y];
    if (!r || r.x1 < 0) continue;
    ankleCentres.push((r.x0 + r.x1) / 2);
  }
  const ankleCx = ankleCentres.length ? median(ankleCentres) : NaN;
  if (!isFinite(ankleCx)) return 1;

  let front = 0;
  let back = 0;
  for (let y = Math.min(toeY0, toeY1); y <= Math.max(toeY0, toeY1); y++) {
    const r = rows[y];
    if (!r || r.x1 < 0) continue;
    front += Math.max(0, r.x1 - ankleCx);
    back += Math.max(0, ankleCx - r.x0);
  }
  return front >= back ? 1 : -1;
}

export function analyzeSilhouette(
  mask: BinaryMask,
  view: CaptureView,
  segScore: number,
): SilhouetteAnalysis {
  const { width, height } = mask;
  const ext = bodyExtent(mask);

  // Degenerate mask — hand back a neutral analysis with zero confidence.
  if (ext.crownY < 0 || ext.soleY <= ext.crownY) {
    const rows: RowStats[] = Array.from({ length: height }, () => ({
      runs: [],
      torsoWidth: 0,
      torsoCenter: NaN,
      total: 0,
      x0: -1,
      x1: -1,
    }));
    return {
      view,
      mask,
      rows,
      landmarks: neutralLandmarks(width, height),
    };
  }

  const pixelHeight = ext.soleY - ext.crownY + 1;

  // Pass 1: raw runs + a first axis estimate from the torso band centroid.
  const rawRuns: Run[][] = new Array(height);
  for (let y = 0; y < height; y++) rawRuns[y] = extractRuns(mask, y);

  const axisSamples: number[] = [];
  for (let p = 0.45; p <= 0.78; p += 0.01) {
    const y = Math.round(pToY(p, ext.crownY, pixelHeight));
    const runs = rawRuns[y];
    if (!runs || runs.length === 0) continue;
    // Weighted centroid of the row — arms cancel out when the pose is symmetric.
    let sum = 0;
    let cnt = 0;
    for (const r of runs) {
      for (let x = r.x0; x <= r.x1; x++) {
        sum += x;
        cnt++;
      }
    }
    if (cnt) axisSamples.push(sum / cnt);
  }
  const axisX = axisSamples.length
    ? median(axisSamples)
    : (ext.minX + ext.maxX) / 2;

  // Pass 2: row stats using the axis to disambiguate torso from arms.
  const rows: RowStats[] = new Array(height);
  const torsoWidthsRaw = new Float64Array(height);
  const fullWidthsRaw = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    const runs = rawRuns[y];
    let total = 0;
    let x0 = -1;
    let x1 = -1;
    for (const r of runs) {
      total += r.x1 - r.x0 + 1;
      if (x0 < 0 || r.x0 < x0) x0 = r.x0;
      if (r.x1 > x1) x1 = r.x1;
    }
    const t = torsoRun(runs, axisX);
    const tw = t ? t.x1 - t.x0 + 1 : 0;
    rows[y] = {
      runs,
      torsoWidth: tw,
      torsoCenter: t ? (t.x0 + t.x1) / 2 : NaN,
      total,
      x0,
      x1,
    };
    torsoWidthsRaw[y] = tw;
    fullWidthsRaw[y] = x1 >= 0 ? x1 - x0 + 1 : 0;
  }

  const smoothR = Math.max(1, Math.round(pixelHeight * 0.006));
  const torsoWidths = smooth1D(torsoWidthsRaw.slice(), smoothR, 2);
  const fullWidths = smooth1D(fullWidthsRaw.slice(), smoothR, 2);

  // Are the arms separated from the torso? Count 3-run rows in the arm band.
  let threeRunRows = 0;
  let armBandRows = 0;
  for (let p = 0.5; p <= 0.72; p += 0.01) {
    const y = Math.round(pToY(p, ext.crownY, pixelHeight));
    const r = rows[y];
    if (!r) continue;
    armBandRows++;
    if (r.runs.length >= 3) threeRunRows++;
  }
  const armsSeparated = armBandRows > 0 && threeRunRows / armBandRows > 0.45;

  // When the arms are glued to the torso, the central run over-reports torso
  // breadth. This empirical factor recovers a usable estimate at lower trust.
  const GLUED_TORSO_FACTOR = 0.72;
  const torsoAt = (y: number, halfPx: number) => {
    const v = bandMean(torsoWidths, y, halfPx);
    return armsSeparated ? v : v * GLUED_TORSO_FACTOR;
  };

  const hp = Math.max(1, pixelHeight * 0.012);

  const neck = findBand(torsoWidths, ext.crownY, pixelHeight, 0.83, 0.905, 'min');
  const shoulder = findBand(torsoWidths, ext.crownY, pixelHeight, 0.755, 0.85, 'max');
  const chest = findBand(torsoWidths, ext.crownY, pixelHeight, 0.655, 0.755, 'max');
  const waist = findBand(torsoWidths, ext.crownY, pixelHeight, 0.555, 0.665, 'min');
  const hip = findBand(torsoWidths, ext.crownY, pixelHeight, 0.45, 0.565, 'max');
  const head = findBand(torsoWidths, ext.crownY, pixelHeight, 0.905, 0.985, 'max');

  // Armpit: scanning down from the shoulder, the first row that splits into 3.
  let armpitY = Math.round(pToY(0.755, ext.crownY, pixelHeight));
  for (let y = shoulder.y; y < Math.round(pToY(0.62, ext.crownY, pixelHeight)); y++) {
    if (rows[y] && rows[y].runs.length >= 3) {
      armpitY = y;
      break;
    }
  }

  // Crotch: scanning down from the hip, the first row where the central run
  // no longer spans the axis (the legs have separated).
  let crotchY = Math.round(pToY(0.48, ext.crownY, pixelHeight));
  const crotchSearchEnd = Math.round(pToY(0.3, ext.crownY, pixelHeight));
  for (let y = hip.y; y < Math.min(crotchSearchEnd, height); y++) {
    const r = rows[y];
    if (!r) continue;
    const central = runContaining(r.runs, axisX);
    const legRuns = r.runs.filter(
      (run) => run.x1 - run.x0 + 1 > pixelHeight * 0.02,
    );
    if (!central || (legRuns.length >= 2 && !(axisX >= central.x0 && axisX <= central.x1))) {
      crotchY = y;
      break;
    }
  }

  const kneeBand = findBand(fullWidths, ext.crownY, pixelHeight, 0.24, 0.335, 'min');
  const ankleBand = findBand(fullWidths, ext.crownY, pixelHeight, 0.04, 0.125, 'min');

  // Limb breadths — measure a single limb, not the pair.
  const limbBreadth = (p: number, side: 'inner' | 'outer'): number => {
    const y = Math.round(pToY(p, ext.crownY, pixelHeight));
    const samples: number[] = [];
    for (let yy = y - Math.round(hp); yy <= y + Math.round(hp); yy++) {
      const r = rows[yy];
      if (!r) continue;
      const cands = r.runs.filter(
        (run) => run.x1 - run.x0 + 1 > pixelHeight * 0.012,
      );
      if (cands.length === 0) continue;
      if (side === 'inner') {
        // Legs: the two runs straddling the axis.
        const legs = cands.filter(
          (run) => Math.abs((run.x0 + run.x1) / 2 - axisX) < pixelHeight * 0.14,
        );
        const pick = legs.length >= 2 ? legs : cands;
        samples.push(median(pick.map((run) => run.x1 - run.x0 + 1)));
      } else {
        // Arms: the outermost runs.
        const outer = cands
          .slice()
          .sort(
            (a, b) =>
              Math.abs((b.x0 + b.x1) / 2 - axisX) -
              Math.abs((a.x0 + a.x1) / 2 - axisX),
          );
        const arms = outer.slice(0, Math.min(2, outer.length));
        samples.push(median(arms.map((run) => run.x1 - run.x0 + 1)));
      }
    }
    return samples.length ? median(samples) : 0;
  };

  const legsSplit = crotchY < Math.round(pToY(0.33, ext.crownY, pixelHeight));

  const thighBreadth = legsSplit
    ? limbBreadth(0.42, 'inner')
    : torsoAt(pToY(0.42, ext.crownY, pixelHeight), hp) * 0.48;
  const calfBreadth = legsSplit
    ? limbBreadth(0.215, 'inner')
    : torsoAt(pToY(0.215, ext.crownY, pixelHeight), hp) * 0.42;
  const upperArmBreadth = armsSeparated
    ? limbBreadth(0.7, 'outer')
    : chest.value * 0.19;
  const forearmBreadth = armsSeparated
    ? limbBreadth(0.55, 'outer')
    : chest.value * 0.155;

  // Elbow / wrist: minima of the arm-run width when we can see the arms.
  let elbowY = Math.round(pToY(0.63, ext.crownY, pixelHeight));
  let wristY = Math.round(pToY(0.485, ext.crownY, pixelHeight));
  if (armsSeparated) {
    let bestElbow = Infinity;
    for (let p = 0.585; p <= 0.675; p += 0.005) {
      const v = limbBreadth(p, 'outer');
      if (v > 0 && v < bestElbow) {
        bestElbow = v;
        elbowY = Math.round(pToY(p, ext.crownY, pixelHeight));
      }
    }
    let bestWrist = Infinity;
    for (let p = 0.44; p <= 0.525; p += 0.005) {
      const v = limbBreadth(p, 'outer');
      if (v > 0 && v < bestWrist) {
        bestWrist = v;
        wristY = Math.round(pToY(p, ext.crownY, pixelHeight));
      }
    }
  }

  // Confidence: segmentation quality, pose readability and framing.
  const touchesBottom = ext.soleY >= height - 2;
  const touchesTop = ext.crownY <= 1;
  const framing =
    clamp01(pixelHeight / (height * 0.72)) *
    (touchesBottom ? 0.85 : 1) *
    (touchesTop ? 0.9 : 1);
  const poseTrust = armsSeparated ? 1 : 0.72;
  const legTrust = legsSplit ? 1 : 0.85;
  const confidence = clamp01(
    0.45 * segScore + 0.25 * framing + 0.18 * poseTrust + 0.12 * legTrust,
  );

  const landmarks: Landmarks2D = {
    crownY: ext.crownY,
    soleY: ext.soleY,
    pixelHeight,
    axisX,
    chinY: neck.y - pixelHeight * 0.012,
    neckY: neck.y,
    shoulderY: shoulder.y,
    armpitY,
    chestY: chest.y,
    waistY: waist.y,
    hipY: hip.y,
    crotchY,
    kneeY: kneeBand.y,
    ankleY: ankleBand.y,
    elbowY,
    wristY,
    headBreadth: bandMean(torsoWidths, head.y, hp),
    neckBreadth: torsoAt(neck.y, hp * 0.7),
    shoulderBreadth: bandMean(torsoWidths, shoulder.y, hp * 0.7),
    chestBreadth: torsoAt(chest.y, hp),
    waistBreadth: torsoAt(waist.y, hp),
    hipBreadth: torsoAt(hip.y, hp),
    thighBreadth,
    calfBreadth,
    upperArmBreadth,
    forearmBreadth,
    confidence,
    facing: view === 'profile' ? detectFacing(rows, ext.crownY, pixelHeight) : 1,
  };

  return { view, mask, rows, landmarks };
}

function neutralLandmarks(width: number, height: number): Landmarks2D {
  const pixelHeight = height * 0.9;
  const crownY = height * 0.05;
  const y = (p: number) => crownY + (1 - p) * pixelHeight;
  return {
    crownY,
    soleY: crownY + pixelHeight,
    pixelHeight,
    axisX: width / 2,
    chinY: y(0.87),
    neckY: y(0.855),
    shoulderY: y(0.818),
    armpitY: y(0.755),
    chestY: y(0.72),
    waistY: y(0.62),
    hipY: y(0.52),
    crotchY: y(0.48),
    kneeY: y(0.285),
    ankleY: y(0.06),
    elbowY: y(0.63),
    wristY: y(0.485),
    headBreadth: pixelHeight * 0.095,
    neckBreadth: pixelHeight * 0.068,
    shoulderBreadth: pixelHeight * 0.232,
    chestBreadth: pixelHeight * 0.176,
    waistBreadth: pixelHeight * 0.147,
    hipBreadth: pixelHeight * 0.186,
    thighBreadth: pixelHeight * 0.1,
    calfBreadth: pixelHeight * 0.068,
    upperArmBreadth: pixelHeight * 0.06,
    forearmBreadth: pixelHeight * 0.05,
    confidence: 0,
    facing: 1,
  };
}

/** Nearest-neighbour mask resample — used to align masks to a render size. */
export function resampleMask(
  mask: BinaryMask,
  width: number,
  height: number,
): BinaryMask {
  const out = new Uint8Array(width * height);
  const sx = mask.width / width;
  const sy = mask.height / height;
  for (let y = 0; y < height; y++) {
    const my = clamp((y * sy) | 0, 0, mask.height - 1);
    for (let x = 0; x < width; x++) {
      const mx = clamp((x * sx) | 0, 0, mask.width - 1);
      out[y * width + x] = mask.data[my * mask.width + mx];
    }
  }
  return { width, height, data: out };
}
