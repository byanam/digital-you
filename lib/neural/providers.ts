/**
 * Server-side clients for the image → 3D providers named in the brief.
 *
 * All four are polling APIs with the same shape: submit the photos, receive a
 * task id, poll until a mesh URL appears. The differences are in field names,
 * so each client is thin and the shared machinery (deadline-aware polling,
 * tolerant response parsing) lives here.
 *
 * A note on durability: these vendors revise their REST surfaces regularly. The
 * request bodies below match each vendor's documented image-to-3D endpoint, and
 * the *response* side is deliberately forgiving — `findModelUrl` walks the whole
 * JSON tree looking for a .glb, so a renamed output field does not break the
 * integration. If a vendor changes a required *request* field the call will fail
 * cleanly and the app falls back to the on-device pipeline rather than hanging.
 *
 * Nothing here is reachable without RECONSTRUCTION_API_KEY in the environment.
 * There are no keys in this file.
 */

export type ProviderName = 'tripo' | 'meshy' | 'replicate' | 'rodin';

const PROVIDER_NAMES: ProviderName[] = ['tripo', 'meshy', 'replicate', 'rodin'];

export interface ProviderConfig {
  name: ProviderName;
  key: string;
  /** Whole-job deadline in milliseconds. */
  timeoutMs: number;
  /** Replicate model version hash, or a vendor model id. */
  modelVersion?: string;
  /** Replicate input key for the image (models disagree: image / input_image). */
  inputKey: string;
}

