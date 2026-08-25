'use client';

/**
 * One capture step: live preview, alignment guide, self-timer, upload fallback.
 *
 * The upload fallback is not a consolation prize — on a phone it is often the
 * better path, because a photo taken by someone else from 6 ft away beats a
 * propped-up self-timer shot. Both routes end in the same `encodeCapture`
 * downscale to 1024 px / q0.85, so payloads stay well inside request limits.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Lightbulb,
  Ruler,
  Shirt,
  SwitchCamera,
  Timer,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { AlignmentGuide } from './AlignmentGuide';
import { useCamera } from '@/hooks/useCamera';
import { encodeCapture, encodeFile } from '@/lib/imaging';
import type { CapturedPhoto, CaptureView } from '@/lib/types';

const COPY: Record<
  CaptureView,
  { step: string; title: string; body: string; tips: Array<[LucideIcon, string]> }
> = {
  front: {
    step: 'Step 1 of 2',
    title: 'Face the camera',
    body: 'Stand straight, arms slightly away from your sides, feet a few inches apart. Fill the guide from crown to feet.',
    tips: [
      [Ruler, 'Place the camera 5–7 ft (1.5–2 m) away at hip height'],
      [Lightbulb, 'Even, front-on light — avoid a window directly behind you'],
      [Shirt, 'Fitted clothing and a plain wall give the cleanest silhouette'],
    ],
  },
  profile: {
    step: 'Step 2 of 2',
    title: 'Turn 90° to the side',
    body: 'Same spot, same distance — just rotate a quarter turn. This side view is what gives your avatar real depth instead of a flat cut-out.',
    tips: [
      [Ruler, 'Do not move the camera between the two shots'],
      [Lightbulb, 'Keep both arms hanging naturally, not folded'],
      [Shirt, 'Look straight ahead so the head silhouette stays clean'],
    ],
  },
};

const TIMERS = [0, 3, 10] as const;

export interface CaptureStepProps {
  view: CaptureView;
  onCapture: (photo: CapturedPhoto) => void;
  onBack?: () => void;
}

export function CaptureStep({ view, onCapture, onBack }: CaptureStepProps) {
  const copy = COPY[view];
  const cam = useCamera('environment');
  const fileRef = useRef<HTMLInputElement>(null);
  const tickRef = useRef<number | null>(null);

  const [preview, setPreview] = useState<CapturedPhoto | null>(null);
  const [timer, setTimer] = useState<(typeof TIMERS)[number]>(0);
  const [countdown, setCountdown] = useState(0);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // A fresh step means a fresh frame.
  useEffect(() => {
    setPreview(null);
    setCountdown(0);
    setFileError(null);
  }, [view]);

  const clearTick = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  useEffect(() => clearTick, [clearTick]);

  const grabFrame = useCallback(() => {
    const video = cam.videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const photo = encodeCapture(video, view, {
      mirrored: cam.mirrored,
      unmirror: cam.mirrored,
    });
    setFlash(true);
    window.setTimeout(() => setFlash(false), 180);
    setPreview(photo);
  }, [cam.mirrored, cam.videoRef, view]);

  const shoot = useCallback(() => {
    if (timer === 0) {
      grabFrame();
      return;
    }
    clearTick();
    setCountdown(timer);
    tickRef.current = window.setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearTick();
          grabFrame();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }, [clearTick, grabFrame, timer]);

  const pickFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setFileError(null);
      setBusy(true);
      try {
        setPreview(await encodeFile(file, view));
      } catch {
        setFileError('That file could not be read. Try a JPEG or PNG.');
      } finally {
        setBusy(false);
      }
    },
    [view],
  );

  const cameraBroken =
    cam.status === 'denied' || cam.status === 'unavailable' || cam.status === 'error';

  return (
    <div className="flex min-h-dvh flex-col bg-ink-950">
      <header className="safe-t flex items-center justify-between px-5 pb-3 pt-4">
        <button
          type="button"
          onClick={onBack}
          disabled={!onBack}
          className="-ml-2 flex h-9 items-center gap-1 rounded-xl px-2 text-[14px] text-ink-300 transition-colors hover:text-ink-100 disabled:opacity-0"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={2} />
          Back
        </button>
        <span className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-ink-500">
          {copy.step}
        </span>
        <div className="flex items-center gap-1.5">
          {(['front', 'profile'] as CaptureView[]).map((v) => (
            <span
              key={v}
              className={`h-1 rounded-full transition-all duration-300 ${
                v === view ? 'w-5 bg-accent-glow' : 'w-2.5 bg-ink-700'
              }`}
            />
          ))}
        </div>
      </header>

      <div className="px-5 pb-4">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink-100">
          {copy.title}
        </h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-400">{copy.body}</p>
      </div>

      {/* ── viewport ─────────────────────────────────────────────────────── */}
      <div className="relative mx-5 flex-1 overflow-hidden rounded-[28px] border border-white/10 bg-ink-900">
        <video
          ref={cam.videoRef}
          playsInline
          muted
          autoPlay
          className={`h-full w-full object-cover transition-opacity duration-300 ${
            preview ? 'opacity-0' : cam.status === 'live' ? 'opacity-100' : 'opacity-0'
          } ${cam.mirrored ? '-scale-x-100' : ''}`}
        />

        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview.dataUrl}
            alt={`Captured ${view} view`}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}

        <AlignmentGuide view={view} muted={!!preview} />

        {/* Camera unavailable / starting states */}
        {!preview && cam.status !== 'live' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
            {cameraBroken ? (
              <>
                <AlertTriangle
                  className="h-6 w-6 text-accent-warm"
                  strokeWidth={1.7}
                />
                <p className="text-[13.5px] leading-relaxed text-ink-300">
                  {cam.error}
                </p>
                <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
                  <Upload className="h-4 w-4" strokeWidth={1.8} />
                  Choose a photo
                </Button>
              </>
            ) : (
              <p className="animate-shimmer shimmer-text text-[13.5px]">
                Starting camera…
              </p>
            )}
          </div>
        )}

        {/* Countdown */}
        <AnimatePresence>
          {countdown > 0 && (
            <motion.div
              key={countdown}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.4 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
            >
              <span className="text-[86px] font-semibold tabular-nums text-white/90 drop-shadow-[0_2px_20px_rgba(0,0,0,0.55)]">
                {countdown}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Shutter flash */}
        <div
          className={`pointer-events-none absolute inset-0 bg-white transition-opacity duration-150 ${
            flash ? 'opacity-70' : 'opacity-0'
          }`}
        />

        {/* Lens + timer chips */}
        {!preview && cam.status === 'live' && (
          <div className="absolute right-3 top-3 flex flex-col gap-2">
            {cam.canSwitch && (
              <button
                type="button"
                onClick={cam.switchCamera}
                aria-label="Switch camera"
                className="panel flex h-10 w-10 items-center justify-center rounded-full text-ink-100"
              >
                <SwitchCamera className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                setTimer(TIMERS[(TIMERS.indexOf(timer) + 1) % TIMERS.length])
              }
              aria-label="Self-timer"
              className="panel flex h-10 w-10 items-center justify-center rounded-full text-ink-100"
            >
              {timer === 0 ? (
                <Timer className="h-[18px] w-[18px]" strokeWidth={1.8} />
              ) : (
                <span className="text-[13px] font-semibold tabular-nums">{timer}s</span>
              )}
            </button>
          </div>
        )}
      </div>

      {/* ── tips ─────────────────────────────────────────────────────────── */}
      {!preview && (
        <ul className="no-scrollbar mt-4 flex gap-2 overflow-x-auto px-5 pb-1">
          {copy.tips.map(([Icon, text]) => (
            <li
              key={text}
              className="flex shrink-0 items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-[12.5px] text-ink-300"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-accent-glow" strokeWidth={1.8} />
              <span className="whitespace-nowrap">{text}</span>
            </li>
          ))}
        </ul>
      )}

      {fileError && (
        <p className="px-5 pt-3 text-[12.5px] text-accent-warm">{fileError}</p>
      )}

      {/* ── controls ─────────────────────────────────────────────────────── */}
      <div className="safe-b px-5 pb-5 pt-4">
        {preview ? (
          <div className="flex gap-3">
            <Button
              variant="secondary"
              size="lg"
              className="flex-1"
              onClick={() => setPreview(null)}
            >
              Retake
            </Button>
            <Button
              size="lg"
              className="flex-1"
              onClick={() => onCapture(preview)}
            >
              <Check className="h-[18px] w-[18px]" strokeWidth={2.2} />
              Use photo
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-ink-800/70 text-ink-200 transition-colors hover:bg-ink-700/70 disabled:opacity-40"
              aria-label="Upload a photo instead"
            >
              <Upload className="h-5 w-5" strokeWidth={1.8} />
            </button>

            <button
              type="button"
              onClick={shoot}
              disabled={cam.status !== 'live' || countdown > 0}
              aria-label={`Capture ${view} photo`}
              className="group relative mx-auto flex h-[74px] w-[74px] items-center justify-center rounded-full border-2 border-white/25 transition-transform active:scale-95 disabled:opacity-35"
            >
              <span className="h-[58px] w-[58px] rounded-full bg-ink-100 transition-colors group-hover:bg-white" />
            </button>

            <div className="h-14 w-14 shrink-0" aria-hidden />
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void pickFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
