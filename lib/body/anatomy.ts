/**
 * Anatomical template + implicit body model.
 *
 * WHY AN SDF RATHER THAN LOFTED TUBES
 * A body assembled from separate limb tubes always shows a crease where a
 * cylinder enters the torso. Here the body is a single scalar field built from
 * ~40 anatomical masses combined with a *polynomial smooth minimum*, so the
 * deltoid flows into the pectoral and the gluteus into the thigh the way real
 * soft tissue does. Polygonising that field yields one continuous organic
 * surface — no seams, no visible primitives.
 *
 * The torso is not a primitive at all: it is a generalised superellipse loft
 * whose half-width, sagittal depth, centreline offset and corner exponent are
 * all monotone-spline functions of height, anchored exactly at the measured
 * hip / waist / chest / shoulder breadths. That is what makes the silhouette
 * match the photograph.
 */

import type { ShapeParams } from '../types';
import { MonotoneCurve, clamp01, lerp, smin, smax } from '../math';

/** Canonical adult anthropometry, as fractions of stature. */
export const CANON = {
  // Heights above the sole.
  ankle: 0.039,
  knee: 0.285,
  crotch: 0.48,
  hip: 0.52,
  waist: 0.62,
  chest: 0.72,
  armpit: 0.755,
  shoulder: 0.818,
  neckBase: 0.832,
  chin: 0.87,
  elbow: 0.63,
  wrist: 0.485,
  // Frontal breadths (full width).
  headBreadth: 0.095,
  neckBreadth: 0.068,
  shoulderBreadth: 0.232,
  chestBreadth: 0.176,
  waistBreadth: 0.147,
  hipBreadth: 0.186,
  thighBreadth: 0.1,
  calfBreadth: 0.068,
  upperArmBreadth: 0.06,
  forearmBreadth: 0.05,
  // Sagittal depths (full).
  headDepth: 0.125,
  neckDepth: 0.075,
  chestDepth: 0.125,
  waistDepth: 0.108,
  hipDepth: 0.135,
  // Segment lengths.
  upperArm: 0.186,
  forearm: 0.146,
  hand: 0.108,
  footLength: 0.152,
} as const;

export type V3 = [number, number, number];

