import { NextResponse } from 'next/server';
import {
  ProviderError,
  readConfig,
  reconstruct,
  type ProviderPhoto,
} from '@/lib/neural/providers';
import { signAssetUrl } from '@/lib/neural/signing';
import type { ReconstructPlan } from '@/lib/types';

/**
 * POST /api/reconstruct
 *
 * Paradigm 1 — the neural path. Given the captured photos, ask the configured
 * provider for a photorealistic textured mesh and reply with a same-origin URL
 * the viewer can load.
 *
 * This endpoint always answers 200 with a ReconstructPlan. A missing key, a
 * provider outage, a timeout and a malformed reply all resolve to
 * `{ mode: 'local' }` with a human-readable note, because the app has a complete
 * on-device pipeline and there is no reason to show the user an error screen for
 * something they can neither see nor fix.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Long jobs: Vercel and similar hosts cap this per plan. */
export const maxDuration = 300;

const MAX_PHOTOS = 4;
const MAX_BYTES = 6 * 1024 * 1024;

interface IncomingPhoto {
  view?: unknown;
  dataUrl?: unknown;
}

function decodePhoto(raw: IncomingPhoto): ProviderPhoto | null {
  if (typeof raw?.dataUrl !== 'string') return null;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    raw.dataUrl,
  );
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;
  return {
    view: raw.view === 'profile' ? 'profile' : 'front',
    mime,
    bytes: new Uint8Array(bytes),
    dataUrl: raw.dataUrl,
  };
}

function plan(body: ReconstructPlan) {
  return NextResponse.json(body, {
    headers: { 'cache-control': 'no-store' },
  });
}

export async function POST(request: Request) {
  let payload: { photos?: unknown };
  try {
    payload = (await request.json()) as { photos?: unknown };
  } catch {
    return plan({
      mode: 'local',
      provider: null,
      note: 'Malformed request — reconstructing on-device.',
    });
  }

  const incoming = Array.isArray(payload.photos)
    ? (payload.photos as IncomingPhoto[]).slice(0, MAX_PHOTOS)
    : [];
  const photos = incoming
    .map(decodePhoto)
    .filter((p): p is ProviderPhoto => p !== null);

  if (photos.length === 0) {
    return plan({
      mode: 'local',
      provider: null,
      note: 'No usable photos in the request — reconstructing on-device.',
    });
  }

  const cfg = readConfig();
  if (!cfg) {
    // The documented default: no key, no external call, full local pipeline.
    return plan({
      mode: 'local',
      provider: null,
      note: 'No RECONSTRUCTION_API_KEY configured — using the on-device parametric pipeline.',
    });
  }

  try {
    const outcome = await reconstruct(cfg, photos);
    return plan({
      mode: 'neural',
      provider: outcome.provider,
      modelUrl: signAssetUrl(outcome.meshUrl),
      note: `Reconstructed by ${outcome.provider} in ${(outcome.elapsedMs / 1000).toFixed(1)}s.`,
    });
  } catch (err) {
    const reason =
      err instanceof ProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'unknown error';
    // Log server-side; the client only needs to know it fell back.
    console.warn(`[reconstruct] ${cfg.name} failed: ${reason}`);
    return plan({
      mode: 'local',
      provider: cfg.name,
      note: `${cfg.name} could not deliver a mesh (${reason}) — reconstructed on-device instead.`,
    });
  }
}

export async function GET() {
  const cfg = readConfig();
  return NextResponse.json(
    {
      configured: cfg !== null,
      provider: cfg?.name ?? null,
      timeoutSeconds: cfg ? cfg.timeoutMs / 1000 : null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
