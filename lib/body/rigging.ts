/**
 * Regions, UV atlas and skin weights — all from a single nearest-bone pass.
 *
 * Surface Nets gives an unstructured triangle soup, so it needs a
 * parameterisation. A single planar front/back split would be cheap but folds
 * over on itself (the underside of the jaw lands on the neck). Instead each
 * body region gets a cylindrical chart about its own bone axis, which is
 * injective here because the SDF's smooth-min blending leaves the surface
 * star-shaped about every bone axis — no gap under the chin, none in the armpit.
 *
 * Region boundaries are cosmetically irrelevant: the texture baker samples the
 * photos by 3D position, so a chart boundary is only a discontinuity in the
 * atlas, not in the render. What matters is that every chart is injective and
 * that the seams land at the back of each limb.
 */

import type { BodyRig, V3 } from './anatomy';
import type { PolyMesh } from './polygonize';

export type RegionId = 0 | 1 | 2 | 3 | 4 | 5;
export const REGION = {
  torso: 0,
  head: 1,
  armL: 2,
  armR: 3,
  legL: 4,
  legR: 5,
} as const;

/** Standard humanoid bone names — Mixamo-compatible, so retargeting and
 *  garment tools recognise the hierarchy. */
export interface BoneDef {
  name: string;
  parent: number;
  world: V3;
}

interface WeightSegment {
  bone: number;
  region: RegionId;
  a: V3;
  b: V3;
  sigma: number;
  /** +1 = avatar's left, -1 = right, 0 = central. */
  side: -1 | 0 | 1;
}

export interface AtlasRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * Atlas layout. The torso takes half the sheet and the head a quarter — faces
 * are what people look at, feet are not.
 */
export const ATLAS: Record<RegionId, AtlasRect> = {
  0: { u0: 0.004, v0: 0.504, u1: 0.996, v1: 0.996 },
  1: { u0: 0.004, v0: 0.254, u1: 0.996, v1: 0.496 },
  2: { u0: 0.004, v0: 0.004, u1: 0.496, v1: 0.120 },
  3: { u0: 0.504, v0: 0.004, u1: 0.996, v1: 0.120 },
  4: { u0: 0.004, v0: 0.128, u1: 0.496, v1: 0.246 },
  5: { u0: 0.504, v0: 0.128, u1: 0.996, v1: 0.246 },
};

const mirror = (p: V3): V3 => [-p[0], p[1], p[2]];

export function buildBones(rig: BodyRig): BoneDef[] {
  const j = rig.joints;
  return [
    { name: 'Hips', parent: -1, world: j.hips },
    { name: 'Spine', parent: 0, world: j.spine },
    { name: 'Spine1', parent: 1, world: j.spine1 },
    { name: 'Spine2', parent: 2, world: j.spine2 },
    { name: 'Neck', parent: 3, world: j.neck },
    { name: 'Head', parent: 4, world: j.head },
    { name: 'HeadTop_End', parent: 5, world: j.headTop },

    { name: 'LeftShoulder', parent: 3, world: j.shoulderRoot },
    { name: 'LeftArm', parent: 7, world: j.shoulder },
    { name: 'LeftForeArm', parent: 8, world: j.elbow },
    { name: 'LeftHand', parent: 9, world: j.wrist },
    { name: 'LeftHand_End', parent: 10, world: j.handTip },

    { name: 'RightShoulder', parent: 3, world: mirror(j.shoulderRoot) },
    { name: 'RightArm', parent: 12, world: mirror(j.shoulder) },
    { name: 'RightForeArm', parent: 13, world: mirror(j.elbow) },
    { name: 'RightHand', parent: 14, world: mirror(j.wrist) },
    { name: 'RightHand_End', parent: 15, world: mirror(j.handTip) },

    { name: 'LeftUpLeg', parent: 0, world: j.upLeg },
    { name: 'LeftLeg', parent: 17, world: j.knee },
    { name: 'LeftFoot', parent: 18, world: j.ankle },
    { name: 'LeftToe_End', parent: 19, world: j.toe },

    { name: 'RightUpLeg', parent: 0, world: mirror(j.upLeg) },
    { name: 'RightLeg', parent: 21, world: mirror(j.knee) },
    { name: 'RightFoot', parent: 22, world: mirror(j.ankle) },
    { name: 'RightToe_End', parent: 23, world: mirror(j.toe) },
  ];
}

const SIGMA_SCALE = 1.7;

