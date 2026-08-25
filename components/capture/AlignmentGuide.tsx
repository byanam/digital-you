'use client';

/**
 * The alignment overlay drawn on top of the camera preview.
 *
 * Framing is the single largest error source in the whole pipeline: the
 * silhouette solver recovers absolute scale from crown-to-sole pixel height, so
 * a cropped foot or a tilted phone costs more accuracy than any amount of model
 * tuning can recover. The guide is therefore drawn from the same canonical
 * proportions the body model uses, rather than as a generic oval.
 *
 * Both outlines are generated from half-width samples and smoothed with a
 * Catmull-Rom spline, so the shape reads as a person instead of a wireframe box.
 */

type Pt = [number, number];

/** Catmull-Rom through every point, emitted as a closed cubic Bézier path. */
function closedSpline(pts: Pt[]): string {
  const n = pts.length;
  if (n < 3) return '';
  const at = (i: number) => pts[((i % n) + n) % n];
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d +=
      ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}` +
      ` ${c2x.toFixed(2)} ${c2y.toFixed(2)}` +
      ` ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return `${d} Z`;
}

const AXIS = 50;

/**
 * Front view: [y, halfWidth]. Single-valued in y because a standing figure with
 * arms at the sides is widest at the arm at every height — including the notch
 * below the wrist where the thigh takes over.
 */
const FRONT_OUTER: Pt[] = [
  [8, 0.6],
  [10, 3.6],
  [13.5, 5.9],
  [18, 6.7],
  [23, 6.4],
  [27, 5.3],
  [30, 4.3],
  [32.5, 3.9],
  [34.5, 4.3],
  [36.5, 9.2],
  [38.5, 14.4],
  [41, 17.4],
  [45, 18.5],
  [51, 18.9],
  [57, 18.5],
  [65, 17.9],
  [73, 17.3],
  [81, 16.8],
  [89, 16.4],
  [96, 16.1],
  [101, 15.2],
  [105, 13.2],
  [107.5, 10.9],
  [109, 10.6],
  [114, 10.3],
  [122, 9.6],
  [131, 8.5],
  [137, 7.4],
  [145, 7.0],
  [152, 7.7],
  [161, 7.1],
  [171, 5.5],
  [179, 4.4],
  [185, 4.7],
  [189, 5.5],
  [191, 5.7],
];

/** Front view: the inner edge of the right leg, traced back up to the crotch. */
const FRONT_INNER: Pt[] = [
  [191, 3.2],
  [180, 3.0],
  [165, 2.9],
  [148, 2.7],
  [133, 2.4],
  [120, 1.9],
  [110, 0.9],
];

function frontPath(): string {
  const half: Pt[] = [...FRONT_OUTER, ...FRONT_INNER];
  const right: Pt[] = half.map(([y, w]) => [AXIS + w, y]);
  const left: Pt[] = [...half].reverse().map(([y, w]) => [AXIS - w, y]);
  return closedSpline([...right, ...left]);
}

/** Profile view: [y, frontOffset, backOffset]. Subject faces frame-right. */
const PROFILE: Array<[number, number, number]> = [
  [8, 1.8, -1.8],
  [12, 5.0, -5.4],
  [18, 6.6, -7.0],
  [24, 6.3, -7.2],
  [28, 4.7, -6.8],
  [32, 2.7, -5.2],
  [36, 3.7, -6.4],
  [44, 7.6, -8.2],
  [54, 8.5, -8.7],
  [68, 7.4, -8.0],
  [78, 6.6, -7.8],
  [90, 7.4, -9.6],
  [100, 7.6, -9.0],
  [112, 7.0, -7.6],
  [126, 6.0, -6.6],
  [134, 5.2, -5.6],
  [146, 4.6, -6.2],
  [160, 3.8, -5.4],
  [176, 3.0, -3.8],
  [186, 4.2, -4.2],
  [191, 8.2, -4.6],
];

function profilePath(): string {
  const front: Pt[] = PROFILE.map(([y, f]) => [AXIS + f, y]);
  const back: Pt[] = [...PROFILE].reverse().map(([y, , b]) => [AXIS + b, y]);
  return closedSpline([...front, ...back]);
}

const PATHS = { front: frontPath(), profile: profilePath() };

export interface AlignmentGuideProps {
  view: 'front' | 'profile';
  /** Dim the guide once a frame is captured. */
  muted?: boolean;
  className?: string;
}

export function AlignmentGuide({ view, muted, className = '' }: AlignmentGuideProps) {
  const d = PATHS[view];
  return (
    <svg
      viewBox="0 0 100 200"
      preserveAspectRatio="xMidYMid meet"
      className={`pointer-events-none absolute inset-0 h-full w-full transition-opacity duration-300 ${
        muted ? 'opacity-25' : 'opacity-100'
      } ${className}`}
      aria-hidden
    >
      <defs>
        <linearGradient id="guide-stroke" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8AB4FF" stopOpacity="0.95" />
          <stop offset="55%" stopColor="#8AB4FF" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#FFB68A" stopOpacity="0.6" />
        </linearGradient>
        <filter id="guide-glow" x="-30%" y="-10%" width="160%" height="120%">
          <feGaussianBlur stdDeviation="1.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Crown and sole rails — the two lines that set absolute scale. */}
      <g stroke="#8AB4FF" strokeOpacity="0.3" strokeWidth="0.35">
        <line x1="6" y1="8" x2="94" y2="8" strokeDasharray="2 3" />
        <line x1="6" y1="191" x2="94" y2="191" strokeDasharray="2 3" />
      </g>
      <line
        x1={AXIS}
        y1="6"
        x2={AXIS}
        y2="194"
        stroke="#8AB4FF"
        strokeOpacity="0.16"
        strokeWidth="0.3"
        strokeDasharray="1.5 4"
      />

      <path
        d={d}
        fill="rgba(138,180,255,0.05)"
        stroke="url(#guide-stroke)"
        strokeWidth="0.9"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        filter="url(#guide-glow)"
      />

      {/* Corner brackets: a familiar "stand here" affordance. */}
      <g stroke="#F4F4F5" strokeOpacity="0.55" strokeWidth="0.9" fill="none">
        <path d="M 8 16 L 8 8 L 18 8" />
        <path d="M 92 16 L 92 8 L 82 8" />
        <path d="M 8 183 L 8 191 L 18 191" />
        <path d="M 92 183 L 92 191 L 82 191" />
      </g>

      {view === 'profile' && (
        // A small chevron confirming which way to turn.
        <g
          stroke="#FFB68A"
          strokeOpacity="0.75"
          strokeWidth="0.9"
          fill="none"
          strokeLinecap="round"
        >
          <path d="M 66 100 L 71 104 L 66 108" />
          <line x1="59" y1="104" x2="70" y2="104" strokeDasharray="1.5 2" />
        </g>
      )}
    </svg>
  );
}
