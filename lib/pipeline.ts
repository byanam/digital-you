'use client';

/**
 * The reconstruction pipeline, in the order the processing screen reports it.
 *
 * Stages 1–2 always run locally even when a neural provider is configured:
 * they are cheap, and they are what produces the biometric telemetry. Stage 3
 * is where the two paradigms diverge — either a provider returns a textured
 * .glb, or the parametric body is fitted, polygonised, rigged and baked here.
 */

import * as THREE from 'three';
import type {
  AvatarResult,
  BodyMetrics,
  CapturedPhoto,
  PipelineStageId,
  ReconstructPlan,
  SilhouetteAnalysis,
  UserProfileInput,
} from './types';
import { clamp, clamp01, nextFrame } from './math';
import { toRaster, type RasterImage } from './imaging';
import { ANALYSIS_MAX_EDGE, segmentPerson } from './vision/segment';
import { analyzeSilhouette } from './vision/landmarks';
import { estimateBody } from './measurements';
import { measureField, refineShape, trunkProfile, type FitTargets } from './body/fit';
import { polygonizeField } from './body/polygonize';
import { rigMesh } from './body/rigging';
import { bakeTexture, type BakeResult } from './body/bake';
import { combineAccuracy, scoreSilhouette } from './body/accuracy';
import {
  buildAvatarObject,
  loadGltf,
  normalizeToStature,
  type AvatarObject,
  type LoadedGltf,
} from './three/avatar';
import { deformBaseMesh } from './three/deform';

export type StageReporter = (
  stage: PipelineStageId,
  progress: number,
  note?: string,
) => void;

export interface PipelineInput {
  photos: CapturedPhoto[];
  profile: UserProfileInput;
  report?: StageReporter;
  /** Set false to skip the /api/reconstruct round-trip entirely. */
  allowNeural?: boolean;
  signal?: AbortSignal;
}

export interface PipelineOutput {
  result: AvatarResult;
  avatar: AvatarObject;
  /** The baked atlas, exposed for the viewer's texture inspector. */
  atlas: HTMLCanvasElement | null;
}

interface ViewData {
  photo: CapturedPhoto;
  raster: RasterImage;
  analysis: SilhouetteAnalysis;
}

/**
 * Cancellation checkpoint. The heavy stages are synchronous once entered, so the
 * only honest place to stop is a stage boundary — which is also the only place
 * the user's "Cancel" can take effect without leaving a half-built mesh around.
 */
function bail(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Reconstruction cancelled', 'AbortError');
}

/** Mesh density, scaled down on memory-constrained phones. */
function chooseVoxel(stature: number): number {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const cores = nav?.hardwareConcurrency ?? 4;
  const mem = (nav as unknown as { deviceMemory?: number })?.deviceMemory ?? 4;
  const modest = cores <= 4 || mem <= 4;
  return stature * (modest ? 0.0056 : 0.0042);
}

async function prepareView(
  photo: CapturedPhoto,
  report: StageReporter | undefined,
  share: number,
  base: number,
): Promise<ViewData> {
  const raster = await toRaster(photo.dataUrl);
  report?.('landmarks', base + share * 0.3);
  await nextFrame();
  const small = await toRaster(photo.dataUrl, ANALYSIS_MAX_EDGE);
  const seg = segmentPerson(small);
  report?.('landmarks', base + share * 0.75);
  await nextFrame();
  const analysis = analyzeSilhouette(seg.mask, photo.view, seg.score);
  report?.('landmarks', base + share);
  return { photo, raster, analysis };
}

async function askProvider(
  photos: CapturedPhoto[],
  profile: UserProfileInput,
  signal?: AbortSignal,
): Promise<ReconstructPlan> {
  try {
    const res = await fetch('/api/reconstruct', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        photos: photos.map((p) => ({ view: p.view, dataUrl: p.dataUrl })),
        heightCm: profile.heightCm ?? null,
      }),
      signal,
    });
    if (!res.ok) {
      return {
        mode: 'local',
        provider: null,
        note: `Reconstruction service returned ${res.status} — built on-device instead.`,
      };
    }
    return (await res.json()) as ReconstructPlan;
  } catch {
    return {
      mode: 'local',
      provider: null,
      note: 'Reconstruction service unreachable — built on-device instead.',
    };
  }
}

/**
 * Wrap an externally loaded scene as an AvatarObject. Provider and base meshes
 * carry their own materials, so nothing is baked; the exporter and the viewer
 * only need the root plus counts.
 */
