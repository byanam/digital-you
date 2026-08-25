'use client';

/**
 * Fitting the parametric body to the photographed silhouette.
 *
 * The measurement stage produces breadths and depths in centimetres, but a
 * shape parameter is not the same thing as a measurement: the SDF blends
 * deltoid into pectoral, gluteus into thigh, so pushing `chest` to 1.1 does not
 * widen the chest section by exactly 10%. Rather than guess the Jacobian we
 * measure the model the same way we measured the photo — as a scanline run —
 * and iterate. Four damped Gauss–Seidel passes get every site inside a few
 * millimetres.
 *
 * The same machinery then reports the delivered mesh's real circumferences, so
 * the telemetry panel describes the model the user is looking at rather than a
 * formula applied to the photo.
 */

import type { ShapeParams } from '../types';
import { clamp } from '../math';
import { createBodyField, type BodyField } from './anatomy';

export interface FitTargets {
  /** All in metres. Half-widths are half of a frontal breadth. */
  shoulderHalf: number;
  chestHalf: number;
  waistHalf: number;
  hipHalf: number;
  chestDepth: number;
  waistDepth: number;
  hipDepth: number;
  thighWidth: number;
  calfWidth: number;
  /** 0..1 — how much to believe the measurements. */
  trust: number;
}

type Sdf = BodyField['sdf'];

/** Sagittal position of the body centreline at a given height. */
function centreZ(sdf: Sdf, y: number, zRange: number): number {
  let bestZ = 0;
  let bestD = Infinity;
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const z = -zRange + (2 * zRange * i) / steps;
    const d = sdf(0, y, z);
    if (d < bestD) {
      bestD = d;
      bestZ = z;
    }
  }
  return bestZ;
}

interface Run {
  x0: number;
  x1: number;
}

/**
 * Occupancy runs along x at a given height, measured the way the vision stage
 * measures a photo row. Sampling a few z planes near the centreline captures
 * the widest x extent of every convex cross-section.
 */
function rowRuns(sdf: Sdf, y: number, cz: number, xMax: number, step: number): Run[] {
  const zs = [cz, cz - 0.03, cz + 0.03, cz - 0.06, cz + 0.06];
  const runs: Run[] = [];
  let start = NaN;
  for (let x = -xMax; x <= xMax; x += step) {
    let on = false;
    for (let k = 0; k < zs.length; k++) {
      if (sdf(x, y, zs[k]) < 0) {
        on = true;
        break;
      }
    }
    if (on && isNaN(start)) start = x;
    else if (!on && !isNaN(start)) {
      runs.push({ x0: start, x1: x - step });
      start = NaN;
    }
  }
  if (!isNaN(start)) runs.push({ x0: start, x1: xMax });
  // Bridge sub-centimetre gaps, matching the vision stage's speckle merge.
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.x0 - last.x1 <= step * 1.5) last.x1 = r.x1;
    else merged.push({ ...r });
  }
  return merged;
}

