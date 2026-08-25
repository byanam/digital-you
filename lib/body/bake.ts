'use client';

/**
 * Photo → UV atlas baking.
 *
 * The mesh is rigged with a per-region cylindrical atlas, so baking is a
 * gather: for every texel, find the surface point that owns it, decide which
 * camera can see it, and sample. Deciding visibility is the whole problem —
 * sampling a front photo on a back-facing texel would smear the user's chest
 * across their shoulder blades.
 *
 * Visibility is settled by the surface normal, weighted by facing ratio and
 * sharply attenuated past grazing angles, then blended between the two views.
 * Texels no camera saw (the back, the inside of the arms) fall back to a
 * region-appropriate skin tone with a soft ambient-occlusion darkening, which
 * reads as "unlit" rather than "wrong".
 */

import type { RasterImage } from '../imaging';
import type { SilhouetteAnalysis } from '../types';
import { clamp01 } from '../math';
import { ATLAS, type RegionId, type RiggedGeometry } from './rigging';
import { alignView, projectNormalized, type ViewAlign } from './accuracy';

export const ATLAS_SIZE = 1024;

export interface BakeInput {
  geometry: RiggedGeometry;
  front: { raster: RasterImage; analysis: SilhouetteAnalysis };
  profile: { raster: RasterImage; analysis: SilhouetteAnalysis } | null;
}

export interface BakeResult {
  /** RGBA atlas, ATLAS_SIZE². */
  canvas: HTMLCanvasElement;
  /** Median skin tone, used for the material's fallback colour. */
  skin: [number, number, number];
  /** Fraction of body texels that received real photo colour. */
  coverage: number;
}

interface TexelSample {
  /** Surface position. */
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
  region: RegionId;
}

/**
 * Rasterise the mesh into the atlas, recording position and normal per texel.
 * This inverts the UV map without ever needing an analytic inverse.
 */
function gbuffer(geo: RiggedGeometry, size: number) {
  const n = size * size;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const region = new Uint8Array(n);
  const filled = new Uint8Array(n);
  const tri = geo.indices.length / 3;

  for (let t = 0; t < tri; t++) {
    const i0 = geo.indices[t * 3];
    const i1 = geo.indices[t * 3 + 1];
    const i2 = geo.indices[t * 3 + 2];
    const ax = geo.uvs[i0 * 2] * size;
    const ay = (1 - geo.uvs[i0 * 2 + 1]) * size;
    const bx = geo.uvs[i1 * 2] * size;
    const by = (1 - geo.uvs[i1 * 2 + 1]) * size;
    const cx = geo.uvs[i2 * 2] * size;
    const cy = (1 - geo.uvs[i2 * 2 + 1]) * size;

    let y0 = Math.floor(Math.min(ay, by, cy)) - 1;
    let y1 = Math.ceil(Math.max(ay, by, cy)) + 1;
    let x0 = Math.floor(Math.min(ax, bx, cx)) - 1;
    let x1 = Math.ceil(Math.max(ax, bx, cx)) + 1;
    if (y0 < 0) y0 = 0;
    if (x0 < 0) x0 = 0;
    if (y1 > size - 1) y1 = size - 1;
    if (x1 > size - 1) x1 = size - 1;
    if (y1 < y0 || x1 < x0) continue;

    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue;
    const inv = 1 / area;
    const r = geo.regions[i0];

    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        let w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
        let w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
        let w2 = 1 - w0 - w1;
        // A one-texel dilation of every triangle stops bilinear filtering from
        // fetching background across a chart seam.
        const slack = -0.06;
        if (w0 < slack || w1 < slack || w2 < slack) continue;
        const i = y * size + x;
        if (filled[i]) continue;
        w0 = clamp01(w0);
        w1 = clamp01(w1);
        w2 = clamp01(w2);
        const s = w0 + w1 + w2 || 1;
        w0 /= s;
        w1 /= s;
        w2 /= s;
        pos[i * 3] =
          geo.positions[i0 * 3] * w0 +
          geo.positions[i1 * 3] * w1 +
          geo.positions[i2 * 3] * w2;
        pos[i * 3 + 1] =
          geo.positions[i0 * 3 + 1] * w0 +
          geo.positions[i1 * 3 + 1] * w1 +
          geo.positions[i2 * 3 + 1] * w2;
        pos[i * 3 + 2] =
          geo.positions[i0 * 3 + 2] * w0 +
          geo.positions[i1 * 3 + 2] * w1 +
          geo.positions[i2 * 3 + 2] * w2;
        let vx =
          geo.normals[i0 * 3] * w0 +
          geo.normals[i1 * 3] * w1 +
          geo.normals[i2 * 3] * w2;
        let vy =
          geo.normals[i0 * 3 + 1] * w0 +
          geo.normals[i1 * 3 + 1] * w1 +
          geo.normals[i2 * 3 + 1] * w2;
        let vz =
          geo.normals[i0 * 3 + 2] * w0 +
          geo.normals[i1 * 3 + 2] * w1 +
          geo.normals[i2 * 3 + 2] * w2;
        const l = Math.hypot(vx, vy, vz) || 1;
        nrm[i * 3] = vx / l;
        nrm[i * 3 + 1] = vy / l;
        nrm[i * 3 + 2] = vz / l;
        region[i] = r;
        filled[i] = 1;
      }
    }
  }
  return { pos, nrm, region, filled };
}

