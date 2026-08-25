# Digital You

Turn two phone photos — one front-on, one profile — into a realistic, rotatable
3D human avatar in the browser.

Everything works with **no API keys and no network**: the default path segments
the subject, measures the silhouette, solves a parametric anatomical body model
against those measurements, polygonises it into a smooth continuous mesh, rigs it
with a Mixamo-compatible humanoid skeleton, and projects your photos onto its UV
atlas. If you *do* supply a key for a neural reconstruction provider, stage 3
hands off to it instead and streams back a photogrammetric `.glb`.

---

## Run it

```bash
npm install && npm run dev
```

Then open <http://localhost:3000>. A camera needs a secure context, so on a phone
either use `localhost` via port forwarding, or serve over HTTPS — otherwise the
capture screen falls back to its file picker, which works everywhere.

```bash
npm run typecheck
```

```bash
npm run build && npm run start
```

---

## The two reconstruction paths

### 1. On-device (default, no configuration)

| Stage | What actually happens | Code |
| --- | --- | --- |
| 1. Landmarks | Colour/edge/graph-cut segmentation, then scanline-run analysis to find crown, shoulders, chest, waist, hip, crotch, knee and ankle, plus per-site breadths | [lib/vision/segment.ts](lib/vision/segment.ts), [lib/vision/landmarks.ts](lib/vision/landmarks.ts) |
| 2. Proportions | Frontal breadths fused with sagittal depths into circumferences; absolute scale from your height, or a head-to-height ratio | [lib/measurements.ts](lib/measurements.ts) |
| 3. Geometry | An SDF body — capsules, ellipsoids and musculature relief blended with a polynomial smooth-minimum — fitted by damped Gauss–Seidel to your measurements, then extracted with Surface Nets and Taubin-smoothed | [lib/body/anatomy.ts](lib/body/anatomy.ts), [lib/body/fit.ts](lib/body/fit.ts), [lib/body/polygonize.ts](lib/body/polygonize.ts) |
| 4. Texture | Per-region cylindrical UV charts, a UV-space g-buffer, cos³ visibility weighting, front-view priority, then weighted inpainting of everything the camera never saw | [lib/body/bake.ts](lib/body/bake.ts) |
| 5. Finalize | 25-bone humanoid skeleton with Gaussian skin weights, plus an orthographic silhouette IoU measured against the original masks | [lib/body/rigging.ts](lib/body/rigging.ts), [lib/body/accuracy.ts](lib/body/accuracy.ts) |

The mesh is one closed organic surface — no primitives, no seams, no boxes. The
smooth-minimum blend is what buys that: unions of limbs are C¹ continuous, so the
armpit and the crotch have real fillets rather than intersecting cylinders.

The reported accuracy is a **measurement, not a claim**: the finished mesh is
re-projected orthographically and compared to the photo masks with a
height-normalised, centroid-aligned IoU.

### 2. Neural provider (optional)

Copy `.env.local.example` to `.env.local` and set two variables:

```
RECONSTRUCTION_PROVIDER=tripo
RECONSTRUCTION_API_KEY=your-key-here
```

Supported providers: `tripo`, `meshy`, `replicate`, `rodin`. With a key present,
`POST /api/reconstruct` uploads both photos, polls the job, and returns a signed
same-origin URL for the resulting `.glb`.

Notes on the integration:

* **No key is ever hardcoded**, and nothing in `lib/neural/` is reachable without
  `RECONSTRUCTION_API_KEY` in the server environment.
* `/api/reconstruct` **always answers 200** with a plan object. A missing key, an
  outage, a timeout or a malformed reply all resolve to `{ mode: 'local' }` with a
  short note. There is no reason to show a user an error screen for something they
  can neither see nor fix when a complete on-device pipeline is sitting right there.
* Provider CDNs don't send CORS headers, so mesh URLs are HMAC-signed with a
  30-minute TTL and streamed through `/api/reconstruct/asset`. That route requires
  `https:` and refuses loopback and private address space, so it can't be used as
  an open proxy.
* Response parsing is deliberately forgiving — these vendors rename response
  fields between minor versions, so a tree-walker looks for the `.glb` anywhere in
  the payload. If a *request* schema changes, the call fails cleanly into the local
  pipeline instead of hanging.
* `GET /api/reconstruct` reports `{ configured, provider, timeoutSeconds }` — handy
  for checking that your key is being read without sending a photo.

### 3. Bring your own base mesh (optional)

Drop a licensed rigged humanoid at `public/models/base-human.glb` and the local
path will deform that instead of synthesising a body. See
[public/models/README.md](public/models/README.md).

---

## Flow

`/` → `/create`

1. **Height** — one optional field. It is the only number a photograph cannot
   recover on its own; skip it and the solver uses a head-to-height ratio.
2. **Front photo** — live camera with an anatomically proportioned alignment
   guide, crown and sole rails, framing and lighting guidance, a self-timer, and a
   file-upload fallback.
3. **Profile photo** — 90° side view. This is what gives the avatar sagittal depth
   instead of an extruded cut-out.
4. **Processing** — the five stages above, reported as they genuinely happen.
5. **Viewer** — 360° orbit, pinch zoom, pan; Front / Profile / Back / Head
   presets; wireframe toggle; biometric telemetry; `.glb` / `.obj` / `.png` export.

Photos are downscaled client-side to 1024 px at JPEG quality 0.85 before they go
anywhere, so payloads stay well inside request limits.

## Privacy

On the default path nothing leaves the device: segmentation, fitting,
polygonisation, rigging and texture baking all run in the browser, and there is no
account, no database and no upload. Photos are only transmitted when you have
configured a neural provider, and then only to that provider.

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind CSS · Three.js · Framer Motion ·
Lucide. No 3D asset dependencies: the studio environment is generated at runtime
by `RoomEnvironment`, and the body template is code.

## Coordinate convention

Metres throughout. **+Y** up with `y = 0` at the sole, **+Z** the facing
direction, **+X** the avatar's own left. Exports keep the bind pose, because the
mesh *is* the measurement.

## Caveats

Measurements are photogrammetric estimates — good for fit previews and avatar
proportions, not a substitute for a tailor's tape. Accuracy depends heavily on
framing: a cropped foot or a tilted phone costs more than any amount of model
tuning can recover, which is why the capture screen is as insistent as it is.
