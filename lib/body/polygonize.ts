/**
 * Isosurface extraction (Naive Surface Nets) with a two-level field sampler.
 *
 * Surface Nets is used in preference to Marching Cubes because it places one
 * vertex per surface cell rather than up to five, giving a smoother, more
 * uniform, quad-dominant mesh at half the triangle count — which matters when
 * the target is a phone.
 *
 * The two-level sampler exploits the fact that the body field is Lipschitz-1:
 * a coarse pass at 1/4 resolution proves that whole 4³ blocks are far from the
 * surface, and those points are filled by trilinear interpolation instead of a
 * full field evaluation. In practice ~88% of evaluations are skipped, which is
 * what makes a 7 mm voxel grid affordable in the browser.
 */

import { nextFrame } from '../math';
import type { V3 } from './anatomy';

export interface PolyMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangles: number;
  vertices: number;
}

export interface PolygonizeOptions {
  /** Target edge length of a voxel, in metres. */
  voxel: number;
  /** Taubin smoothing passes (λ/μ pairs). */
  smoothPasses?: number;
  onProgress?: (t: number) => void;
  /** Yield to the browser between slabs so the UI keeps painting. */
  yieldEvery?: number;
}

// ── Surface Nets tables, generated rather than hard-coded ────────────────────
const CUBE_EDGES = new Int32Array(24);
const EDGE_TABLE = new Int32Array(256);
(() => {
  let k = 0;
  for (let i = 0; i < 8; i++) {
    for (let j = 1; j <= 4; j <<= 1) {
      const p = i ^ j;
      if (i <= p) {
        CUBE_EDGES[k++] = i;
        CUBE_EDGES[k++] = p;
      }
    }
  }
  for (let i = 0; i < 256; i++) {
    let em = 0;
    for (let j = 0; j < 24; j += 2) {
      const a = !!(i & (1 << CUBE_EDGES[j]));
      const b = !!(i & (1 << CUBE_EDGES[j + 1]));
      em |= a !== b ? 1 << (j >> 1) : 0;
    }
    EDGE_TABLE[i] = em;
  }
})();

type Sdf = (x: number, y: number, z: number) => number;

const COARSE_FACTOR = 4;

/** Fill a dense scalar field, skipping evaluations that cannot matter. */
async function sampleField(
  sdf: Sdf,
  min: V3,
  dims: [number, number, number],
  spacing: number,
  onProgress?: (t: number) => void,
): Promise<Float32Array> {
  const [nx, ny, nz] = dims;
  const field = new Float32Array(nx * ny * nz);

  // Coarse pass.
  const cf = COARSE_FACTOR;
  const cx = Math.ceil((nx - 1) / cf) + 1;
  const cy = Math.ceil((ny - 1) / cf) + 1;
  const cz = Math.ceil((nz - 1) / cf) + 1;
  const coarse = new Float32Array(cx * cy * cz);
  for (let k = 0; k < cz; k++) {
    const wz = min[2] + k * cf * spacing;
    for (let j = 0; j < cy; j++) {
      const wy = min[1] + j * cf * spacing;
      const base = cx * (j + cy * k);
      for (let i = 0; i < cx; i++) {
        coarse[i + base] = sdf(min[0] + i * cf * spacing, wy, wz);
      }
    }
  }

  // A fine point is at most (√3/2)·4·spacing from a coarse corner, so this
  // bound is conservative for a Lipschitz-1 field.
  const farThreshold = cf * spacing * 1.0;

  let lastYield = performance.now();
  for (let k = 0; k < nz; k++) {
    const wz = min[2] + k * spacing;
    const kc = Math.min(cz - 2, (k / cf) | 0);
    const fk = (k - kc * cf) / cf;

    for (let j = 0; j < ny; j++) {
      const wy = min[1] + j * spacing;
      const jc = Math.min(cy - 2, (j / cf) | 0);
      const fj = (j - jc * cf) / cf;
      const rowBase = nx * (j + ny * k);

      for (let i = 0; i < nx; i++) {
        const ic = Math.min(cx - 2, (i / cf) | 0);
        const fi = (i - ic * cf) / cf;

        const c000 = coarse[ic + cx * (jc + cy * kc)];
        const c100 = coarse[ic + 1 + cx * (jc + cy * kc)];
        const c010 = coarse[ic + cx * (jc + 1 + cy * kc)];
        const c110 = coarse[ic + 1 + cx * (jc + 1 + cy * kc)];
        const c001 = coarse[ic + cx * (jc + cy * (kc + 1))];
        const c101 = coarse[ic + 1 + cx * (jc + cy * (kc + 1))];
        const c011 = coarse[ic + cx * (jc + 1 + cy * (kc + 1))];
        const c111 = coarse[ic + 1 + cx * (jc + 1 + cy * (kc + 1))];

        let lo = Math.abs(c000);
        const abs = (v: number) => {
          const a = v < 0 ? -v : v;
          if (a < lo) lo = a;
        };
        abs(c100);
        abs(c010);
        abs(c110);
        abs(c001);
        abs(c101);
        abs(c011);
        abs(c111);

        if (lo > farThreshold) {
          // Far from the surface — trilinear is plenty (only the sign is used).
          const x00 = c000 + (c100 - c000) * fi;
          const x10 = c010 + (c110 - c010) * fi;
          const x01 = c001 + (c101 - c001) * fi;
          const x11 = c011 + (c111 - c011) * fi;
          const y0 = x00 + (x10 - x00) * fj;
          const y1 = x01 + (x11 - x01) * fj;
          field[i + rowBase] = y0 + (y1 - y0) * fk;
        } else {
          field[i + rowBase] = sdf(min[0] + i * spacing, wy, wz);
        }
      }
    }

    onProgress?.((k + 1) / nz);
    if (performance.now() - lastYield > 24) {
      await nextFrame();
      lastYield = performance.now();
    }
  }

  return field;
}