/** Bilinear RGB fetch with a mask test; returns null on background. */
function sampleMasked(
  raster: RasterImage,
  analysis: SilhouetteAnalysis,
  u: number,
  v: number,
): [number, number, number] | null {
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const mask = analysis.mask;
  const mx = Math.min(mask.width - 1, Math.max(0, (u * mask.width) | 0));
  const my = Math.min(mask.height - 1, Math.max(0, (v * mask.height) | 0));
  if (!mask.data[my * mask.width + mx]) return null;

  const fx = u * (raster.width - 1);
  const fy = v * (raster.height - 1);
  const x0 = Math.max(0, Math.min(raster.width - 1, fx | 0));
  const y0 = Math.max(0, Math.min(raster.height - 1, fy | 0));
  const x1 = Math.min(raster.width - 1, x0 + 1);
  const y1 = Math.min(raster.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (x: number, y: number, c: number) =>
    raster.data[(y * raster.width + x) * 4 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx;
    const b = at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
  return out;
}

/** Push filled colour into unfilled texels — closes atlas gaps and seams. */
function inpaint(
  rgb: Float32Array,
  weight: Float32Array,
  size: number,
  bodyMask: Uint8Array,
  rounds: number,
) {
  const nextRgb = new Float32Array(rgb.length);
  const nextW = new Float32Array(weight.length);
  for (let r = 0; r < rounds; r++) {
    nextRgb.set(rgb);
    nextW.set(weight);
    let changed = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (weight[i] > 0.02) continue;
        let ar = 0;
        let ag = 0;
        let ab = 0;
        let aw = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= size) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= size) continue;
            const j = yy * size + xx;
            const w = weight[j];
            if (w <= 0.02) continue;
            ar += rgb[j * 3] * w;
            ag += rgb[j * 3 + 1] * w;
            ab += rgb[j * 3 + 2] * w;
            aw += w;
          }
        }
        if (aw <= 0) continue;
        nextRgb[i * 3] = ar / aw;
        nextRgb[i * 3 + 1] = ag / aw;
        nextRgb[i * 3 + 2] = ab / aw;
        // Diffused colour is trusted less than measured colour, so a long fill
        // fades out instead of propagating a hard edge.
        nextW[i] = Math.min(0.9, aw / 9) * (bodyMask[i] ? 1 : 0.6);
        changed++;
      }
    }
    rgb.set(nextRgb);
    weight.set(nextW);
    if (!changed) break;
  }
}

/**
 * Facing weight for one camera. `dir` is the direction the camera looks along
 * (world space, pointing from camera into the scene).
 */
function facingWeight(nx: number, ny: number, nz: number, dir: [number, number, number]) {
  // Normal points outwards, camera looks along dir, so visibility ∝ -n·dir.
  const c = -(nx * dir[0] + ny * dir[1] + nz * dir[2]);
  if (c <= 0.12) return 0;
  // cos³ concentrates the weight where the surface faces the lens squarely and
  // kills the stretched, grazing-angle texels that read as smear.
  return c * c * c;
}

