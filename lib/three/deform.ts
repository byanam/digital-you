'use client';

/**
 * Retarget an external base human mesh to the measured silhouette.
 *
 * Only used when a licensed base mesh is present (public/models/base-human.glb
 * or NEXT_PUBLIC_BASE_MESH_URL). The SDF path already produces a body from the
 * measurements directly; this path exists so that a studio which owns an
 * SMPL/SMPL-X or MakeHuman export can substitute their topology and keep it.
 *
 * The trunk is retargeted slice by slice against the fitted body's own width
 * and depth profile. Limbs are translated rather than scaled by the trunk
 * ratios — scaling them would fling the hands outwards — and get their own
 * girth multiplier.
 */

import * as THREE from 'three';
import type { TrunkSlice } from '../body/fit';
import { clamp, clamp01, smooth1D } from '../math';

interface BaseSlice {
  half: number;
  depth: number;
  centre: number;
}

const BANDS = 64;

/** Measure the base mesh's own trunk profile using the central-run rule. */
function measureBase(
  points: Float32Array,
  count: number,
  minY: number,
  height: number,
): BaseSlice[] {
  const binW = Math.max(0.004, height * 0.004);
  const halfSpan = 0.6;
  const cols = Math.ceil((halfSpan * 2) / binW);
  const slices: BaseSlice[] = [];

  // Bucket vertices by height band once.
  const bandOf = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const p = (points[i * 3 + 1] - minY) / height;
    bandOf[i] = clamp(Math.floor(p * BANDS), 0, BANDS - 1);
  }

  for (let b = 0; b < BANDS; b++) {
    const occ = new Uint8Array(cols);
    for (let i = 0; i < count; i++) {
      if (bandOf[i] !== b) continue;
      const x = points[i * 3];
      const c = Math.floor((x + halfSpan) / binW);
      if (c >= 0 && c < cols) occ[c] = 1;
    }
    // Central run around x = 0, tolerating single-bin dropouts.
    const mid = Math.floor(halfSpan / binW);
    let lo = mid;
    let hi = mid;
    let gap = 0;
    for (let c = mid; c >= 0; c--) {
      if (occ[c]) {
        lo = c;
        gap = 0;
      } else if (++gap > 2) break;
    }
    gap = 0;
    for (let c = mid; c < cols; c++) {
      if (occ[c]) {
        hi = c;
        gap = 0;
      } else if (++gap > 2) break;
    }
    const half = ((hi - lo + 1) * binW) / 2;

    // Depth of the trunk only: vertices inside 55% of the trunk half-width.
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < count; i++) {
      if (bandOf[i] !== b) continue;
      if (Math.abs(points[i * 3]) > half * 0.55) continue;
      const z = points[i * 3 + 2];
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const hasZ = isFinite(z0) && z1 > z0;
    slices.push({
      half: half > binW ? half : 0,
      depth: hasZ ? z1 - z0 : 0,
      centre: hasZ ? (z0 + z1) / 2 : 0,
    });
  }
  return slices;
}

function resampleTarget(target: TrunkSlice[], bands: number) {
  const half = new Float64Array(bands);
  const depth = new Float64Array(bands);
  const centre = new Float64Array(bands);
  for (let b = 0; b < bands; b++) {
    const p = (b + 0.5) / bands;
    // Linear interpolation over the target profile, which is already dense.
    let i = 0;
    while (i < target.length - 2 && target[i + 1].p < p) i++;
    const a = target[i];
    const c = target[i + 1] ?? a;
    const t = c.p > a.p ? (p - a.p) / (c.p - a.p) : 0;
    half[b] = a.half + (c.half - a.half) * t;
    depth[b] = a.depth + (c.depth - a.depth) * t;
    centre[b] = a.centre + (c.centre - a.centre) * t;
  }
  return { half, depth, centre };
}

export interface DeformOptions {
  /** Trunk silhouette to match, from the fitted parametric body. */
  target: TrunkSlice[];
  /** Extra multiplier on limb girth, typically mean(arm, thigh, calf). */
  limbGirth: number;
}

export interface DeformReport {
  meshes: number;
  vertices: number;
  /** Mean absolute trunk width correction applied, in centimetres. */
  meanCorrectionCm: number;
}