export interface BodyRig {
  stature: number;
  y: {
    sole: number;
    ankle: number;
    knee: number;
    crotch: number;
    hip: number;
    waist: number;
    chest: number;
    armpit: number;
    shoulder: number;
    neckBase: number;
    chin: number;
    crown: number;
  };
  half: {
    shoulder: number;
    chest: number;
    waist: number;
    hip: number;
    neck: number;
    head: number;
    thigh: number;
    calf: number;
  };
  depth: {
    chest: number;
    waist: number;
    hip: number;
    neck: number;
    head: number;
  };
  /** Joint centres for the LEFT side (+X). Mirror x for the right. */
  joints: {
    hips: V3;
    spine: V3;
    spine1: V3;
    spine2: V3;
    neck: V3;
    head: V3;
    headTop: V3;
    shoulderRoot: V3;
    shoulder: V3;
    elbow: V3;
    wrist: V3;
    handTip: V3;
    upLeg: V3;
    knee: V3;
    ankle: V3;
    toe: V3;
  };
  radii: {
    deltoid: number;
    upperArmTop: number;
    upperArmBottom: number;
    forearmTop: number;
    forearmBottom: number;
    thighTop: number;
    thighBottom: number;
    shankTop: number;
    shankBottom: number;
  };
  /** Orthonormal hand frame: u along the arm, v across, w = palm normal. */
  handFrame: { u: V3; v: V3; w: V3 };
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function buildRig(shape: ShapeParams): BodyRig {
  const H = shape.stature;
  const m = shape.muscle;

  // Leg length shifts the crotch, which in turn compresses/stretches the torso.
  const crotch = CANON.crotch * H * shape.legLength;
  const neckBase = CANON.neckBase * H;
  const torsoSpan = Math.max(0.12 * H, neckBase - crotch);
  const atTorso = (canonY: number) =>
    crotch + torsoSpan * ((canonY - CANON.crotch) / (CANON.neckBase - CANON.crotch));

  const y = {
    sole: 0,
    ankle: CANON.ankle * H,
    knee: crotch * (CANON.knee / CANON.crotch),
    crotch,
    hip: atTorso(CANON.hip),
    waist: atTorso(CANON.waist),
    chest: atTorso(CANON.chest),
    armpit: atTorso(CANON.armpit),
    shoulder: atTorso(CANON.shoulder),
    neckBase,
    chin: CANON.chin * H,
    crown: H,
  };

  const half = {
    shoulder: 0.5 * CANON.shoulderBreadth * H * shape.shoulder,
    chest: 0.5 * CANON.chestBreadth * H * shape.chest,
    waist: 0.5 * CANON.waistBreadth * H * shape.waist,
    hip: 0.5 * CANON.hipBreadth * H * shape.hip,
    neck: 0.5 * CANON.neckBreadth * H * shape.neck,
    head: 0.5 * CANON.headBreadth * H * shape.head,
    thigh: 0.5 * CANON.thighBreadth * H * shape.thigh,
    calf: 0.5 * CANON.calfBreadth * H * shape.calf,
  };

  const depth = {
    chest: 0.5 * CANON.chestDepth * H * shape.chestDepth,
    waist: 0.5 * CANON.waistDepth * H * shape.waistDepth,
    hip: 0.5 * CANON.hipDepth * H * shape.hipDepth,
    neck: 0.5 * CANON.neckDepth * H * shape.neck,
    head: 0.5 * CANON.headDepth * H * shape.head,
  };

  // ── arm chain, relaxed A-pose ──────────────────────────────────────────────
  const shoulderRoot: V3 = [half.neck * 0.85, y.neckBase - 0.012 * H, -0.008 * H];
  const shoulder: V3 = [half.shoulder * 0.78, y.shoulder - 0.022 * H, -0.004 * H];
  const upperLen = CANON.upperArm * H;
  const foreLen = CANON.forearm * H;
  const handLen = CANON.hand * H;

  const upperDir = norm([Math.sin(0.332), -Math.cos(0.332), 0.03]); // ≈19° abduction
  const elbow = add(shoulder, scale(upperDir, upperLen));
  const foreDir = norm([Math.sin(0.175), -Math.cos(0.175), 0.09]); // ≈10°, slight forward
  const wrist = add(elbow, scale(foreDir, foreLen));
  const handDir = norm([Math.sin(0.14), -Math.cos(0.14), 0.06]);
  const handTip = add(wrist, scale(handDir, handLen));

  // Hand frame: palm faces medially (towards the thigh), fingers spread front↔back.
  const u = handDir;
  const w = norm(cross(u, [0, 0, 1]));
  const v = norm(cross(w, u));

  // ── leg chain ─────────────────────────────────────────────────────────────
  const thighX = half.thigh * 0.92;
  const upLeg: V3 = [half.hip * 0.55, y.hip - 0.004 * H, -0.004 * H];
  const knee: V3 = [thighX * 0.72, y.knee, 0.006 * H];
  const ankle: V3 = [thighX * 0.56, y.ankle, 0];
  const toe: V3 = [thighX * 0.54, 0.018 * H, 0.108 * H];

  const muscleBoost = 0.9 + 0.22 * m;

  return {
    stature: H,
    y,
    half,
    depth,
    joints: {
      hips: [0, y.hip - 0.01 * H, -0.004 * H],
      spine: [0, lerp(y.hip, y.waist, 0.55), 0],
      spine1: [0, y.waist + 0.03 * H, 0.004 * H],
      spine2: [0, y.chest + 0.01 * H, 0],
      neck: [0, y.neckBase - 0.005 * H, -0.005 * H],
      head: [0, y.chin + 0.012 * H, 0],
      headTop: [0, y.crown - 0.01 * H, 0],
      shoulderRoot,
      shoulder,
      elbow,
      wrist,
      handTip,
      upLeg,
      knee,
      ankle,
      toe,
    },
    radii: {
      deltoid: 0.031 * H * shape.arm * muscleBoost,
      upperArmTop: 0.032 * H * shape.arm * muscleBoost,
      upperArmBottom: 0.0255 * H * shape.arm,
      forearmTop: 0.0275 * H * shape.arm * muscleBoost,
      forearmBottom: 0.0185 * H * shape.arm,
      thighTop: half.thigh,
      thighBottom: 0.03 * H * shape.calf,
      shankTop: 0.032 * H * shape.calf,
      shankBottom: 0.0195 * H * shape.calf,
    },
    handFrame: { u, v, w },
  };
}

// ────────────────────────────────────────────────────────────── primitives ──

/** Exact SDF of a round cone (tapered capsule) — inigo quilez. */
function sdRoundCone(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r1: number, r2: number,
): number {
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz || 1e-9;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;

  const pax = px - ax;
  const pay = py - ay;
  const paz = pz - az;
  const yv = pax * bax + pay * bay + paz * baz;
  const zv = yv - l2;

  const xx = pax * l2 - bax * yv;
  const xy = pay * l2 - bay * yv;
  const xz = paz * l2 - baz * yv;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = yv * yv * l2;
  const z2 = zv * zv * l2;

  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zv) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(yv) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - r1;
}