function weightSegments(rig: BodyRig): WeightSegment[] {
  const j = rig.joints;
  const r = rig.radii;
  const h = rig.half;
  const s: WeightSegment[] = [
    { bone: 0, region: 0, a: j.hips, b: j.spine, sigma: h.hip * SIGMA_SCALE, side: 0 },
    { bone: 1, region: 0, a: j.spine, b: j.spine1, sigma: h.waist * SIGMA_SCALE, side: 0 },
    { bone: 2, region: 0, a: j.spine1, b: j.spine2, sigma: h.chest * SIGMA_SCALE, side: 0 },
    { bone: 3, region: 0, a: j.spine2, b: j.neck, sigma: h.chest * 1.4, side: 0 },
    { bone: 4, region: 1, a: j.neck, b: j.head, sigma: h.neck * SIGMA_SCALE, side: 0 },
    { bone: 5, region: 1, a: j.head, b: j.headTop, sigma: h.head * SIGMA_SCALE, side: 0 },
  ];
  const limb = (
    bone: number,
    region: RegionId,
    a: V3,
    b: V3,
    sigma: number,
    side: -1 | 1,
  ) => {
    s.push({
      bone,
      region,
      a: side === 1 ? a : mirror(a),
      b: side === 1 ? b : mirror(b),
      sigma: sigma * SIGMA_SCALE,
      side,
    });
  };
  for (const side of [1, -1] as const) {
    const o = side === 1 ? 0 : 5;
    limb(7 + o, 0, j.shoulderRoot, j.shoulder, r.deltoid, side);
    limb(8 + o, side === 1 ? 2 : 3, j.shoulder, j.elbow, r.upperArmTop, side);
    limb(9 + o, side === 1 ? 2 : 3, j.elbow, j.wrist, r.forearmTop, side);
    limb(10 + o, side === 1 ? 2 : 3, j.wrist, j.handTip, r.forearmBottom, side);
  }
  for (const side of [1, -1] as const) {
    const o = side === 1 ? 0 : 4;
    limb(17 + o, side === 1 ? 4 : 5, j.upLeg, j.knee, r.thighTop, side);
    limb(18 + o, side === 1 ? 4 : 5, j.knee, j.ankle, r.shankTop, side);
    limb(19 + o, side === 1 ? 4 : 5, j.ankle, j.toe, r.shankBottom * 1.35, side);
  }
  return s;
}

/** Squared distance from a point to a segment, plus the parametric position. */
function segDist(
  px: number,
  py: number,
  pz: number,
  a: V3,
  b: V3,
): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = px - a[0];
  const apy = py - a[1];
  const apz = pz - a[2];
  const len2 = abx * abx + aby * aby + abz * abz || 1e-9;
  let t = (apx * abx + apy * aby + apz * abz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Regions bias slightly towards the trunk so buttocks and pectorals do not
 *  get pulled into a limb chart. */
const REGION_BIAS: Record<RegionId, number> = {
  0: 0.86,
  1: 0.94,
  2: 1,
  3: 1,
  4: 1,
  5: 1,
};

const MAX_INFLUENCES = 4;

interface ChartFrame {
  /** Origin of the axial coordinate. */
  origin: V3;
  /** Unit axis; axial = dot(p - origin, axis). */
  axis: V3;
  /** Unit "forward" reference used as angle zero. */
  fwd: V3;
  /** Unit side vector; angle = atan2(side·d, fwd·d). */
  side: V3;
}

function orthoFrame(axis: V3, hintFwd: V3): { fwd: V3; side: V3 } {
  const d = hintFwd[0] * axis[0] + hintFwd[1] * axis[1] + hintFwd[2] * axis[2];
  let fx = hintFwd[0] - axis[0] * d;
  let fy = hintFwd[1] - axis[1] * d;
  let fz = hintFwd[2] - axis[2] * d;
  let l = Math.hypot(fx, fy, fz);
  if (l < 1e-6) {
    fx = 1;
    fy = 0;
    fz = 0;
    const dd = axis[0];
    fx -= axis[0] * dd;
    fy -= axis[1] * dd;
    fz -= axis[2] * dd;
    l = Math.hypot(fx, fy, fz) || 1;
  }
  const fwd: V3 = [fx / l, fy / l, fz / l];
  const side: V3 = [
    axis[1] * fwd[2] - axis[2] * fwd[1],
    axis[2] * fwd[0] - axis[0] * fwd[2],
    axis[0] * fwd[1] - axis[1] * fwd[0],
  ];
  return { fwd, side };
}

function unit(a: V3, b: V3): V3 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const l = Math.hypot(dx, dy, dz) || 1;
  return [dx / l, dy / l, dz / l];
}