export function deformBaseMesh(
  root: THREE.Object3D,
  meshes: THREE.Mesh[],
  opts: DeformOptions,
): DeformReport {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const minY = box.min.y;
  const height = Math.max(0.1, box.max.y - box.min.y);

  // Gather every vertex in world space so the profile is measured across all
  // sub-meshes (body, hands and head are often separate primitives).
  let total = 0;
  const attrs: Array<{
    mesh: THREE.Mesh;
    attr: THREE.BufferAttribute;
    offset: number;
  }> = [];
  for (const m of meshes) {
    const attr = (m.geometry as THREE.BufferGeometry).getAttribute(
      'position',
    ) as THREE.BufferAttribute | undefined;
    if (!attr) continue;
    attrs.push({ mesh: m, attr, offset: total });
    total += attr.count;
  }
  if (total === 0) return { meshes: 0, vertices: 0, meanCorrectionCm: 0 };

  const world = new Float32Array(total * 3);
  const v = new THREE.Vector3();
  for (const entry of attrs) {
    entry.mesh.updateMatrixWorld(true);
    const M = entry.mesh.matrixWorld;
    for (let i = 0; i < entry.attr.count; i++) {
      v.fromBufferAttribute(entry.attr, i).applyMatrix4(M);
      const o = (entry.offset + i) * 3;
      world[o] = v.x;
      world[o + 1] = v.y;
      world[o + 2] = v.z;
    }
  }

  const base = measureBase(world, total, minY, height);
  const tgt = resampleTarget(opts.target, BANDS);

  // Ratio curves, smoothed so a noisy band cannot pinch the mesh.
  const rw = new Float64Array(BANDS);
  const rd = new Float64Array(BANDS);
  const dc = new Float64Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    rw[b] = base[b].half > 0.01 && tgt.half[b] > 0.01
      ? clamp(tgt.half[b] / base[b].half, 0.62, 1.6)
      : 1;
    rd[b] = base[b].depth > 0.01 && tgt.depth[b] > 0.01
      ? clamp(tgt.depth[b] / base[b].depth, 0.62, 1.6)
      : 1;
    dc[b] = tgt.centre[b] - base[b].centre;
  }
  smooth1D(rw, 3, 2);
  smooth1D(rd, 3, 2);
  smooth1D(dc, 3, 2);

  const sampleBand = (p: number) => {
    const f = clamp(p * BANDS - 0.5, 0, BANDS - 1);
    const i = Math.floor(f);
    const j = Math.min(BANDS - 1, i + 1);
    const t = f - i;
    return {
      rw: rw[i] + (rw[j] - rw[i]) * t,
      rd: rd[i] + (rd[j] - rd[i]) * t,
      dc: dc[i] + (dc[j] - dc[i]) * t,
      half: base[i].half + (base[j].half - base[i].half) * t,
      centre: base[i].centre + (base[j].centre - base[i].centre) * t,
    };
  };

  const limb = clamp(opts.limbGirth, 0.7, 1.4);
  let corrSum = 0;

  for (const entry of attrs) {
    const Minv = new THREE.Matrix4().copy(entry.mesh.matrixWorld).invert();
    for (let i = 0; i < entry.attr.count; i++) {
      const o = (entry.offset + i) * 3;
      const x = world[o];
      const y = world[o + 1];
      const z = world[o + 2];
      const p = (y - minY) / height;
      const s = sampleBand(p);

      // Trunk weight falls off past the trunk edge, so limbs translate with the
      // torso instead of being stretched away from it.
      const ax = Math.abs(x);
      const edge = Math.max(s.half, 0.01);
      const w = 1 - clamp01((ax - edge * 0.85) / (edge * 0.45));

      const scaledEdge = edge * s.rw;
      let nx: number;
      if (ax <= edge) {
        nx = x * s.rw;
      } else {
        const outside = ax - edge;
        nx = Math.sign(x) * (scaledEdge + outside * limb);
      }
      corrSum += Math.abs(nx - x);

      const rdEff = 1 + (s.rd - 1) * w + (limb - 1) * (1 - w);
      const nz = s.centre + (z - s.centre) * rdEff + s.dc * w;

      v.set(nx, y, nz).applyMatrix4(Minv);
      entry.attr.setXYZ(i, v.x, v.y, v.z);
    }
    entry.attr.needsUpdate = true;
    const g = entry.mesh.geometry as THREE.BufferGeometry;
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }

  return {
    meshes: attrs.length,
    vertices: total,
    meanCorrectionCm: (corrSum / total) * 100,
  };
}
