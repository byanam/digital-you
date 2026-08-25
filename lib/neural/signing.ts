import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signatures for the mesh proxy.
 *
 * A provider returns a mesh on its own CDN, usually with a signed URL and
 * without permissive CORS headers, so the browser cannot fetch it directly. The
 * app therefore streams it through /api/reconstruct/asset — and that endpoint
 * must not become an open proxy. Signing the URL means the only fetchable URLs
 * are ones this server produced moments earlier.
 *
 * The MAC key is derived from the provider API key (which, by definition, exists
 * whenever the proxy is reachable) so signatures stay valid across dev workers
 * and serverless instances without adding another required env var. Set
 * RECONSTRUCTION_PROXY_SECRET to decouple the two.
 */

const FALLBACK = randomBytes(32).toString('hex');

function macKey(): string {
  return (
    process.env.RECONSTRUCTION_PROXY_SECRET?.trim() ||
    process.env.RECONSTRUCTION_API_KEY?.trim() ||
    FALLBACK
  );
}

function mac(url: string, expiry: number): string {
  return createHmac('sha256', `digital-you/asset-proxy/${macKey()}`)
    .update(`${expiry}\n${url}`)
    .digest('base64url');
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Build the same-origin path that streams `url`. */
export function signAssetUrl(url: string, ttlMs = DEFAULT_TTL_MS): string {
  const expiry = Date.now() + ttlMs;
  const params = new URLSearchParams({
    u: url,
    e: String(expiry),
    s: mac(url, expiry),
  });
  return `/api/reconstruct/asset?${params.toString()}`;
}

/** Reject loopback and private-range literals as a second line of defence. */
function isPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return false;
  if (/^127\./.test(h) || /^10\./.test(h) || /^169\.254\./.test(h)) return false;
  if (/^192\.168\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h.startsWith('[') || h.includes(':')) return false; // bare IPv6 literal
  return true;
}

export interface VerifiedAsset {
  url: string;
}

/** Returns the URL when the signature is valid and unexpired, else null. */
export function verifyAssetUrl(params: URLSearchParams): VerifiedAsset | null {
  const url = params.get('u');
  const e = params.get('e');
  const s = params.get('s');
  if (!url || !e || !s) return null;

  const expiry = Number(e);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;

  const expected = Buffer.from(mac(url, expiry));
  const given = Buffer.from(s);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !isPublicHost(parsed.hostname)) return null;

  return { url };
}