function chartFrames(rig: BodyRig): Record<RegionId, ChartFrame> {
  const j = rig.joints;
  const up: V3 = [0, 1, 0];
  const fwdHint: V3 = [0, 0, 1];

  // Trunk and head unwrap about vertical axes placed on their own centrelines,
  // so the face lands in the middle of its chart.
  const torsoZ = (j.hips[2] + j.spine2[2]) / 2;
  const headZ = (j.neck[2] + j.headTop[2]) / 2;
  const torsoBase = orthoFrame(up, fwdHint);

  const armAxis = unit(j.shoulder, j.handTip);
  const armFrame = orthoFrame(armAxis, fwdHint);
  const armAxisR = unit(mirror(j.shoulder), mirror(j.handTip));
  const armFrameR = orthoFrame(armAxisR, fwdHint);

  const legAxis = unit(j.upLeg, j.ankle);
  const legFrame = orthoFrame(legAxis, fwdHint);
  const legAxisR = unit(mirror(j.upLeg), mirror(j.ankle));
  const legFrameR = orthoFrame(legAxisR, fwdHint);

  return {
    0: { origin: [0, 0, torsoZ], axis: up, ...torsoBase },
    1: { origin: [0, 0, headZ], axis: up, ...torsoBase },
    2: { origin: j.shoulder, axis: armAxis, ...armFrame },
    3: { origin: mirror(j.shoulder), axis: armAxisR, ...armFrameR },
    4: { origin: j.upLeg, axis: legAxis, ...legFrame },
    5: { origin: mirror(j.upLeg), axis: legAxisR, ...legFrameR },
  };
}

export interface RiggedGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  skinIndices: Uint16Array;
  skinWeights: Float32Array;
  indices: Uint32Array;
  /** Region id per output vertex — used by the texture baker. */
  regions: Uint8Array;
  bones: BoneDef[];
  triangles: number;
  vertices: number;
}