export function bakeTexture(input: BakeInput): BakeResult {
  const { geometry, front, profile } = input;
  const size = ATLAS_SIZE;
  const gb = gbuffer(geometry, size);

  const frontAlign = alignView(geometry.positions, front.analysis, 'x');
  const profileAlign = profile
    ? alignView(geometry.positions, profile.analysis, 'z')
    : null;

  // Front camera looks along -Z (subject faces +Z). Profile looks along -X
  // after the facing sign is folded in, matching alignView's convention.
  const frontDir: [number, number, number] = [0, 0, -1];
  const profileSign = profile ? profile.analysis.landmarks.facing : 1;
  const profileDir: [number, number, number] = [-profileSign, 0, 0];

  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const weight = new Float32Array(n);

  const skinR: number[] = [];
  const skinG: number[] = [];
  const skinB: number[] = [];

  const sampleView = (
    align: ViewAlign | null,
    src: { raster: RasterImage; analysis: SilhouetteAnalysis } | null,
    dir: [number, number, number],
    i: number,
  ): { rgb: [number, number, number]; w: number } | null => {
    if (!align || !align.ok || !src) return null;
    const w = facingWeight(gb.nrm[i * 3], gb.nrm[i * 3 + 1], gb.nrm[i * 3 + 2], dir);
    if (w <= 0) return null;
    const [u, v] = projectNormalized(
      align,
      gb.pos[i * 3],
      gb.pos[i * 3 + 1],
      gb.pos[i * 3 + 2],
    );
    const c = sampleMasked(src.raster, src.analysis, u, v);
    return c ? { rgb: c, w } : null;
  };

  let covered = 0;
  let bodyTexels = 0;

  for (let i = 0; i < n; i++) {
    if (!gb.filled[i]) continue;
    bodyTexels++;

    const a = sampleView(frontAlign, front, frontDir, i);
    const b = sampleView(profileAlign, profile, profileDir, i);
    // A profile shot sees one flank; give the frontal view priority where both
    // are plausible, because it is the view the user framed carefully.
    let wa = a ? a.w * 1.25 : 0;
    let wb = b ? b.w : 0;
    const tot = wa + wb;
    if (tot <= 1e-4) continue;
    wa /= tot;
    wb /= tot;
    const r = (a ? a.rgb[0] * wa : 0) + (b ? b.rgb[0] * wb : 0);
    const g = (a ? a.rgb[1] * wa : 0) + (b ? b.rgb[1] * wb : 0);
    const bl = (a ? a.rgb[2] * wa : 0) + (b ? b.rgb[2] * wb : 0);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = bl;
    weight[i] = Math.min(1, tot);
    covered++;

    // Skin tone reference: sample the face and forearms only, and only where
    // the camera saw the surface head-on.
    if (tot > 0.55 && (gb.region[i] === 1 || gb.region[i] === 2)) {
      if (skinR.length < 20000) {
        skinR.push(r);
        skinG.push(g);
        skinB.push(bl);
      }
    }
  }

  const med = (arr: number[], fallback: number) => {
    if (arr.length === 0) return fallback;
    arr.sort((p, q) => p - q);
    return arr[arr.length >> 1];
  };
  const skin: [number, number, number] = [
    med(skinR, 189),
    med(skinG, 151),
    med(skinB, 128),
  ];

  inpaint(rgb, weight, size, gb.filled, 96);

  // Compose: measured colour over a skin base, with an occlusion-ish tint so
  // unseen regions recede rather than glowing.
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  const img = ctx.createImageData(size, size);

  for (let i = 0; i < n; i++) {
    const w = clamp01(weight[i]);
    const o = i * 4;
    // Back-facing texels get a slightly cooler, darker base.
    const back = gb.filled[i] ? clamp01(-gb.nrm[i * 3 + 2] * 0.5 + 0.5) : 0.5;
    const shade = 1 - 0.16 * back;
    const baseR = skin[0] * shade;
    const baseG = skin[1] * shade * 0.995;
    const baseB = skin[2] * shade * 1.01;
    img.data[o] = Math.round(rgb[i * 3] * w + baseR * (1 - w));
    img.data[o + 1] = Math.round(rgb[i * 3 + 1] * w + baseG * (1 - w));
    img.data[o + 2] = Math.round(rgb[i * 3 + 2] * w + baseB * (1 - w));
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Fill the inter-chart gutters with the skin tone so mip-mapping at low LOD
  // never bleeds pure black into the silhouette edge.
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = `rgb(${Math.round(skin[0])},${Math.round(skin[1])},${Math.round(skin[2])})`;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  return {
    canvas,
    skin,
    coverage: bodyTexels ? covered / bodyTexels : 0,
  };
}

/** Debug helper: draw the atlas rectangles, handy when tuning the layout. */
export function atlasGuide(size = ATLAS_SIZE): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.strokeStyle = '#8AB4FF';
  ctx.lineWidth = 2;
  for (const key of Object.keys(ATLAS) as unknown as RegionId[]) {
    const r = ATLAS[key];
    ctx.strokeRect(
      r.u0 * size,
      (1 - r.v1) * size,
      (r.u1 - r.u0) * size,
      (r.v1 - r.v0) * size,
    );
  }
  return canvas;
}