interface RawMesh {
  verts: number[];
  quads: number[];
}

function surfaceNets(
  field: Float32Array,
  dims: [number, number, number],
): RawMesh {
  const verts: number[] = [];
  const quads: number[] = [];
  const [d0, d1, d2] = dims;

  const R: [number, number, number] = [1, d0 + 1, (d0 + 1) * (d1 + 1)];
  const buffer = new Int32Array(R[2] * 2);
  const grid = new Float32Array(8);
  const x: [number, number, number] = [0, 0, 0];
  const v: [number, number, number] = [0, 0, 0];
  let n = 0;
  let bufNo = 1;

  for (x[2] = 0; x[2] < d2 - 1; ++x[2], n += d0, bufNo ^= 1, R[2] = -R[2]) {
    let m = 1 + (d0 + 1) * (1 + bufNo * (d1 + 1));
    for (x[1] = 0; x[1] < d1 - 1; ++x[1], ++n, m += 2) {
      for (x[0] = 0; x[0] < d0 - 1; ++x[0], ++n, ++m) {
        let mask = 0;
        let g = 0;
        let idx = n;
        for (let k = 0; k < 2; ++k, idx += d0 * (d1 - 2)) {
          for (let j = 0; j < 2; ++j, idx += d0 - 2) {
            for (let i = 0; i < 2; ++i, ++g, ++idx) {
              const p = field[idx];
              grid[g] = p;
              mask |= p < 0 ? 1 << g : 0;
            }
          }
        }
        if (mask === 0 || mask === 0xff) continue;

        const edgeMask = EDGE_TABLE[mask];
        v[0] = 0;
        v[1] = 0;
        v[2] = 0;
        let eCount = 0;

        for (let i = 0; i < 12; ++i) {
          if (!(edgeMask & (1 << i))) continue;
          ++eCount;
          const e0 = CUBE_EDGES[i << 1];
          const e1 = CUBE_EDGES[(i << 1) + 1];
          const g0 = grid[e0];
          const g1 = grid[e1];
          let t = g0 - g1;
          if (Math.abs(t) <= 1e-10) continue;
          t = g0 / t;
          for (let j = 0, k = 1; j < 3; ++j, k <<= 1) {
            const a = e0 & k;
            const b = e1 & k;
            if (a !== b) v[j] += a ? 1 - t : t;
            else v[j] += a ? 1 : 0;
          }
        }
        if (eCount === 0) continue;

        const s = 1 / eCount;
        const vi = verts.length / 3;
        verts.push(x[0] + s * v[0], x[1] + s * v[1], x[2] + s * v[2]);
        buffer[m] = vi;

        for (let i = 0; i < 3; ++i) {
          if (!(edgeMask & (1 << i))) continue;
          const iu = (i + 1) % 3;
          const iv = (i + 2) % 3;
          if (x[iu] === 0 || x[iv] === 0) continue;
          const du = R[iu];
          const dv = R[iv];
          if (mask & 1) {
            quads.push(buffer[m], buffer[m - du], buffer[m - du - dv], buffer[m - dv]);
          } else {
            quads.push(buffer[m], buffer[m - dv], buffer[m - du - dv], buffer[m - du]);
          }
        }
      }
    }
  }

  return { verts, quads };
}