export interface ProviderPhoto {
  view: 'front' | 'profile';
  mime: string;
  bytes: Uint8Array;
  /** The original data URL, for APIs that accept inline images. */
  dataUrl: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retriable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Read the provider configuration from the environment. Null = local only. */
export function readConfig(): ProviderConfig | null {
  const key = process.env.RECONSTRUCTION_API_KEY?.trim();
  if (!key) return null;

  const raw = (process.env.RECONSTRUCTION_PROVIDER ?? 'tripo').trim().toLowerCase();
  const name = PROVIDER_NAMES.includes(raw as ProviderName)
    ? (raw as ProviderName)
    : 'tripo';

  const secs = Number(process.env.RECONSTRUCTION_TIMEOUT_SECONDS ?? '90');
  const timeoutMs = Math.round(
    Math.min(600, Math.max(15, Number.isFinite(secs) ? secs : 90)) * 1000,
  );

  return {
    name,
    key,
    timeoutMs,
    modelVersion: process.env.RECONSTRUCTION_MODEL_VERSION?.trim() || undefined,
    inputKey: process.env.RECONSTRUCTION_INPUT_KEY?.trim() || 'image',
  };
}

// ─────────────────────────────────────────────────────────────────── helpers ──

const MODEL_KEYS = [
  'pbr_model',
  'model',
  'model_url',
  'modelUrl',
  'glb',
  'glb_url',
  'mesh_url',
  'url',
  'file_url',
  'download_url',
];

function looksLikeMesh(s: string): boolean {
  if (!/^https?:\/\//i.test(s)) return false;
  const path = s.split('?')[0].split('#')[0].toLowerCase();
  return path.endsWith('.glb') || path.endsWith('.gltf');
}

/**
 * Find a mesh URL anywhere in a response. Preferred keys are checked first at
 * each level so `pbr_model` beats a thumbnail that happens to sort earlier.
 */
export function findModelUrl(node: unknown, depth = 0): string | null {
  if (depth > 8 || node == null) return null;
  if (typeof node === 'string') return looksLikeMesh(node) ? node : null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findModelUrl(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  const obj = node as Record<string, unknown>;
  for (const key of MODEL_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && looksLikeMesh(v)) return v;
  }
  // A GLB is sometimes announced by a sibling format field rather than the
  // extension, e.g. { format: 'glb', url: 'https://…/download?id=…' }.
  const format = typeof obj.format === 'string' ? obj.format.toLowerCase() : '';
  if (format === 'glb' || format === 'gltf') {
    for (const key of ['url', 'file_url', 'download_url', 'link']) {
      const v = obj[key];
      if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
    }
  }
  for (const v of Object.values(obj)) {
    const hit = findModelUrl(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  deadline: number;
}

async function request(url: string, opts: FetchOpts): Promise<Response> {
  const remaining = opts.deadline - Date.now();
  if (remaining <= 0) throw new ProviderError('Reconstruction deadline exceeded');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(remaining, 45_000));
  try {
    return await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    throw new ProviderError(
      `Request to ${new URL(url).host} failed: ${
        err instanceof Error ? err.message : 'network error'
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function json(url: string, opts: FetchOpts): Promise<Record<string, unknown>> {
  const res = await request(url, opts);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const detail =
      (parsed &&
        typeof parsed === 'object' &&
        ((parsed as Record<string, unknown>).message ??
          (parsed as Record<string, unknown>).error ??
          (parsed as Record<string, unknown>).detail)) ||
      text.slice(0, 200);
    throw new ProviderError(
      `${new URL(url).host} returned ${res.status}: ${String(detail)}`,
      res.status >= 500,
    );
  }
  return (parsed as Record<string, unknown>) ?? {};
}

type PollStep = () => Promise<string | null>;

/** Poll until a step returns a URL or the deadline passes. */
async function pollUntil(step: PollStep, deadline: number): Promise<string> {
  let wait = 1500;
  for (;;) {
    const hit = await step();
    if (hit) return hit;
    if (Date.now() + wait >= deadline) {
      throw new ProviderError('Reconstruction timed out while the mesh was queued');
    }
    await new Promise((r) => setTimeout(r, wait));
    // Back off gently: these jobs run 20–120 s, so hammering helps nobody.
    wait = Math.min(5000, Math.round(wait * 1.35));
  }
}

function statusOf(node: Record<string, unknown>): string {
  for (const key of ['status', 'state', 'task_status']) {
    const v = node[key];
    if (typeof v === 'string') return v.toLowerCase();
  }
  return '';
}

const FAILED = ['failed', 'failure', 'error', 'cancelled', 'canceled', 'banned', 'expired'];

function assertNotFailed(status: string, provider: string) {
  if (FAILED.some((f) => status.includes(f))) {
    throw new ProviderError(`${provider} reported the job as "${status}"`);
  }
}

function blobOf(photo: ProviderPhoto): Blob {
  // Copy into a fresh ArrayBuffer so the Blob never aliases a pooled Node buffer.
  const copy = new Uint8Array(photo.bytes.byteLength);
  copy.set(photo.bytes);
  return new Blob([copy], { type: photo.mime });
}

function extOf(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
}

// ───────────────────────────────────────────────────────────────────── tripo ──

async function tripoUpload(
  cfg: ProviderConfig,
  photo: ProviderPhoto,
  deadline: number,
): Promise<string> {
  const form = new FormData();
  form.append('file', blobOf(photo), `${photo.view}.${extOf(photo.mime)}`);
  const res = await json('https://api.tripo3d.ai/v2/openapi/upload', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.key}` },
    body: form,
    deadline,
  });
  const data = (res.data ?? {}) as Record<string, unknown>;
  const token = data.image_token ?? data.file_token ?? data.token;
  if (typeof token !== 'string') {
    throw new ProviderError('Tripo did not return an image token');
  }
  return token;
}

async function tripo(
  cfg: ProviderConfig,
  photos: ProviderPhoto[],
  deadline: number,
): Promise<string> {
  const front = photos.find((p) => p.view === 'front') ?? photos[0];
  const side = photos.find((p) => p.view === 'profile') ?? null;

  const frontToken = await tripoUpload(cfg, front, deadline);
  const sideToken = side ? await tripoUpload(cfg, side, deadline) : null;
  const type = extOf(front.mime);

  // Tripo's multiview slots are [front, left, back, right]; an empty object
  // means "not supplied". A profile shot goes in the left slot.
  const body: Record<string, unknown> = sideToken
    ? {
        type: 'multiview_to_model',
        files: [
          { type, file_token: frontToken },
          { type: extOf(side!.mime), file_token: sideToken },
          {},
          {},
        ],
      }
    : { type: 'image_to_model', file: { type, file_token: frontToken } };
  body.texture = true;
  body.pbr = true;
  if (cfg.modelVersion) body.model_version = cfg.modelVersion;

  const created = await json('https://api.tripo3d.ai/v2/openapi/task', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    deadline,
  });
  const taskId = ((created.data ?? {}) as Record<string, unknown>).task_id;
  if (typeof taskId !== 'string') {
    throw new ProviderError('Tripo did not return a task id');
  }

  return pollUntil(async () => {
    const res = await json(
      `https://api.tripo3d.ai/v2/openapi/task/${encodeURIComponent(taskId)}`,
      { headers: { authorization: `Bearer ${cfg.key}` }, deadline },
    );
    const data = (res.data ?? {}) as Record<string, unknown>;
    assertNotFailed(statusOf(data), 'Tripo');
    return findModelUrl(data.output ?? data);
  }, deadline);
}

// ───────────────────────────────────────────────────────────────────── meshy ──

async function meshy(
  cfg: ProviderConfig,
  photos: ProviderPhoto[],
  deadline: number,
): Promise<string> {
  const front = photos.find((p) => p.view === 'front') ?? photos[0];
  const side = photos.find((p) => p.view === 'profile') ?? null;
  const endpoint = 'https://api.meshy.ai/openapi/v1/image-to-3d';
  const headers = {
    authorization: `Bearer ${cfg.key}`,
    'content-type': 'application/json',
  };
  const common = {
    ai_model: cfg.modelVersion ?? 'meshy-5',
    should_texture: true,
    enable_pbr: true,
    should_remesh: true,
    topology: 'triangle',
  };

  let taskId: string | null = null;
  if (side) {
    // Multi-image gives Meshy the sagittal depth cue. Older accounts only have
    // the single-image endpoint, which rejects `image_urls` with a 4xx.
    try {
      const res = await json(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...common,
          image_urls: [front.dataUrl, side.dataUrl],
        }),
        deadline,
      });
      const id = res.result ?? res.id ?? res.task_id;
      if (typeof id === 'string') taskId = id;
    } catch (err) {
      if (err instanceof ProviderError && err.retriable) throw err;
    }
  }
  if (!taskId) {
    const res = await json(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...common, image_url: front.dataUrl }),
      deadline,
    });
    const id = res.result ?? res.id ?? res.task_id;
    if (typeof id !== 'string') {
      throw new ProviderError('Meshy did not return a task id');
    }
    taskId = id;
  }

  const id = taskId;
  return pollUntil(async () => {
    const res = await json(`${endpoint}/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${cfg.key}` },
      deadline,
    });
    assertNotFailed(statusOf(res), 'Meshy');
    return findModelUrl(res.model_urls ?? res);
  }, deadline);
}