export function rigMesh(mesh: PolyMesh, rig: BodyRig): RiggedGeometry {
  const bones = buildBones(rig);
  const segs = weightSegments(rig);
  const frames = chartFrames(rig);
  const n = mesh.positions.length / 3;

  const vRegion = new Uint8Array(n);
  const vAxial = new Float32Array(n);
  const vAngle = new Float32Array(n);
  const vIdx = new Uint16Array(n * MAX_INFLUENCES);
  const vWgt = new Float32Array(n * MAX_INFLUENCES);

  // Per-region axial extents, measured rather than assumed, so each chart uses
  // its whole rectangle.
  const axLo = new Float32Array(6).fill(Infinity);
  const axHi = new Float32Array(6).fill(-Infinity);

  const dists = new Float32Array(segs.length);

  for (let i = 0; i < n; i++) {
    const px = mesh.positions[i * 3];
    const py = mesh.positions[i * 3 + 1];
    const pz = mesh.positions[i * 3 + 2];

    let bestRegion: RegionId = 0;
    let bestScore = Infinity;
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      let d = segDist(px, py, pz, seg.a, seg.b);
      dists[s] = d;
      // Keep a left bone from claiming right-side flesh across the midline.
      if (seg.side !== 0) d += Math.max(0, -seg.side * px) * 2.4;
      const score = (d / seg.sigma) * REGION_BIAS[seg.region];
      if (score < bestScore) {
        bestScore = score;
        bestRegion = seg.region;
      }
    }
    vRegion[i] = bestRegion;

    // Smooth Gaussian falloff, top-4, renormalised.
    let w0 = 0;
    let w1 = 0;
    let w2 = 0;
    let w3 = 0;
    let i0 = 0;
    let i1 = 0;
    let i2 = 0;
    let i3 = 0;
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      let d = dists[s];
      if (seg.side !== 0) d += Math.max(0, -seg.side * px) * 2.4;
      const t = d / seg.sigma;
      const w = Math.exp(-t * t);
      if (w <= 1e-4) continue;
      if (w > w0) {
        w3 = w2; i3 = i2; w2 = w1; i2 = i1; w1 = w0; i1 = i0; w0 = w; i0 = seg.bone;
      } else if (w > w1) {
        w3 = w2; i3 = i2; w2 = w1; i2 = i1; w1 = w; i1 = seg.bone;
      } else if (w > w2) {
        w3 = w2; i3 = i2; w2 = w; i2 = seg.bone;
      } else if (w > w3) {
        w3 = w; i3 = seg.bone;
      }
    }
    let sum = w0 + w1 + w2 + w3;
    if (sum <= 1e-6) {
      // Fall back to hard binding on the nearest bone.
      let bs = Infinity;
      let bb = 0;
      for (let s = 0; s < segs.length; s++) {
        if (dists[s] < bs) {
          bs = dists[s];
          bb = segs[s].bone;
        }
      }
      w0 = 1; i0 = bb; w1 = 0; w2 = 0; w3 = 0;
      sum = 1;
    }
    const o = i * MAX_INFLUENCES;
    vIdx[o] = i0; vIdx[o + 1] = i1; vIdx[o + 2] = i2; vIdx[o + 3] = i3;
    vWgt[o] = w0 / sum;
    vWgt[o + 1] = w1 / sum;
    vWgt[o + 2] = w2 / sum;
    vWgt[o + 3] = w3 / sum;

    // Chart coordinates.
    const f = frames[bestRegion];
    const dx = px - f.origin[0];
    const dy = py - f.origin[1];
    const dz = pz - f.origin[2];
    const axial = dx * f.axis[0] + dy * f.axis[1] + dz * f.axis[2];
    const rx = dx - f.axis[0] * axial;
    const ry = dy - f.axis[1] * axial;
    const rz = dz - f.axis[2] * axial;
    const cf = rx * f.fwd[0] + ry * f.fwd[1] + rz * f.fwd[2];
    const cs = rx * f.side[0] + ry * f.side[1] + rz * f.side[2];
    let ang = Math.atan2(cs, cf) / (Math.PI * 2) + 0.5;
    if (ang < 0) ang = 0;
    if (ang > 1) ang = 1;
    vAxial[i] = axial;
    vAngle[i] = ang;
    if (axial < axLo[bestRegion]) axLo[bestRegion] = axial;
    if (axial > axHi[bestRegion]) axHi[bestRegion] = axial;
  }

  for (let r = 0; r < 6; r++) {
    if (!isFinite(axLo[r]) || axHi[r] - axLo[r] < 1e-6) {
      axLo[r] = 0;
      axHi[r] = 1;
    }
  }

  // ── build output buffers, duplicating across chart and seam boundaries ─────
  const triCount = mesh.indices.length / 3;
  const outPos: number[] = [];
  const outNrm: number[] = [];
  const outUv: number[] = [];
  const outIdx: number[] = [];
  const outRegion: number[] = [];
  const outSkinI: number[] = [];
  const outSkinW: number[] = [];
  const cache = new Map<number, number>();

  const emit = (vi: number, region: RegionId, snap: boolean): number => {
    const key = vi * 16 + region * 2 + (snap ? 1 : 0);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    const rect = ATLAS[region];
    const span = axHi[region] - axLo[region];
    const t = (vAxial[vi] - axLo[region]) / span;
    // Axial runs up the body; the atlas rectangle's v does too.
    const u = snap ? 1 : vAngle[vi];
    const uu = rect.u0 + (rect.u1 - rect.u0) * u;
    const vv = rect.v0 + (rect.v1 - rect.v0) * Math.min(1, Math.max(0, t));

    const idx = outPos.length / 3;
    outPos.push(
      mesh.positions[vi * 3],
      mesh.positions[vi * 3 + 1],
      mesh.positions[vi * 3 + 2],
    );
    outNrm.push(
      mesh.normals[vi * 3],
      mesh.normals[vi * 3 + 1],
      mesh.normals[vi * 3 + 2],
    );
    outUv.push(uu, vv);
    outRegion.push(region);
    const o = vi * MAX_INFLUENCES;
    outSkinI.push(vIdx[o], vIdx[o + 1], vIdx[o + 2], vIdx[o + 3]);
    outSkinW.push(vWgt[o], vWgt[o + 1], vWgt[o + 2], vWgt[o + 3]);
    cache.set(key, idx);
    return idx;
  };

  for (let t = 0; t < triCount; t++) {
    const a = mesh.indices[t * 3];
    const b = mesh.indices[t * 3 + 1];
    const c = mesh.indices[t * 3 + 2];
    // Majority region wins; ties fall to the first vertex.
    const ra = vRegion[a] as RegionId;
    const rb = vRegion[b] as RegionId;
    const rc = vRegion[c] as RegionId;
    const region: RegionId = ra === rb || ra === rc ? ra : rb === rc ? rb : ra;

    // A triangle straddling the angular seam is pinned to u = 1 on its low
    // side. That puts a one-triangle-wide stretch at the back midline, which is
    // exactly where nobody looks.
    const ua = vAngle[a];
    const ub = vAngle[b];
    const uc = vAngle[c];
    const lo = Math.min(ua, ub, uc);
    const hi = Math.max(ua, ub, uc);
    const wrapped = hi - lo > 0.5;

    outIdx.push(
      emit(a, region, wrapped && ua < 0.5),
      emit(b, region, wrapped && ub < 0.5),
      emit(c, region, wrapped && uc < 0.5),
    );
  }

  return {
    positions: new Float32Array(outPos),
    normals: new Float32Array(outNrm),
    uvs: new Float32Array(outUv),
    skinIndices: new Uint16Array(outSkinI),
    skinWeights: new Float32Array(outSkinW),
    indices: new Uint32Array(outIdx),
    regions: new Uint8Array(outRegion),
    bones,
    triangles: triCount,
    vertices: outPos.length / 3,
  };
}