/** Axis-aligned ellipsoid, bounded approximation (good enough for blending). */
function sdEllipsoid(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,
): number {
  const dx = (px - cx) / rx;
  const dy = (py - cy) / ry;
  const dz = (pz - cz) / rz;
  const k0 = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (k0 < 1e-6) return -Math.min(rx, ry, rz);
  const ex = (px - cx) / (rx * rx);
  const ey = (py - cy) / (ry * ry);
  const ez = (pz - cz) / (rz * rz);
  const k1 = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-9;
  return (k0 * (k0 - 1)) / k1;
}

/** Ellipsoid in an arbitrary orthonormal frame — used for hands and feet. */
function sdOrientedEllipsoid(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  ux: number, uy: number, uz: number,
  vx: number, vy: number, vz: number,
  wx: number, wy: number, wz: number,
  ru: number, rv: number, rw: number,
): number {
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  const a = dx * ux + dy * uy + dz * uz;
  const b = dx * vx + dy * vy + dz * vz;
  const c = dx * wx + dy * wy + dz * wz;
  return sdEllipsoid(a, b, c, 0, 0, 0, ru, rv, rw);
}

// ───────────────────────────────────────────────────────────────── the body ──

export interface BodyField {
  rig: BodyRig;
  bounds: { min: V3; max: V3 };
  /** Negative inside the body, positive outside. Approximately metric. */
  sdf: (x: number, y: number, z: number) => number;
}

const LUT_SIZE = 320;