function wrapLoaded(loaded: LoadedGltf, statureM: number): AvatarObject {
  const mesh = loaded.meshes[0];
  if (!mesh) throw new Error('The loaded scene contains no mesh');
  const raw = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  // `material` is only read for the telemetry/export surface; the mesh keeps
  // whatever the provider gave it, which may be a multi-material array.
  const material =
    raw instanceof THREE.MeshStandardMaterial ? raw : new THREE.MeshStandardMaterial();
  return {
    root: loaded.root,
    mesh,
    material,
    skeleton: null,
    texture: material.map,
    triangles: Math.round(loaded.triangles),
    vertices: loaded.vertices,
    height: statureM,
  };
}

/** Is an optional licensed base mesh available to retarget? */
async function findBaseMesh(): Promise<string | null> {
  const configured = process.env.NEXT_PUBLIC_BASE_MESH_URL;
  const candidates = [configured, '/models/base-human.glb'].filter(
    (u): u is string => !!u,
  );
  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && !type.includes('text/html')) return url;
    } catch {
      /* not present — fall through to the parametric body */
    }
  }
  return null;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const { photos, profile, report, signal } = input;
  const front = photos.find((p) => p.view === 'front') ?? photos[0];
  if (!front) throw new Error('At least one photo is required');
  const profileShot = photos.find((p) => p.view === 'profile') ?? null;

  // ── 1. landmarks ──────────────────────────────────────────────────────────
  report?.('landmarks', 0.02);
  const neuralPromise = input.allowNeural === false
    ? Promise.resolve<ReconstructPlan>({ mode: 'local', provider: null })
    : askProvider(photos, profile, signal);

  const frontView = await prepareView(front, report, profileShot ? 0.5 : 1, 0);
  const profileView = profileShot
    ? await prepareView(profileShot, report, 0.5, 0.5)
    : null;

  // ── 2. proportions ────────────────────────────────────────────────────────
  bail(signal);
  report?.('proportions', 0.15);
  await nextFrame();
  const estimate = estimateBody(
    frontView.analysis,
    profileView?.analysis ?? null,
    profile,
  );
  const fl = frontView.analysis.landmarks;
  const pxCm = estimate.frontPxPerCm || 1;
  const targets: FitTargets = {
    shoulderHalf: fl.shoulderBreadth / (pxCm * 200),
    chestHalf: fl.chestBreadth / (pxCm * 200),
    waistHalf: fl.waistBreadth / (pxCm * 200),
    hipHalf: fl.hipBreadth / (pxCm * 200),
    chestDepth: estimate.metrics.chestDepthCm / 100,
    waistDepth: estimate.metrics.waistDepthCm / 100,
    hipDepth: estimate.metrics.hipDepthCm / 100,
    thighWidth: fl.thighBreadth / (pxCm * 100),
    calfWidth: fl.calfBreadth / (pxCm * 100),
    trust: estimate.metrics.confidence,
  };
  report?.('proportions', 0.6);
  await nextFrame();

  // Iterate the parametric body against the measured silhouette. This runs on
  // both paths: even with a neural mesh we want honest telemetry.
  const fit = refineShape(estimate.shape, targets, 4);
  report?.('proportions', 1);
  await nextFrame();

  const plan = await neuralPromise;

  // ── 3. geometry ───────────────────────────────────────────────────────────
  bail(signal);
  report?.('geometry', 0.05, plan.note);

  let avatar: AvatarObject | null = null;
  let atlas: HTMLCanvasElement | null = null;
  let mode = plan.mode;
  let note = plan.note;
  let localPositions: Float32Array | null = null;
  let localIndices: Uint32Array | null = null;

  if (plan.mode === 'neural' && plan.modelUrl) {
    try {
      const loaded = await loadGltf(plan.modelUrl);
      normalizeToStature(loaded.root, fit.shape.stature);
      avatar = wrapLoaded(loaded, fit.shape.stature);
      report?.('geometry', 1);
      report?.('texture', 1, 'Provider mesh arrived with its own textures');
    } catch (err) {
      mode = 'local';
      note = `Provider mesh could not be loaded (${
        err instanceof Error ? err.message : 'unknown error'
      }) — built on-device instead.`;
      avatar = null;
    }
  }

  if (!avatar) {
    mode = 'local';
    const field = fit.field;
    const baseUrl = await findBaseMesh();

    if (baseUrl) {
      // Retarget a licensed base human instead of synthesising one.
      try {
        const loaded = await loadGltf(baseUrl);
        normalizeToStature(loaded.root, fit.shape.stature);
        deformBaseMesh(loaded.root, loaded.meshes, {
          target: trunkProfile(field, 48),
          limbGirth: (fit.shape.arm + fit.shape.thigh + fit.shape.calf) / 3,
        });
        avatar = wrapLoaded(loaded, fit.shape.stature);
        note = note ?? 'Retargeted the licensed base mesh in public/models.';
        report?.('geometry', 1);
        report?.('texture', 1, 'Kept the base mesh materials');
      } catch {
        avatar = null;
      }
    }

    if (!avatar) {
      const voxel = chooseVoxel(fit.shape.stature);
      const mesh = await polygonizeField(field.sdf, field.bounds, {
        voxel,
        smoothPasses: 2,
        onProgress: (t) => report?.('geometry', 0.05 + t * 0.95),
      });
      if (mesh.triangles === 0) throw new Error('Mesh generation produced no surface');
      localPositions = mesh.positions;
      localIndices = mesh.indices;
      await nextFrame();
      bail(signal);

      // ── 4. texture ──────────────────────────────────────────────────────
      report?.('texture', 0.1);
      const rigged = rigMesh(mesh, field.rig);
      await nextFrame();
      report?.('texture', 0.4);

      let bake: BakeResult | null = null;
      try {
        bake = bakeTexture({
          geometry: rigged,
          front: { raster: frontView.raster, analysis: frontView.analysis },
          profile: profileView
            ? { raster: profileView.raster, analysis: profileView.analysis }
            : null,
        });
        atlas = bake.canvas;
      } catch {
        // A texture failure must not cost the user their mesh.
        bake = null;
        note = note ?? 'Texture projection failed — showing the untextured body.';
      }
      report?.('texture', 1);
      await nextFrame();

      localPositions = rigged.positions;
      localIndices = rigged.indices;
      avatar = buildAvatarObject(rigged, bake);
    }
  }

  // ── 5. finalize ───────────────────────────────────────────────────────────
  bail(signal);
  report?.('finalize', 0.35);
  await nextFrame();

  const girths = measureField(fit.field);
  let frontIoU = 0;
  let profileIoU = 0;
  if (localPositions && localIndices) {
    const fs = scoreSilhouette(
      localPositions,
      localIndices,
      frontView.analysis,
      'x',
    );
    const ps = profileView
      ? scoreSilhouette(localPositions, localIndices, profileView.analysis, 'z')
      : null;
    frontIoU = fs.iou;
    profileIoU = ps?.iou ?? 0;
  } else {
    // Provider or base mesh: score the parametric fit that produced the
    // telemetry rather than claiming to have measured a mesh we did not build.
    frontIoU = clamp01(1 - fit.siteError);
    profileIoU = 0;
  }

  const accuracy =
    localPositions && localIndices
      ? combineAccuracy(
          { iou: frontIoU, recall: 0, precision: 0 },
          profileIoU > 0 ? { iou: profileIoU, recall: 0, precision: 0 } : null,
        )
      : frontIoU;

  const metrics: BodyMetrics = {
    ...estimate.metrics,
    chestCm: girths.chestCm || estimate.metrics.chestCm,
    waistCm: girths.waistCm || estimate.metrics.waistCm,
    hipCm: girths.hipCm || estimate.metrics.hipCm,
    neckCm: girths.neckCm || estimate.metrics.neckCm,
    thighCm: girths.thighCm || estimate.metrics.thighCm,
    upperArmCm: girths.upperArmCm || estimate.metrics.upperArmCm,
    shoulderWidthCm: girths.shoulderWidthCm || estimate.metrics.shoulderWidthCm,
    inseamCm: girths.inseamCm || estimate.metrics.inseamCm,
    armLengthCm: girths.armLengthCm || estimate.metrics.armLengthCm,
    silhouetteAccuracy: clamp(accuracy * 100, 0, 99.5),
    frontIoU,
    profileIoU,
  };

  report?.('finalize', 1);

  return {
    result: {
      mode,
      provider: plan.provider,
      metrics,
      shape: fit.shape,
      note,
      triangles: avatar.triangles,
      vertices: avatar.vertices,
    },
    avatar,
    atlas,
  };
}
