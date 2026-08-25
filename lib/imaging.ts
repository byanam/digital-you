'use client';

import type { CapturedPhoto, CaptureView } from './types';

export const CAPTURE_MAX_EDGE = 1024;
export const CAPTURE_QUALITY = 0.85;

/** Longest-edge-limited canvas draw, preserving aspect ratio. */
function fitSize(w: number, h: number, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

function makeCanvas(width: number, height: number) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/**
 * Downscale to <= 1024px on the long edge and encode JPEG q0.85.
 * Keeps request payloads at roughly 150–350 KB per photo.
 */
export function encodeCapture(
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
  view: CaptureView,
  opts: { mirrored?: boolean; unmirror?: boolean } = {},
): CapturedPhoto {
  const sw =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : source instanceof HTMLImageElement
        ? source.naturalWidth
        : source.width;
  const sh =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : source instanceof HTMLImageElement
        ? source.naturalHeight
        : source.height;

  const { width, height } = fitSize(sw || 1, sh || 1, CAPTURE_MAX_EDGE);
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // The selfie preview is mirrored by CSS for comfort, but getUserMedia frames
  // are NOT mirrored. We always store un-mirrored pixels so the texture
  // projection maths stays in one convention (avatar's left = image right).
  if (opts.unmirror) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, 0, 0, width, height);

  return {
    view,
    dataUrl: canvas.toDataURL('image/jpeg', CAPTURE_QUALITY),
    width,
    height,
    mirrored: false,
  };
}

/** Read a user-selected file into a compressed CapturedPhoto. */
export async function encodeFile(
  file: File,
  view: CaptureView,
): Promise<CapturedPhoto> {
  const img = await loadImage(URL.createObjectURL(file));
  try {
    return encodeCapture(img, view);
  } finally {
    URL.revokeObjectURL(img.src);
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = src;
  });
}

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8ClampedArray;
}

/** Decode a data URL to raw pixels, optionally downscaled for analysis. */
export async function toRaster(
  dataUrl: string,
  maxEdge?: number,
): Promise<RasterImage> {
  const img = await loadImage(dataUrl);
  const { width, height } = maxEdge
    ? fitSize(img.naturalWidth, img.naturalHeight, maxEdge)
    : { width: img.naturalWidth, height: img.naturalHeight };
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

/**
 * Composite a photo with its person-mask in the alpha channel, so the texture
 * projector can reject background pixels with a single alpha test.
 */
export function compositeMaskedTexture(
  raster: RasterImage,
  mask: { width: number; height: number; data: Uint8Array },
  featherPx = 2,
): HTMLCanvasElement {
  const { width, height } = raster;
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  const out = ctx.createImageData(width, height);

  // Soft alpha: distance-to-edge approximation via a small box average of the
  // mask, which feathers the cut-out and hides segmentation jitter.
  const sx = mask.width / width;
  const sy = mask.height / height;
  const r = Math.max(0, featherPx | 0);

  for (let y = 0; y < height; y++) {
    const my = Math.min(mask.height - 1, (y * sy) | 0);
    for (let x = 0; x < width; x++) {
      const mx = Math.min(mask.width - 1, (x * sx) | 0);
      let acc = 0;
      let cnt = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = my + dy;
        if (yy < 0 || yy >= mask.height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = mx + dx;
          if (xx < 0 || xx >= mask.width) continue;
          acc += mask.data[yy * mask.width + xx];
          cnt++;
        }
      }
      const a = cnt ? acc / cnt : 0;
      const i = (y * width + x) * 4;
      out.data[i] = raster.data[i];
      out.data[i + 1] = raster.data[i + 1];
      out.data[i + 2] = raster.data[i + 2];
      out.data[i + 3] = Math.round(255 * Math.min(1, a * 1.25));
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/** Median RGB inside a rectangular window, restricted to mask = 1 pixels. */
export function sampleRegionColor(
  raster: RasterImage,
  mask: { width: number; height: number; data: Uint8Array },
  rect: { x0: number; y0: number; x1: number; y1: number },
): [number, number, number] {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const sx = mask.width / raster.width;
  const sy = mask.height / raster.height;
  const x0 = Math.max(0, Math.floor(rect.x0));
  const x1 = Math.min(raster.width - 1, Math.ceil(rect.x1));
  const y0 = Math.max(0, Math.floor(rect.y0));
  const y1 = Math.min(raster.height - 1, Math.ceil(rect.y1));
  const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 48));
  for (let y = y0; y <= y1; y += step) {
    const my = Math.min(mask.height - 1, (y * sy) | 0);
    for (let x = x0; x <= x1; x += step) {
      const mx = Math.min(mask.width - 1, (x * sx) | 0);
      if (!mask.data[my * mask.width + mx]) continue;
      const i = (y * raster.width + x) * 4;
      rs.push(raster.data[i]);
      gs.push(raster.data[i + 1]);
      bs.push(raster.data[i + 2]);
    }
  }
  if (rs.length === 0) return [176, 141, 118];
  const med = (a: number[]) => {
    a.sort((p, q) => p - q);
    return a[a.length >> 1];
  };
  return [med(rs), med(gs), med(bs)];
}
