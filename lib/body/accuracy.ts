'use client';

/**
 * Silhouette agreement between the generated mesh and the photographed masks.
 *
 * The mesh is projected orthographically — at 5–7 ft on a phone lens the
 * perspective divergence across a standing body is under 2%, well below the
 * segmentation noise floor — then height-normalised and centroid-aligned to the
 * mask before scoring. Aligning first is deliberate: framing and camera
 * distance are not the model's fault, so what gets measured is shape agreement.
 */

import type { BinaryMask, SilhouetteAnalysis } from '../types';

export interface SilhouetteScore {
  iou: number;
  /** Fraction of the photo silhouette the model covers. */
  recall: number;
  /** Fraction of the model silhouette inside the photo silhouette. */
  precision: number;
}

/** Scan-convert a projected triangle soup into a binary coverage mask. */
function rasterise(
  sx: Float32Array,
  sy: Float32Array,
  indices: Uint32Array,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const tri = indices.length / 3;
  for (let t = 0; t < tri; t++) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    const ax = sx[a];
    const ay = sy[a];
    const bx = sx[b];
    const by = sy[b];
    const cx = sx[c];
    const cy = sy[c];

    let y0 = Math.floor(Math.min(ay, by, cy));
    let y1 = Math.ceil(Math.max(ay, by, cy));
    let x0 = Math.floor(Math.min(ax, bx, cx));
    let x1 = Math.ceil(Math.max(ax, bx, cx));
    if (y1 < 0 || y0 >= height || x1 < 0 || x0 >= width) continue;
    if (y0 < 0) y0 = 0;
    if (x0 < 0) x0 = 0;
    if (y1 > height - 1) y1 = height - 1;
    if (x1 > width - 1) x1 = width - 1;

    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) {
      // Degenerate after projection — still mark its footprint so thin fins
      // (fingers seen edge-on) do not punch holes in the silhouette.
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) out[y * width + x] = 1;
      }
      continue;
    }
    const inv = 1 / area;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) out[y * width + x] = 1;
      }
    }
  }
  return out;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  cx: number;
  area: number;
}

function maskBounds(mask: BinaryMask): Bounds {
  const { width, height, data } = mask;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  let cx = 0;
  let area = 0;
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      if (!data[base + x]) continue;
      area++;
      cx += x;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, maxX, minY, maxY, cx: area ? cx / area : width / 2, area };
}

/**
 * World-space → normalised image-space mapping for one capture.
 *
 * Shared by the scorer and the texture baker so a texel and its accuracy score
 * refer to exactly the same pixel. `axis` selects which world axis becomes the
 * horizontal image axis: 'x' for a frontal capture, 'z' for a profile.
 */
export interface ViewAlign {
  /** 0 = world X drives image x, 2 = world Z does. */
  horizIndex: 0 | 2;
  horizSign: number;
  /** Mask pixels per metre. */
  scale: number;
  /** Horizontal offset, mask pixels. */
  shift: number;
  /** Mask row that the model's crown maps to. */
  topRow: number;
  /** World Y of the model's crown. */
  modelTopY: number;
  maskWidth: number;
  maskHeight: number;
  ok: boolean;
}

export function alignView(
  positions: Float32Array,
  analysis: SilhouetteAnalysis,
  axis: 'x' | 'z',
): ViewAlign {
  const mask = analysis.mask;
  const mb = maskBounds(mask);
  const n = positions.length / 3;
  const horizIndex: 0 | 2 = axis === 'x' ? 0 : 2;
  const horizSign = axis === 'z' ? analysis.landmarks.facing : 1;

  const base: ViewAlign = {
    horizIndex,
    horizSign,
    scale: 1,
    shift: mask.width / 2,
    topRow: 0,
    modelTopY: 0,
    maskWidth: mask.width,
    maskHeight: mask.height,
    ok: false,
  };
  if (mb.area < 64 || mb.maxY <= mb.minY || n === 0) return base;

  let loY = Infinity;
  let hiY = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = positions[i * 3 + 1];
    if (y < loY) loY = y;
    if (y > hiY) hiY = y;
  }
  const span = hiY - loY;
  if (!(span > 1e-4)) return base;

  // Height-normalise, then centroid-align horizontally. A vertex mean stands in
  // for the area centroid because Surface Nets vertices are near-uniform.
  const scale = (mb.maxY - mb.minY + 1) / span;
  let sumH = 0;
  for (let i = 0; i < n; i++) sumH += positions[i * 3 + horizIndex] * horizSign;
  const shift = mb.cx - (sumH / n) * scale;

  return {
    horizIndex,
    horizSign,
    scale,
    shift,
    topRow: mb.minY,
    modelTopY: hiY,
    maskWidth: mask.width,
    maskHeight: mask.height,
    ok: true,
  };
}

/** Normalised [0,1] image coordinates of a world point under an alignment. */
export function projectNormalized(
  a: ViewAlign,
  x: number,
  y: number,
  z: number,
): [number, number] {
  const h = (a.horizIndex === 0 ? x : z) * a.horizSign;
  return [
    (h * a.scale + a.shift) / a.maskWidth,
    (a.topRow + (a.modelTopY - y) * a.scale) / a.maskHeight,
  ];
}

export function scoreSilhouette(
  positions: Float32Array,
  indices: Uint32Array,
  analysis: SilhouetteAnalysis,
  axis: 'x' | 'z',
): SilhouetteScore {
  const mask = analysis.mask;
  const mb = maskBounds(mask);
  const align = alignView(positions, analysis, axis);
  if (!align.ok) return { iou: 0, recall: 0, precision: 0 };

  const n = positions.length / 3;
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const h = positions[i * 3 + align.horizIndex] * align.horizSign;
    sx[i] = h * align.scale + align.shift;
    sy[i] = align.topRow + (align.modelTopY - positions[i * 3 + 1]) * align.scale;
  }

  const model = rasterise(sx, sy, indices, mask.width, mask.height);

  let inter = 0;
  let union = 0;
  let modelArea = 0;
  for (let i = 0; i < model.length; i++) {
    const a = mask.data[i] === 1;
    const b = model[i] === 1;
    if (b) modelArea++;
    if (a && b) inter++;
    if (a || b) union++;
  }
  return {
    iou: union ? inter / union : 0,
    recall: mb.area ? inter / mb.area : 0,
    precision: modelArea ? inter / modelArea : 0,
  };
}

/**
 * Headline accuracy figure. The frontal view carries more weight because it
 * constrains eight of the nine fitted parameters; the profile only constrains
 * the three sagittal depths.
 */
export function combineAccuracy(
  front: SilhouetteScore,
  profile: SilhouetteScore | null,
): number {
  if (!profile || profile.iou <= 0) return front.iou;
  return front.iou * 0.66 + profile.iou * 0.34;
}