export function createBodyField(shape: ShapeParams): BodyField {
  const rig = buildRig(shape);
  const H = rig.stature;
  const { y, half, depth, joints, radii } = rig;
  const muscle = clamp01(shape.muscle);
  const softness = clamp01(shape.softness);

  // ── torso profile curves ──────────────────────────────────────────────────
  const yLo = y.crotch - 0.045 * H;
  const yHi = y.neckBase + 0.02 * H;

  const widthCurve = new MonotoneCurve([
    [yLo, half.hip * 0.5],
    [y.crotch - 0.015 * H, half.hip * 0.8],
    [y.crotch + 0.02 * H, half.hip * 0.93],
    [y.hip, half.hip],
    [lerp(y.hip, y.waist, 0.42), half.hip * 0.91],
    [y.waist, half.waist],
    [lerp(y.waist, y.chest, 0.45), half.waist + 0.5 * (half.chest - half.waist)],
    [y.chest, half.chest],
    [y.armpit, half.chest * 1.03],
    // The torso only reaches ~72% of the shoulder breadth; the deltoid masses
    // below supply the rest, which is how a real acromion breadth is formed.
    [y.shoulder, half.shoulder * 0.72],
    [y.neckBase, half.neck * 1.5],
    [yHi, half.neck * 1.05],
  ]);

  const depthCurve = new MonotoneCurve([
    [yLo, depth.hip * 0.58],
    [y.crotch - 0.015 * H, depth.hip * 0.86],
    [y.hip, depth.hip],
    [lerp(y.hip, y.waist, 0.5), depth.hip * 0.9],
    [y.waist, depth.waist],
    [lerp(y.waist, y.chest, 0.5), depth.waist + 0.62 * (depth.chest - depth.waist)],
    [y.chest, depth.chest],
    [y.armpit, depth.chest * 0.97],
    [y.shoulder, depth.chest * 0.82],
    [y.neckBase, depth.neck * 1.35],
    [yHi, depth.neck * 1.1],
  ]);

  // Sagittal centreline — pelvic tilt, lumbar lordosis, thoracic kyphosis.
  const centreCurve = new MonotoneCurve([
    [yLo, -0.006 * H],
    [y.hip, -0.011 * H],
    [y.waist, 0.005 * H],
    [y.chest, 0.007 * H],
    [y.armpit, 0.001 * H],
    [y.shoulder, -0.008 * H],
    [yHi, -0.004 * H],
  ]);

  // Corner sharpness: the ribcage is flat front-to-back, the neck is round.
  const exponentCurve = new MonotoneCurve([
    [yLo, 2.35],
    [y.hip, 2.5],
    [y.waist, 2.7],
    [y.chest, 2.95],
    [y.armpit, 2.9],
    [y.shoulder, 2.6],
    [yHi, 2.2],
  ]);

  // Sample the splines into LUTs — the field is evaluated ~10^6 times.
  const lutW = new Float32Array(LUT_SIZE);
  const lutD = new Float32Array(LUT_SIZE);
  const lutC = new Float32Array(LUT_SIZE);
  const lutN = new Float32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    const yy = lerp(yLo, yHi, t);
    lutW[i] = Math.max(1e-4, widthCurve.at(yy));
    lutD[i] = Math.max(1e-4, depthCurve.at(yy));
    lutC[i] = centreCurve.at(yy);
    lutN[i] = exponentCurve.at(yy);
  }
  const lutSpan = yHi - yLo;

  function sdTorso(px: number, py: number, pz: number): number {
    const t = clamp01((py - yLo) / lutSpan) * (LUT_SIZE - 1);
    const i0 = t | 0;
    const i1 = i0 + 1 < LUT_SIZE ? i0 + 1 : LUT_SIZE - 1;
    const f = t - i0;
    const hw = lutW[i0] + (lutW[i1] - lutW[i0]) * f;
    const hd = lutD[i0] + (lutD[i1] - lutD[i0]) * f;
    const cz = lutC[i0] + (lutC[i1] - lutC[i0]) * f;
    const n = lutN[i0] + (lutN[i1] - lutN[i0]) * f;

    const ax = Math.abs(px) / hw;
    const az = Math.abs(pz - cz) / hd;
    // Superellipse radial field, rescaled to approximate metric distance.
    const q = Math.pow(Math.pow(ax, n) + Math.pow(az, n), 1 / n);
    const radial = (q - 1) * Math.min(hw, hd);

    // Rounded vertical caps; adjacent masses hide the joins.
    let d = smax(radial, py - yHi, 0.035 * H);
    d = smax(d, yLo - py, 0.03 * H);
    return d;
  }

  // ── precomputed limb geometry ─────────────────────────────────────────────
  const sh = joints.shoulder;
  const el = joints.elbow;
  const wr = joints.wrist;
  const ht = joints.handTip;
  const ul = joints.upLeg;
  const kn = joints.knee;
  const an = joints.ankle;
  const toe = joints.toe;
  const { u, v, w } = rig.handFrame;

  const handMidX = (wr[0] + ht[0]) * 0.5;
  const handMidY = (wr[1] + ht[1]) * 0.5;
  const handMidZ = (wr[2] + ht[2]) * 0.5;

  // Thumb: splays medially and forward from just past the wrist.
  const thumbBase: V3 = [
    wr[0] - w[0] * 0.006 * H + u[0] * 0.014 * H,
    wr[1] - w[1] * 0.006 * H + u[1] * 0.014 * H,
    wr[2] - w[2] * 0.006 * H + u[2] * 0.014 * H,
  ];
  const thumbTip: V3 = [
    thumbBase[0] + u[0] * 0.03 * H + v[0] * 0.026 * H,
    thumbBase[1] + u[1] * 0.03 * H + v[1] * 0.026 * H,
    thumbBase[2] + u[2] * 0.03 * H + v[2] * 0.026 * H,
  ];

  // Head masses.
  const headH = y.crown - y.chin;
  const headCy = y.chin + headH * 0.53;
  const skullRz = depth.head;
  const headCz = -skullRz * 0.1;

  const kBig = 0.045 * H;
  const kMid = 0.03 * H;
  const kSmall = 0.018 * H;

  const pecAmp = 0.55 + 0.75 * muscle;
  const gluteAmp = 0.8 + 0.35 * softness;
  const bellyAmp = Math.max(0, softness - 0.32);

  function sdf(px: number, py: number, pz: number): number {
    // Limbs are authored once on the +X side and evaluated at |x|, which makes
    // the body bilaterally symmetric for free and halves the primitive count.
    const ax = Math.abs(px);

    // Torso ------------------------------------------------------------------
    let d = sdTorso(px, py, pz);

    // Gluteal mass
    d = smin(
      d,
      sdEllipsoid(
        ax, py, pz,
        half.hip * 0.44, y.hip - 0.022 * H, -depth.hip * 0.68,
        half.hip * 0.58, 0.072 * H, depth.hip * 0.52 * gluteAmp,
      ),
      kBig,
    );

    // Pectoral / breast mass
    d = smin(
      d,
      sdEllipsoid(
        ax, py, pz,
        half.chest * 0.44, y.chest + 0.014 * H, depth.chest * 0.58,
        half.chest * 0.5, 0.046 * H, depth.chest * 0.4 * pecAmp,
      ),
      kBig,
    );

    // Soft abdomen
    if (bellyAmp > 0.01) {
      d = smin(
        d,
        sdEllipsoid(
          px, py, pz,
          0, y.waist - 0.028 * H, depth.waist * 0.62,
          half.waist * 0.82, 0.085 * H, depth.waist * 0.62 * bellyAmp,
        ),
        kBig,
      );
    }

    // Trapezius: neck → acromion slope
    d = smin(
      d,
      sdRoundCone(
        ax, py, pz,
        half.neck * 0.5, y.neckBase - 0.008 * H, -0.012 * H,
        half.shoulder * 0.74, y.shoulder - 0.016 * H, -0.014 * H,
        0.03 * H, 0.024 * H,
      ),
      kBig,
    );

    // Deltoid cap
    d = smin(
      d,
      sdEllipsoid(
        ax, py, pz,
        half.shoulder - radii.deltoid * 0.88, y.shoulder - 0.014 * H, -0.002 * H,
        radii.deltoid * 1.05, radii.deltoid * 1.35, radii.deltoid * 1.1,
      ),
      kBig,
    );

    // Neck ------------------------------------------------------------------
    d = smin(
      d,
      sdRoundCone(
        px, py, pz,
        0, y.shoulder - 0.035 * H, -0.006 * H,
        0, y.chin + 0.004 * H, 0.006 * H,
        half.neck * 1.24, half.neck * 0.94,
      ),
      kMid,
    );

    // Head ------------------------------------------------------------------
    let head = sdEllipsoid(
      px, py, pz,
      0, headCy, headCz,
      half.head, headH * 0.52, skullRz,
    );
    // Jaw + chin
    head = smin(
      head,
      sdEllipsoid(
        px, py, pz,
        0, y.chin + headH * 0.16, skullRz * 0.22,
        half.head * 0.82, headH * 0.2, skullRz * 0.72,
      ),
      kSmall,
    );
    // Cheekbones
    head = smin(
      head,
      sdEllipsoid(
        ax, py, pz,
        half.head * 0.62, y.chin + headH * 0.42, skullRz * 0.42,
        half.head * 0.3, headH * 0.11, skullRz * 0.3,
      ),
      kSmall,
    );
    // Brow ridge
    head = smin(
      head,
      sdRoundCone(
        px, py, pz,
        -half.head * 0.6, y.chin + headH * 0.6, skullRz * 0.5,
        half.head * 0.6, y.chin + headH * 0.6, skullRz * 0.5,
        0.009 * H, 0.009 * H,
      ),
      kSmall,
    );
    // Nose: bridge → tip
    head = smin(
      head,
      sdRoundCone(
        px, py, pz,
        0, y.chin + headH * 0.58, skullRz * 0.62,
        0, y.chin + headH * 0.3, skullRz * 0.86,
        0.006 * H, 0.0105 * H,
      ),
      0.008 * H,
    );
    // Lips
    head = smin(
      head,
      sdEllipsoid(
        px, py, pz,
        0, y.chin + headH * 0.2, skullRz * 0.66,
        half.head * 0.4, headH * 0.055, skullRz * 0.16,
      ),
      0.01 * H,
    );
    // Ears
    head = smin(
      head,
      sdOrientedEllipsoid(
        ax, py, pz,
        half.head * 0.96, y.chin + headH * 0.46, -skullRz * 0.12,
        1, 0, 0, 0, 1, 0, 0, 0, 1,
        0.006 * H, 0.024 * H, 0.013 * H,
      ),
      0.008 * H,
    );
    // Orbital sockets — a subtraction, which is what reads as "eyes" in relief.
    head = smax(
      head,
      -sdEllipsoid(
        ax, py, pz,
        half.head * 0.42, y.chin + headH * 0.52, skullRz * 0.78,
        half.head * 0.3, headH * 0.075, skullRz * 0.3,
      ),
      0.012 * H,
    );
    d = smin(d, head, kSmall);

    // Arm -------------------------------------------------------------------
    // Upper arm (with a biceps/triceps swell via the round-cone radii)
    d = smin(
      d,
      sdRoundCone(
        ax, py, pz,
        sh[0], sh[1], sh[2],
        el[0], el[1], el[2],
        radii.upperArmTop, radii.upperArmBottom,
      ),
      kBig,
    );
    // Forearm
    d = smin(
      d,
      sdRoundCone(
        ax, py, pz,
        el[0], el[1], el[2],
        wr[0], wr[1], wr[2],
        radii.forearmTop, radii.forearmBottom,
      ),
      kMid,
    );
    // Palm + fingers as a flattened oriented ellipsoid
    d = smin(
      d,
      sdOrientedEllipsoid(
        ax, py, pz,
        handMidX, handMidY, handMidZ,
        u[0], u[1], u[2],
        v[0], v[1], v[2],
        w[0], w[1], w[2],
        0.052 * H, 0.031 * H, 0.0125 * H,
      ),
      kSmall,
    );
    // Thumb
    d = smin(
      d,
      sdRoundCone(
        ax, py, pz,
        thumbBase[0], thumbBase[1], thumbBase[2],
        thumbTip[0], thumbTip[1], thumbTip[2],
        0.0095 * H, 0.0075 * H,
      ),
      0.01 * H,
    );

    // Leg -------------------------------------------------------------------
    d = smin(
      d,
      sdRoundCone(
        ax, py, pz,
        ul[0], ul[1], ul[2],
        kn[0], kn[1], kn[2],
        radii.thighTop, radii.thighBottom,
      ),
      kBig,
    );
    // Quadriceps swell
    d = smin(
      d,
      sdEllipsoid(
        ax, py, pz,
        lerp(ul[0], kn[0], 0.45), lerp(ul[1], kn[1], 0.45), lerp(ul[2], kn[2], 0.45) + half.thigh * 0.42,
        half.thigh * 0.72, (ul[1] - kn[1]) * 0.32, half.thigh * (0.34 + 0.16 * muscle),
      ),
      kBig,
    );
    // Shank
    d = smin(
      d,
      sdRoundCone(
        ax, py, pz,
        kn[0], kn[1], kn[2],
        an[0], an[1], an[2],
        radii.shankTop, radii.shankBottom,
      ),
      kMid,
    );
    // Gastrocnemius
    d = smin(
      d,
      sdEllipsoid(
        ax, py, pz,
        lerp(kn[0], an[0], 0.28), lerp(kn[1], an[1], 0.3), lerp(kn[2], an[2], 0.3) - half.calf * 0.55,
        half.calf * 0.82, (kn[1] - an[1]) * 0.3, half.calf * (0.62 + 0.2 * muscle),
      ),
      kMid,
    );
    // Foot: heel ball + forefoot wedge + toe cap
    d = smin(
      d,
      sdEllipsoid(
        ax, py, pz,
        an[0], y.ankle * 0.82, -0.032 * H,
        0.026 * H, 0.03 * H, 0.03 * H,
      ),
      kMid,
    );
    d = smin(
      d,
      sdRoundCone(
        ax, py, pz,
        an[0], y.ankle * 0.66, -0.012 * H,
        toe[0], toe[1], toe[2],
        0.024 * H, 0.017 * H,
      ),
      kSmall,
    );
    d = smin(
      d,
      sdEllipsoid(
        ax, py, pz,
        toe[0], 0.017 * H, toe[2] * 0.82,
        0.03 * H, 0.016 * H, 0.03 * H,
      ),
      kSmall,
    );

    // Keep the field from dipping below the floor plane.
    return smax(d, -py - 0.004 * H, 0.01 * H);
  }

  // ── bounds ────────────────────────────────────────────────────────────────
  const xMax =
    Math.max(
      half.shoulder + radii.deltoid * 0.25,
      Math.abs(ht[0]) + 0.055 * H,
      half.thigh * 1.95,
      half.hip * 1.05,
    ) + 0.03 * H;
  const zMax =
    Math.max(
      depth.chest * 1.35,
      depth.head * 1.0,
      toe[2] + 0.035 * H,
    ) + 0.02 * H;
  const zMin =
    -(Math.max(depth.hip * 1.45, depth.head * 1.25, 0.05 * H) + 0.02 * H);

  return {
    rig,
    bounds: {
      min: [-xMax, -0.015 * H, zMin],
      max: [xMax, y.crown + 0.02 * H, zMax],
    },
    sdf,
  };
}