/** Adjacency from quad faces, as a flat CSR-ish structure. */
function buildAdjacency(vertexCount: number, quads: number[]) {
  const counts = new Uint16Array(vertexCount);
  const bump = (a: number) => {
    if (counts[a] < 65535) counts[a]++;
  };
  for (let q = 0; q < quads.length; q += 4) {
    for (let e = 0; e < 4; e++) {
      bump(quads[q + e]);
      bump(quads[q + ((e + 1) & 3)]);
    }
  }
  const offsets = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < vertexCount; i++) offsets[i + 1] = offsets[i] + counts[i];
  const neighbours = new Uint32Array(offsets[vertexCount]);
  const cursor = offsets.slice(0, vertexCount);
  const link = (a: number, b: number) => {
    neighbours[cursor[a]++] = b;
  };
  for (let q = 0; q < quads.length; q += 4) {
    for (let e = 0; e < 4; e++) {
      const a = quads[q + e];
      const b = quads[q + ((e + 1) & 3)];
      link(a, b);
      link(b, a);
    }
  }
  return { offsets, neighbours };
}

/** Taubin λ|μ smoothing — removes voxel ripple without shrinking the body. */
function taubinSmooth(
  positions: Float32Array,
  adj: { offsets: Uint32Array; neighbours: Uint32Array },
  passes: number,
) {
  const n = positions.length / 3;
  const tmp = new Float32Array(positions.length);
  const step = (factor: number, src: Float32Array, dst: Float32Array) => {
    for (let i = 0; i < n; i++) {
      const s = adj.offsets[i];
      const e = adj.offsets[i + 1];
      const deg = e - s;
      if (deg === 0) {
        dst[i * 3] = src[i * 3];
        dst[i * 3 + 1] = src[i * 3 + 1];
        dst[i * 3 + 2] = src[i * 3 + 2];
        continue;
      }
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (let k = s; k < e; k++) {
        const j = adj.neighbours[k] * 3;
        ax += src[j];
        ay += src[j + 1];
        az += src[j + 2];
      }
      ax /= deg;
      ay /= deg;
      az /= deg;
      dst[i * 3] = src[i * 3] + factor * (ax - src[i * 3]);
      dst[i * 3 + 1] = src[i * 3 + 1] + factor * (ay - src[i * 3 + 1]);
      dst[i * 3 + 2] = src[i * 3 + 2] + factor * (az - src[i * 3 + 2]);
    }
  };
  for (let p = 0; p < passes; p++) {
    step(0.55, positions, tmp);
    step(-0.53, tmp, positions);
  }
}

