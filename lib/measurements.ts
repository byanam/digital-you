'use client';

/**
 * Landmarks (front + profile) → body metrics → parametric shape vector.
 *
 * Two ideas carry most of the accuracy here:
 *  1. Circumferences come from a *superellipse* fit of breadth × depth, not an
 *     ellipse. Human torso sections sit near n≈2.6–2.9; an ellipse formula
 *     under-reports chest girth by roughly 8%.
 *  2. Every shape multiplier is shrunk towards the anthropometric mean in
 *     proportion to how much we distrust the segmentation. A bad mask degrades
 *     gracefully into an average body instead of a monster.
 */

import type {
  BodyMetrics,
  ShapeParams,
  SilhouetteAnalysis,
  UserProfileInput,
} from './types';
import { clamp, clamp01, lerp, median, superellipsePerimeter } from './math';
import { CANON } from './body/anatomy';

/** Mean adult crown-to-chin height, used to recover absolute scale. */
const HEAD_HEIGHT_CM = 23.2;

export interface EstimateResult {
  metrics: BodyMetrics;
  shape: ShapeParams;
  /** Pixels per centimetre for each view — needed by the texture projector. */
  frontPxPerCm: number;
  profilePxPerCm: number;
}

/** Torso width of the profile mask at a normalised height p (0 sole → 1 crown). */
function depthAtP(profile: SilhouetteAnalysis, p: number, halfBand = 0.012): number {
  const { crownY, pixelHeight } = profile.landmarks;
  if (pixelHeight <= 0) return 0;
  const yc = crownY + (1 - p) * pixelHeight;
  const half = Math.max(1, halfBand * pixelHeight);
  const samples: number[] = [];
  for (let y = Math.round(yc - half); y <= Math.round(yc + half); y++) {
    const r = profile.rows[y];
    if (!r || r.x1 < 0) continue;
    // In a profile shot the arm silhouette overlaps the torso, so the full
    // row extent *is* the sagittal depth.
    samples.push(r.x1 - r.x0 + 1);
  }
  return samples.length ? median(samples) : 0;
}

/** Integrate the arm centreline from shoulder to wrist for a true arm length. */
function armPathPx(front: SilhouetteAnalysis): number {
  const { crownY, pixelHeight, axisX } = front.landmarks;
  const pts: Array<[number, number]> = [];
  for (let p = 0.8; p >= 0.47; p -= 0.01) {
    const y = Math.round(crownY + (1 - p) * pixelHeight);
    const row = front.rows[y];
    if (!row || row.runs.length === 0) continue;
    const cands = row.runs.filter(
      (r) => r.x1 - r.x0 + 1 > pixelHeight * 0.012,
    );
    if (cands.length < 2) continue;
    // Outermost run on each side; average their |offset| for symmetry.
    let bestOff = 0;
    let bestCx = axisX;
    for (const r of cands) {
      const cx = (r.x0 + r.x1) / 2;
      const off = Math.abs(cx - axisX);
      if (off > bestOff) {
        bestOff = off;
        bestCx = cx;
      }
    }
    if (bestOff < pixelHeight * 0.05) continue;
    pts.push([bestCx, y]);
  }
  if (pts.length < 4) return pixelHeight * 0.345; // canonical acromion→wrist
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return len;
}

/** Superellipse exponents per anatomical site. */
const SECTION_N = {
  chest: 2.85,
  waist: 2.7,
  hip: 2.55,
  neck: 2.2,
  thigh: 2.3,
  upperArm: 2.15,
};

function girth(breadthCm: number, depthCm: number, n: number, factor = 1) {
  if (breadthCm <= 0 || depthCm <= 0) return 0;
  return superellipsePerimeter(breadthCm / 2, depthCm / 2, n) * factor;
}

