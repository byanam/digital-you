/**
 * Shared domain types for the Digital You reconstruction pipeline.
 *
 * Coordinate convention used everywhere in the 3D pipeline:
 *   • units are METRES
 *   • +Y is up, y = 0 is the sole of the foot, y = stature is the crown
 *   • +Z is the direction the avatar faces (towards the camera at rest)
 *   • +X is the avatar's OWN LEFT (so it appears on the right of a front photo)
 */

export type CaptureView = 'front' | 'profile';

export interface CapturedPhoto {
  view: CaptureView;
  /** JPEG data URL, already downscaled to <= 1024px and quality 0.85. */
  dataUrl: string;
  width: number;
  height: number;
  /** True when the source frame came from a mirrored (selfie) preview. */
  mirrored: boolean;
}

/** Optional self-reported details. Improves absolute scale accuracy a lot. */
export interface UserProfileInput {
  /** Stature in centimetres. Omitted → estimated from head-to-height ratio. */
  heightCm?: number;
  /** Only used to pick canonical anthropometric ratios as a starting point. */
  build?: 'a' | 'b' | 'neutral';
}

// ─────────────────────────────────────────────────────────────── silhouette ──

export interface BinaryMask {
  width: number;
  height: number;
  /** 1 = person, 0 = background. Row-major, length = width * height. */
  data: Uint8Array;
}

/** A contiguous horizontal run of foreground pixels on one scanline. */
export interface Run {
  x0: number;
  x1: number;
}

export interface RowStats {
  /** All foreground runs on this scanline, left to right. */
  runs: Run[];
  /** Width of the run that contains the body's central axis (px). 0 if none. */
  torsoWidth: number;
  /** Centre x of the central run (px). NaN if none. */
  torsoCenter: number;
  /** Total foreground pixels on this row. */
  total: number;
  /** Left/right extreme of all foreground on this row, or -1. */
  x0: number;
  x1: number;
}

export interface Landmarks2D {
  /** Image-space y of the crown and of the soles. */
  crownY: number;
  soleY: number;
  /** Vertical body extent in pixels. */
  pixelHeight: number;
  /** Central body axis, in image x. */
  axisX: number;
  /**
   * All of the below are image-space y values (top-down) for anatomical sites.
   */
  chinY: number;
  neckY: number;
  shoulderY: number;
  armpitY: number;
  chestY: number;
  waistY: number;
  hipY: number;
  crotchY: number;
  kneeY: number;
  ankleY: number;
  elbowY: number;
  wristY: number;
  /** Horizontal breadths in pixels at the sites above (torso only, arms excluded). */
  headBreadth: number;
  neckBreadth: number;
  shoulderBreadth: number;
  chestBreadth: number;
  waistBreadth: number;
  hipBreadth: number;
  thighBreadth: number;
  calfBreadth: number;
  upperArmBreadth: number;
  forearmBreadth: number;
  /** 0..1 — how much we trust this analysis. */
  confidence: number;
  /** Only meaningful for profile views: +1 = subject faces image +x, -1 = -x. */
  facing: 1 | -1;
}

export interface SilhouetteAnalysis {
  view: CaptureView;
  mask: BinaryMask;
  rows: RowStats[];
  landmarks: Landmarks2D;
}

// ───────────────────────────────────────────────────────────── measurements ──

export interface BodyMetrics {
  heightCm: number;
  /** Circumferences (cm). */
  chestCm: number;
  waistCm: number;
  hipCm: number;
  neckCm: number;
  thighCm: number;
  upperArmCm: number;
  /** Linear measures (cm). */
  shoulderWidthCm: number;
  inseamCm: number;
  armLengthCm: number;
  /** Sagittal depths (cm) — from the profile photo. */
  chestDepthCm: number;
  waistDepthCm: number;
  hipDepthCm: number;
  /** Silhouette IoU of the fitted mesh vs. the photo masks, 0..1. */
  silhouetteAccuracy: number;
  frontIoU: number;
  profileIoU: number;
  /** How the numbers were obtained. */
  scaleSource: 'user-height' | 'head-ratio-estimate';
  confidence: number;
}

// ───────────────────────────────────────────────────────────── shape params ──

/**
 * The parameter vector the mesh synthesiser consumes. Every field except
 * `stature` is a multiplier against the canonical anthropometric template,
 * so 1.0 == "textbook average adult of this height".
 */
export interface ShapeParams {
  /** Stature, metres. */
  stature: number;
  shoulder: number;
  chest: number;
  waist: number;
  hip: number;
  chestDepth: number;
  waistDepth: number;
  hipDepth: number;
  neck: number;
  head: number;
  arm: number;
  thigh: number;
  calf: number;
  /** Leg-length-to-stature modifier (affects crotch height). */
  legLength: number;
  /** 0..1, drives musculature relief amplitude. */
  muscle: number;
  /** 0..1, softens definition and thickens the midsection. */
  softness: number;
}

export const DEFAULT_SHAPE: ShapeParams = {
  stature: 1.72,
  shoulder: 1,
  chest: 1,
  waist: 1,
  hip: 1,
  chestDepth: 1,
  waistDepth: 1,
  hipDepth: 1,
  neck: 1,
  head: 1,
  arm: 1,
  thigh: 1,
  calf: 1,
  legLength: 1,
  muscle: 0.5,
  softness: 0.35,
};

// ──────────────────────────────────────────────────────────────── pipeline ──

export type PipelineStageId =
  | 'landmarks'
  | 'proportions'
  | 'geometry'
  | 'texture'
  | 'finalize';

export interface PipelineStage {
  id: PipelineStageId;
  label: string;
  detail: string;
}

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    id: 'landmarks',
    label: 'Analyzing 2D Anatomical Landmarks',
    detail: 'Segmenting the subject and tracing joint centres from the silhouette',
  },
  {
    id: 'proportions',
    label: 'Estimating 3D Biometric Proportions',
    detail: 'Fusing frontal breadths with sagittal depths into body circumferences',
  },
  {
    id: 'geometry',
    label: 'Synthesizing 3D Human Mesh Geometry',
    detail: 'Solving the parametric body model against your silhouette',
  },
  {
    id: 'texture',
    label: 'Projecting UV Photorealistic Textures',
    detail: 'Baking your photos into the avatar texture atlas',
  },
  {
    id: 'finalize',
    label: 'Finalizing 3D Rotatable Model',
    detail: 'Binding the skeleton and packing the mesh for export',
  },
];

export type ReconstructionMode = 'neural' | 'local';

export interface ReconstructPlan {
  mode: ReconstructionMode;
  provider: string | null;
  /** Same-origin proxy URL that streams the produced .glb, when mode = neural. */
  modelUrl?: string;
  /** Human-readable note surfaced in the UI (e.g. why we fell back). */
  note?: string;
}

export interface AvatarResult {
  mode: ReconstructionMode;
  provider: string | null;
  metrics: BodyMetrics;
  shape: ShapeParams;
  note?: string;
  /** Triangle count of the delivered mesh. */
  triangles: number;
  /** Vertex count of the delivered mesh. */
  vertices: number;
}
