import { verifyAssetUrl } from '@/lib/neural/signing';

/**
 * GET /api/reconstruct/asset?u=…&e=…&s=…
 *
 * Streams a provider-hosted .glb through this origin. Provider CDNs rarely send
 * permissive CORS headers, so GLTFLoader cannot fetch them directly; and an
 * unauthenticated proxy that takes an arbitrary `u` would be an SSRF hole. The
 * signature issued by /api/reconstruct closes both problems: only URLs this
 * server minted, within their TTL, are fetchable.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 128 * 1024 * 1024;

export async function GET(request: Request) {
  const verified = verifyAssetUrl(new URL(request.url).searchParams);
  if (!verified) {
    return new Response('Invalid or expired asset signature', { status: 403 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(verified.url, {
      cache: 'no-store',
      redirect: 'follow',
      headers: { accept: 'model/gltf-binary,model/gltf+json,*/*' },
    });
  } catch {
    return new Response('Upstream mesh is unreachable', { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(`Upstream returned ${upstream.status}`, { status: 502 });
  }

  const length = Number(upstream.headers.get('content-length') ?? '0');
  if (length > MAX_BYTES) {
    return new Response('Upstream mesh is too large', { status: 502 });
  }

  const type = upstream.headers.get('content-type') ?? '';
  const isGltfJson = type.includes('gltf+json') || verified.url.includes('.gltf');
  const headers = new Headers({
    'content-type': isGltfJson ? 'model/gltf+json' : 'model/gltf-binary',
    // Private: the URL is user-specific and short-lived.
    'cache-control': 'private, max-age=300',
    'content-disposition': 'inline; filename="digital-you.glb"',
    'x-content-type-options': 'nosniff',
  });
  if (length > 0) headers.set('content-length', String(length));

  return new Response(upstream.body, { status: 200, headers });
}