export function estimateBody(
  front: SilhouetteAnalysis,
  profile: SilhouetteAnalysis | null,
  input: UserProfileInput,
): EstimateResult {
  const fl = front.landmarks;
  const confidence = clamp01(
    profile
      ? 0.62 * fl.confidence + 0.38 * profile.landmarks.confidence
      : fl.confidence * 0.85,
  );

  // ── absolute scale ────────────────────────────────────────────────────────
  const headPx = Math.max(1, fl.chinY - fl.crownY);
  const headRatioHeight = (fl.pixelHeight / headPx) * HEAD_HEIGHT_CM;
  const scaleSource: BodyMetrics['scaleSource'] = input.heightCm
    ? 'user-height'
    : 'head-ratio-estimate';
  const heightCm = clamp(
    input.heightCm && input.heightCm > 90 ? input.heightCm : headRatioHeight,
    140,
    210,
  );

  const frontPxPerCm = fl.pixelHeight / heightCm;
  const profilePxPerCm = profile
    ? profile.landmarks.pixelHeight / heightCm
    : frontPxPerCm;

  const cmF = (px: number) => px / (frontPxPerCm || 1);
  const cmP = (px: number) => px / (profilePxPerCm || 1);

  // ── breadths (frontal) ────────────────────────────────────────────────────
  const shoulderWidthCm = cmF(fl.shoulderBreadth);
  const chestBreadthCm = cmF(fl.chestBreadth);
  const waistBreadthCm = cmF(fl.waistBreadth);
  const hipBreadthCm = cmF(fl.hipBreadth);
  const neckBreadthCm = cmF(fl.neckBreadth);
  const thighBreadthCm = cmF(fl.thighBreadth);
  const calfBreadthCm = cmF(fl.calfBreadth);
  const upperArmBreadthCm = cmF(fl.upperArmBreadth);
  const headBreadthCm = cmF(fl.headBreadth);

  // ── depths (sagittal) ─────────────────────────────────────────────────────
  // Fall back to canonical depth-to-breadth ratios if there is no profile shot.
  const canonDepth = (breadthCm: number, bFrac: number, dFrac: number) =>
    breadthCm * (dFrac / bFrac);

  const pChest = 1 - (fl.chestY - fl.crownY) / fl.pixelHeight;
  const pWaist = 1 - (fl.waistY - fl.crownY) / fl.pixelHeight;
  const pHip = 1 - (fl.hipY - fl.crownY) / fl.pixelHeight;

  let chestDepthCm = profile ? cmP(depthAtP(profile, pChest)) : 0;
  let waistDepthCm = profile ? cmP(depthAtP(profile, pWaist)) : 0;
  let hipDepthCm = profile ? cmP(depthAtP(profile, pHip)) : 0;

  if (!(chestDepthCm > 4))
    chestDepthCm = canonDepth(chestBreadthCm, CANON.chestBreadth, CANON.chestDepth);
  if (!(waistDepthCm > 4))
    waistDepthCm = canonDepth(waistBreadthCm, CANON.waistBreadth, CANON.waistDepth);
  if (!(hipDepthCm > 4))
    hipDepthCm = canonDepth(hipBreadthCm, CANON.hipBreadth, CANON.hipDepth);

  // A profile silhouette at chest height includes the upper arm; trim it.
  if (profile) chestDepthCm *= 0.94;

  // ── circumferences ────────────────────────────────────────────────────────
  const chestCm = girth(chestBreadthCm, chestDepthCm, SECTION_N.chest, 1.02);
  const waistCm = girth(waistBreadthCm, waistDepthCm, SECTION_N.waist, 1.0);
  const hipCm = girth(hipBreadthCm, hipDepthCm, SECTION_N.hip, 1.02);
  const neckCm = girth(
    neckBreadthCm,
    neckBreadthCm * (CANON.neckDepth / CANON.neckBreadth),
    SECTION_N.neck,
  );
  const thighCm = girth(thighBreadthCm, thighBreadthCm * 0.86, SECTION_N.thigh);
  const upperArmCm = girth(
    upperArmBreadthCm,
    upperArmBreadthCm * 0.95,
    SECTION_N.upperArm,
  );

  const inseamCm = cmF(Math.max(1, fl.soleY - fl.crotchY));
  const armLengthCm = cmF(armPathPx(front));

  // ── shape vector, shrunk towards the mean by confidence ───────────────────
  // trust=1 → use the measurement verbatim; trust=0.35 → mostly canonical.
  const trust = 0.35 + 0.65 * confidence;
  const ratio = (measuredCm: number, canonFrac: number, lo = 0.74, hi = 1.4) => {
    const expected = canonFrac * heightCm;
    if (!(expected > 0) || !(measuredCm > 0)) return 1;
    const raw = clamp(measuredCm / expected, lo, hi);
    return lerp(1, raw, trust);
  };

  const shoulder = ratio(shoulderWidthCm, CANON.shoulderBreadth);
  const chest = ratio(chestBreadthCm, CANON.chestBreadth);
  const waist = ratio(waistBreadthCm, CANON.waistBreadth, 0.7, 1.55);
  const hip = ratio(hipBreadthCm, CANON.hipBreadth);
  const chestDepth = ratio(chestDepthCm, CANON.chestDepth);
  const waistDepth = ratio(waistDepthCm, CANON.waistDepth, 0.7, 1.6);
  const hipDepth = ratio(hipDepthCm, CANON.hipDepth);
  const neck = ratio(neckBreadthCm, CANON.neckBreadth);
  const head = ratio(headBreadthCm, CANON.headBreadth, 0.85, 1.2);
  const thigh = ratio(thighBreadthCm, CANON.thighBreadth);
  const calf = ratio(calfBreadthCm, CANON.calfBreadth);
  const arm = ratio(upperArmBreadthCm, CANON.upperArmBreadth);

  const legLength = lerp(
    1,
    clamp(inseamCm / (CANON.crotch * heightCm), 0.86, 1.16),
    trust,
  );

  // Body composition cues, used only for surface relief.
  const whr = hipCm > 0 ? waistCm / hipCm : 0.8;
  const shoulderToWaist = waistCm > 0 ? chestCm / waistCm : 1.2;
  const softness = clamp01((whr - 0.72) / 0.26) * 0.85 + 0.08;
  const muscle = clamp01((shoulderToWaist - 1.06) / 0.34) * 0.9 + 0.05;

  const shape: ShapeParams = {
    stature: heightCm / 100,
    shoulder,
    chest,
    waist,
    hip,
    chestDepth,
    waistDepth,
    hipDepth,
    neck,
    head,
    arm,
    thigh,
    calf,
    legLength,
    muscle,
    softness,
  };

  const metrics: BodyMetrics = {
    heightCm,
    chestCm,
    waistCm,
    hipCm,
    neckCm,
    thighCm,
    upperArmCm,
    shoulderWidthCm,
    inseamCm,
    armLengthCm,
    chestDepthCm,
    waistDepthCm,
    hipDepthCm,
    silhouetteAccuracy: 0,
    frontIoU: 0,
    profileIoU: 0,
    scaleSource,
    confidence,
  };

  return { metrics, shape, frontPxPerCm, profilePxPerCm };
}