export async function polygonizeField(
  sdf: Sdf,
  bounds: { min: V3; max: V3 },
  opts: PolygonizeOptions,
): Promise<PolyMesh> {
  const spacing = opts.voxel;
  const pad = spacing * 2;
  const min: V3 = [
    bounds.min[0] - pad,
    bounds.min[1] - pad,
    bounds.min[2] - pad,
  ];
  const dims: [number, number, number] = [
    Math.max(8, Math.ceil((bounds.max[0] - bounds.min[0] + pad * 2) / spacing) + 1),
    Math.max(8, Math.ceil((bounds.max[1] - bounds.min[1] + pad * 2) / spacing) + 1),
    Math.max(8, Math.ceil((bounds.max[2] - bounds.min[2] + pad * 2) / spacing) + 1),
  ];

  const field = await sampleField(sdf, min, dims, spacing, (t) =>
    opts.onProgress?.(t * 0.7),
  );

  const raw = surfaceNets(field, dims);
  opts.onProgress?.(0.82);

  const vertexCount = raw.verts.length / 3;
  if (vertexCount === 0) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      triangles: 0,
      vertices: 0,
    };
  }

  // Grid space → world space.
  const positions = new Float32Array(raw.verts.length);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = min[0] + raw.verts[i * 3] * spacing;
    positions[i * 3 + 1] = min[1] + raw.verts[i * 3 + 1] * spacing;
    positions[i * 3 + 2] = min[2] + raw.verts[i * 3 + 2] * spacing;
  }

  const adj = buildAdjacency(vertexCount, raw.quads);
  taubinSmooth(positions, adj, Math.max(0, opts.smoothPasses ?? 2));
  opts.onProgress?.(0.9);

  // One Newton step back onto the true isosurface: smoothing then re-projecting
  // gives a silky surface that still honours the measured silhouette.
  const h = spacing * 0.35;
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < vertexCount; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    let gx = sdf(px + h, py, pz) - sdf(px - h, py, pz);
    let gy = sdf(px, py + h, pz) - sdf(px, py - h, pz);
    let gz = sdf(px, py, pz + h) - sdf(px, py, pz - h);
    let len = Math.hypot(gx, gy, gz) || 1e-9;
    gx /= len;
    gy /= len;
    gz /= len;
    const d = sdf(px, py, pz);
    // Clamp the correction so a bad gradient can never fling a vertex away.
    const corr = Math.max(-spacing * 0.6, Math.min(spacing * 0.6, d));
    const nx = px - gx * corr;
    const nyy = py - gy * corr;
    const nz = pz - gz * corr;
    positions[i * 3] = nx;
    positions[i * 3 + 1] = nyy;
    positions[i * 3 + 2] = nz;

    gx = sdf(nx + h, nyy, nz) - sdf(nx - h, nyy, nz);
    gy = sdf(nx, nyy + h, nz) - sdf(nx, nyy - h, nz);
    gz = sdf(nx, nyy, nz + h) - sdf(nx, nyy, nz - h);
    len = Math.hypot(gx, gy, gz) || 1e-9;
    normals[i * 3] = gx / len;
    normals[i * 3 + 1] = gy / len;
    normals[i * 3 + 2] = gz / len;
  }
  opts.onProgress?.(0.96);

  // Quads → triangles.
  const triCount = (raw.quads.length / 4) * 2;
  const indices = new Uint32Array(triCount * 3);
  let w = 0;
  for (let q = 0; q < raw.quads.length; q += 4) {
    const a = raw.quads[q];
    const b = raw.quads[q + 1];
    const c = raw.quads[q + 2];
    const d = raw.quads[q + 3];
    indices[w++] = a;
    indices[w++] = b;
    indices[w++] = c;
    indices[w++] = a;
    indices[w++] = c;
    indices[w++] = d;
  }

  // Winding sanity check against the analytic normals; flip wholesale if the
  // majority disagree (cheaper and more robust than reasoning about the table).
  let agree = 0;
  let disagree = 0;
  const probe = Math.min(triCount, 400);
  for (let t = 0; t < probe; t++) {
    const i0 = indices[t * 3] * 3;
    const i1 = indices[t * 3 + 1] * 3;
    const i2 = indices[t * 3 + 2] * 3;
    const e1x = positions[i1] - positions[i0];
    const e1y = positions[i1 + 1] - positions[i0 + 1];
    const e1z = positions[i1 + 2] - positions[i0 + 2];
    const e2x = positions[i2] - positions[i0];
    const e2y = positions[i2 + 1] - positions[i0 + 1];
    const e2z = positions[i2 + 2] - positions[i0 + 2];
    const fx = e1y * e2z - e1z * e2y;
    const fy = e1z * e2x - e1x * e2z;
    const fz = e1x * e2y - e1y * e2x;
    const dot =
      fx * normals[i0] + fy * normals[i0 + 1] + fz * normals[i0 + 2];
    if (dot >= 0) agree++;
    else disagree++;
  }
  if (disagree > agree) {
    for (let t = 0; t < triCount; t++) {
      const a = indices[t * 3 + 1];
      indices[t * 3 + 1] = indices[t * 3 + 2];
      indices[t * 3 + 2] = a;
    }
  }

  opts.onProgress?.(1);
  return {
    positions,
    normals,
    indices,
    triangles: triCount,
    vertices: vertexCount,
  };
}