/** Half-width of the run straddling the body axis. */
function centralHalf(sdf: Sdf, y: number, zRange: number, xMax = 0.45): number {
  const cz = centreZ(sdf, y, zRange);
  const runs = rowRuns(sdf, y, cz, xMax, 0.0025);
  if (runs.length === 0) return 0;
  let best = runs[0];
  let bestScore = -Infinity;
  for (const r of runs) {
    const w = r.x1 - r.x0;
    const c = (r.x0 + r.x1) / 2;
    const contains = r.x0 <= 0 && r.x1 >= 0 ? 1 : 0;
    const score = w * (contains ? 2.2 : 1) - Math.abs(c) * 1.4;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return (best.x1 - best.x0) / 2;
}

/** Width of a single limb at a given height (the run nearest the axis). */
function limbWidth(sdf: Sdf, y: number, zRange: number): number {
  const cz = centreZ(sdf, y, zRange);
  const runs = rowRuns(sdf, y, cz, 0.45, 0.0025);
  if (runs.length === 0) return 0;
  const straddling = runs.filter((r) => Math.abs((r.x0 + r.x1) / 2) < 0.16);
  const pick = straddling.length >= 2 ? straddling : runs;
  const widths = pick.map((r) => r.x1 - r.x0).sort((a, b) => a - b);
  return widths[(widths.length / 2) | 0];
}

/** Full sagittal depth on the centreline. */
function centralDepth(sdf: Sdf, y: number, zRange: number): number {
  let z0 = NaN;
  let z1 = NaN;
  const step = 0.0025;
  for (let z = -zRange; z <= zRange; z += step) {
    if (sdf(0, y, z) < 0) {
      if (isNaN(z0)) z0 = z;
      z1 = z;
    }
  }
  return isNaN(z0) ? 0 : z1 - z0;
}

interface SiteReading {
  shoulderHalf: number;
  chestHalf: number;
  waistHalf: number;
  hipHalf: number;
  chestDepth: number;
  waistDepth: number;
  hipDepth: number;
  thighWidth: number;
  calfWidth: number;
}

function readSites(field: BodyField): SiteReading {
  const { sdf, rig } = field;
  const H = rig.stature;
  const zr = H * 0.22;
  const thighY = rig.y.crotch - (rig.y.crotch - rig.y.knee) * 0.28;
  const calfY = rig.y.knee - (rig.y.knee - rig.y.ankle) * 0.32;
  return {
    shoulderHalf: centralHalf(sdf, rig.y.shoulder, zr),
    chestHalf: centralHalf(sdf, rig.y.chest, zr),
    waistHalf: centralHalf(sdf, rig.y.waist, zr),
    hipHalf: centralHalf(sdf, rig.y.hip, zr),
    chestDepth: centralDepth(sdf, rig.y.chest, zr),
    waistDepth: centralDepth(sdf, rig.y.waist, zr),
    hipDepth: centralDepth(sdf, rig.y.hip, zr),
    thighWidth: limbWidth(sdf, thighY, zr),
    calfWidth: limbWidth(sdf, calfY, zr),
  };
}

const PARAM_OF: Array<[keyof SiteReading, keyof ShapeParams, number, number]> = [
  ['shoulderHalf', 'shoulder', 0.7, 1.42],
  ['chestHalf', 'chest', 0.7, 1.45],
  ['waistHalf', 'waist', 0.62, 1.6],
  ['hipHalf', 'hip', 0.7, 1.45],
  ['chestDepth', 'chestDepth', 0.7, 1.45],
  ['waistDepth', 'waistDepth', 0.62, 1.65],
  ['hipDepth', 'hipDepth', 0.7, 1.45],
  ['thighWidth', 'thigh', 0.7, 1.45],
  ['calfWidth', 'calf', 0.7, 1.45],
];

export interface FitResult {
  shape: ShapeParams;
  field: BodyField;
  /** Mean absolute relative error across the fitted sites, 0..1. */
  siteError: number;
  iterations: number;
}

export function refineShape(
  shape0: ShapeParams,
  targets: FitTargets,
  iterations = 4,
): FitResult {
  let shape: ShapeParams = { ...shape0 };
  let field = createBodyField(shape);
  // A distrusted measurement moves its parameter less, so a poor mask relaxes
  // towards canonical proportions instead of chasing noise.
  const damp = 0.55 + 0.35 * clamp(targets.trust, 0, 1);
  let err = 1;
  let used = 0;

  for (let it = 0; it < iterations; it++) {
    const read = readSites(field);
    let errSum = 0;
    let errCount = 0;
    let moved = 0;
    const next: ShapeParams = { ...shape };

    for (const [site, param, lo, hi] of PARAM_OF) {
      const target = targets[site as keyof FitTargets] as number;
      const model = read[site];
      if (!(target > 0.005) || !(model > 0.005)) continue;
      const ratio = target / model;
      errSum += Math.abs(ratio - 1);
      errCount++;
      const step = 1 + damp * (ratio - 1);
      const value = clamp((shape[param] as number) * step, lo, hi);
      moved = Math.max(moved, Math.abs(value - (shape[param] as number)));
      (next[param] as number) = value;
    }

    err = errCount ? errSum / errCount : 0;
    shape = next;
    field = createBodyField(shape);
    used = it + 1;
    if (moved < 0.002) break;
  }

  // Re-read after the final rebuild so the reported error matches the mesh.
  const finalRead = readSites(field);
  let fs = 0;
  let fc = 0;
  for (const [site] of PARAM_OF) {
    const target = targets[site as keyof FitTargets] as number;
    const model = finalRead[site];
    if (!(target > 0.005) || !(model > 0.005)) continue;
    fs += Math.abs(target / model - 1);
    fc++;
  }
  if (fc) err = fs / fc;

  return { shape, field, siteError: err, iterations: used };
}

// ──────────────────────────────────────────────────── girth of the real mesh ──

/** Sphere-trace outwards from an interior point to the surface. */
function radiusAt(
  sdf: Sdf,
  y: number,
  cz: number,
  dx: number,
  dz: number,
  rMax: number,
): number {
  let r = 0;
  for (let i = 0; i < 48; i++) {
    const d = sdf(dx * r, y, cz + dz * r);
    if (d > 0) break;
    r += Math.max(-d, 0.0012);
    if (r > rMax) return rMax;
  }
  // Bisect the last interval for a clean surface hit.
  let lo = Math.max(0, r - 0.02);
  let hi = r;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (sdf(dx * mid, y, cz + dz * mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Circumference of the horizontal cross-section at a height, in centimetres. */
export function girthAt(field: BodyField, y: number, rMax = 0.4): number {
  const { sdf, rig } = field;
  const cz = centreZ(sdf, y, rig.stature * 0.22);
  if (sdf(0, y, cz) >= 0) return 0;
  const N = 72;
  const px = new Float64Array(N);
  const pz = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const r = radiusAt(sdf, y, cz, dx, dz, rMax);
    px[i] = dx * r;
    pz[i] = cz + dz * r;
  }
  let per = 0;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    per += Math.hypot(px[j] - px[i], pz[j] - pz[i]);
  }
  return per * 100;
}

/** Circumference of a limb cross-section, measured about the limb's own axis. */
function limbGirth(
  field: BodyField,
  y: number,
  cx: number,
  rMax: number,
): number {
  const { sdf, rig } = field;
  const zr = rig.stature * 0.22;
  // Local centre: densest point of the limb at this height.
  let bz = 0;
  let bd = Infinity;
  for (let i = 0; i <= 24; i++) {
    const z = -zr + (2 * zr * i) / 24;
    const d = sdf(cx, y, z);
    if (d < bd) {
      bd = d;
      bz = z;
    }
  }
  if (bd >= 0) return 0;
  const N = 48;
  const ox = new Float64Array(N);
  const oz = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    let r = 0;
    for (let s = 0; s < 40; s++) {
      const d = sdf(cx + dx * r, y, bz + dz * r);
      if (d > 0) break;
      r += Math.max(-d, 0.0012);
      if (r > rMax) break;
    }
    let lo = Math.max(0, r - 0.015);
    let hi = Math.min(r, rMax);
    for (let s = 0; s < 9; s++) {
      const mid = (lo + hi) / 2;
      if (sdf(cx + dx * mid, y, bz + dz * mid) < 0) lo = mid;
      else hi = mid;
    }
    const rr = (lo + hi) / 2;
    ox[i] = cx + dx * rr;
    oz[i] = bz + dz * rr;
  }
  let per = 0;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    per += Math.hypot(ox[j] - ox[i], oz[j] - oz[i]);
  }
  return per * 100;
}