// ───────────────────────────────────────────────────────────────── replicate ──

async function replicate(
  cfg: ProviderConfig,
  photos: ProviderPhoto[],
  deadline: number,
): Promise<string> {
  if (!cfg.modelVersion) {
    throw new ProviderError(
      'RECONSTRUCTION_MODEL_VERSION is required for the replicate provider ' +
        '(the version hash of e.g. an ECON or HMR 2.0 model)',
    );
  }
  const front = photos.find((p) => p.view === 'front') ?? photos[0];
  const side = photos.find((p) => p.view === 'profile') ?? null;

  const input: Record<string, unknown> = { [cfg.inputKey]: front.dataUrl };
  // Human reconstruction models that accept a second view use one of these.
  if (side) {
    input.side_image = side.dataUrl;
    input.back_image = null;
  }

  const created = await json('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.key}`,
      'content-type': 'application/json',
      // Replicate holds the request open briefly, which often skips polling.
      prefer: 'wait=55',
    },
    body: JSON.stringify({ version: cfg.modelVersion, input }),
    deadline,
  });

  const early = findModelUrl(created.output);
  if (early) return early;
  assertNotFailed(statusOf(created), 'Replicate');

  const urls = (created.urls ?? {}) as Record<string, unknown>;
  const getUrl =
    typeof urls.get === 'string'
      ? urls.get
      : typeof created.id === 'string'
        ? `https://api.replicate.com/v1/predictions/${created.id}`
        : null;
  if (!getUrl) throw new ProviderError('Replicate did not return a prediction URL');

  return pollUntil(async () => {
    const res = await json(getUrl, {
      headers: { authorization: `Bearer ${cfg.key}` },
      deadline,
    });
    const status = statusOf(res);
    if (status === 'failed' || status === 'canceled') {
      const detail = typeof res.error === 'string' ? res.error : status;
      throw new ProviderError(`Replicate prediction ${status}: ${detail}`);
    }
    return findModelUrl(res.output);
  }, deadline);
}