export interface FieldGirths {
  chestCm: number;
  waistCm: number;
  hipCm: number;
  neckCm: number;
  thighCm: number;
  upperArmCm: number;
  shoulderWidthCm: number;
  inseamCm: number;
  armLengthCm: number;
}

/** One slice of the trunk's silhouette, used to retarget an external base mesh. */
export interface TrunkSlice {
  /** Height above the sole, as a fraction of stature. */
  p: number;
  /** Half-width of the trunk in metres. */
  half: number;
  /** Sagittal depth in metres. */
  depth: number;
  /** Sagittal centre of the trunk in metres. */
  centre: number;
}

/**
 * Sample the trunk silhouette from sole to crown. Consumed by the optional
 * base-mesh deformer, which needs target widths rather than a whole field.
 */
export function trunkProfile(field: BodyField, samples = 48): TrunkSlice[] {
  const { sdf, rig } = field;
  const H = rig.stature;
  const zr = H * 0.22;
  const out: TrunkSlice[] = [];
  for (let i = 0; i <= samples; i++) {
    const p = i / samples;
    const y = rig.y.sole + p * H;
    const cz = centreZ(sdf, y, zr);
    if (sdf(0, y, cz) >= 0) {
      out.push({ p, half: 0, depth: 0, centre: cz });
      continue;
    }
    out.push({
      p,
      half: centralHalf(sdf, y, zr),
      depth: centralDepth(sdf, y, zr),
      centre: cz,
    });
  }
  return out;
}

export function measureField(field: BodyField): FieldGirths {
  const { rig, sdf } = field;
  const H = rig.stature;
  const zr = H * 0.22;
  const thighY = rig.y.crotch - (rig.y.crotch - rig.y.knee) * 0.22;
  const armY = rig.y.shoulder - (rig.y.shoulder - rig.y.armpit) * 1.6;

  const j = rig.joints;
  const armLen =
    Math.hypot(
      j.elbow[0] - j.shoulder[0],
      j.elbow[1] - j.shoulder[1],
      j.elbow[2] - j.shoulder[2],
    ) +
    Math.hypot(
      j.wrist[0] - j.elbow[0],
      j.wrist[1] - j.elbow[1],
      j.wrist[2] - j.elbow[2],
    );

  return {
    chestCm: girthAt(field, rig.y.chest),
    waistCm: girthAt(field, rig.y.waist),
    hipCm: girthAt(field, rig.y.hip),
    neckCm: girthAt(field, rig.y.neckBase + 0.02 * H, 0.14),
    thighCm: limbGirth(field, thighY, j.upLeg[0], 0.2),
    upperArmCm: limbGirth(field, armY, j.shoulder[0] + (j.elbow[0] - j.shoulder[0]) * 0.35, 0.14),
    shoulderWidthCm: centralHalf(sdf, rig.y.shoulder, zr) * 200,
    inseamCm: (rig.y.crotch - rig.y.sole) * 100,
    armLengthCm: armLen * 100,
  };
}