// ───────────────────────────────────────────────────────────────────── rodin ──

async function rodin(
  cfg: ProviderConfig,
  photos: ProviderPhoto[],
  deadline: number,
): Promise<string> {
  const form = new FormData();
  for (const p of photos) {
    form.append('images', blobOf(p), `${p.view}.${extOf(p.mime)}`);
  }
  form.append('tier', 'Regular');
  form.append('geometry_file_format', 'glb');
  form.append('material', 'PBR');
  form.append('quality', 'medium');
  form.append('use_hyper', 'true');
  if (photos.length > 1) form.append('condition_mode', 'fuse');

  const created = await json('https://hyperhuman.deemos.com/api/v2/rodin', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.key}` },
    body: form,
    deadline,
  });
  const uuid = created.uuid ?? created.task_uuid;
  const jobs = (created.jobs ?? {}) as Record<string, unknown>;
  const subscription = jobs.subscription_key;
  if (typeof uuid !== 'string' || typeof subscription !== 'string') {
    throw new ProviderError('Rodin did not return a task handle');
  }

  const headers = {
    authorization: `Bearer ${cfg.key}`,
    'content-type': 'application/json',
  };

  // Rodin separates "is it done" from "where is it", so poll status then fetch
  // the download manifest once.
  await pollUntil(async () => {
    const res = await json('https://hyperhuman.deemos.com/api/v2/status', {
      method: 'POST',
      headers,
      body: JSON.stringify({ subscription_key: subscription }),
      deadline,
    });
    const list = Array.isArray(res.jobs) ? (res.jobs as Record<string, unknown>[]) : [];
    if (list.length === 0) return null;
    const states = list.map((j) => statusOf(j));
    for (const s of states) assertNotFailed(s, 'Rodin');
    return states.every((s) => s === 'done' || s === 'succeeded') ? 'done' : null;
  }, deadline);

  const manifest = await json('https://hyperhuman.deemos.com/api/v2/download', {
    method: 'POST',
    headers,
    body: JSON.stringify({ task_uuid: uuid }),
    deadline,
  });
  const url = findModelUrl(manifest.list ?? manifest);
  if (!url) throw new ProviderError('Rodin finished but produced no .glb');
  return url;
}

// ──────────────────────────────────────────────────────────────────── facade ──

export interface ReconstructOutcome {
  provider: ProviderName;
  /** Provider-hosted mesh URL. Proxy it; do not hand it to the browser. */
  meshUrl: string;
  elapsedMs: number;
}

export async function reconstruct(
  cfg: ProviderConfig,
  photos: ProviderPhoto[],
): Promise<ReconstructOutcome> {
  if (photos.length === 0) throw new ProviderError('No photos supplied');
  const started = Date.now();
  const deadline = started + cfg.timeoutMs;

  const run =
    cfg.name === 'meshy'
      ? meshy
      : cfg.name === 'replicate'
        ? replicate
        : cfg.name === 'rodin'
          ? rodin
          : tripo;

  const meshUrl = await run(cfg, photos, deadline);
  return { provider: cfg.name, meshUrl, elapsedMs: Date.now() - started };
}
