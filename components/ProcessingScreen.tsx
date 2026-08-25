'use client';

/**
 * The five-stage processing screen.
 *
 * The stages are real: each one is reported by lib/pipeline.ts as it runs, with
 * intra-stage progress where the work is long enough to measure (segmentation,
 * isosurface extraction). No fake timers — if a stage sits at 40% it is because
 * the polygonizer is genuinely there.
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { PipelineStage } from '@/lib/types';

export interface ProcessingScreenProps {
  stages: PipelineStage[];
  /** Index of the stage currently running. */
  activeIndex: number;
  /** Progress within the active stage, 0..1. */
  progress: number;
  note?: string | null;
  error?: string | null;
  onRetry?: () => void;
  onCancel?: () => void;
}

const RING = 2 * Math.PI * 54;

export function ProcessingScreen({
  stages,
  activeIndex,
  progress,
  note,
  error,
  onRetry,
  onCancel,
}: ProcessingScreenProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (error) return;
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [error]);

  const overall = Math.min(
    1,
    Math.max(0, (activeIndex + Math.min(1, Math.max(0, progress))) / stages.length),
  );
  const pct = Math.round(overall * 100);

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-ink-950 px-6">
      <div className="pointer-events-none absolute inset-0 aura" aria-hidden />

      <div className="relative flex w-full max-w-md flex-col items-center">
        {/* ── progress ring ─────────────────────────────────────────────── */}
        <div className="relative h-[132px] w-[132px]">
          <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
            <circle
              cx="60"
              cy="60"
              r="54"
              fill="none"
              stroke="rgba(255,255,255,0.07)"
              strokeWidth="3"
            />
            <motion.circle
              cx="60"
              cy="60"
              r="54"
              fill="none"
              stroke={error ? '#FFB68A' : '#8AB4FF'}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={RING}
              initial={{ strokeDashoffset: RING }}
              animate={{ strokeDashoffset: RING * (1 - overall) }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {error ? (
              <AlertTriangle className="h-6 w-6 text-accent-warm" strokeWidth={1.7} />
            ) : (
              <>
                <span className="text-[28px] font-semibold tabular-nums tracking-tight text-ink-100">
                  {pct}
                  <span className="text-[16px] text-ink-400">%</span>
                </span>
                <span className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-500">
                  {elapsed}s
                </span>
              </>
            )}
          </div>
        </div>

        <h1 className="mt-7 text-center text-[21px] font-semibold tracking-tight text-ink-100">
          {error ? 'Reconstruction stopped' : 'Building your avatar'}
        </h1>

        <AnimatePresence mode="wait">
          <motion.p
            key={error ?? stages[activeIndex]?.detail ?? 'done'}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            className="text-balance mt-2 max-w-sm text-center text-[13.5px] leading-relaxed text-ink-400"
          >
            {error ?? stages[activeIndex]?.detail ?? 'Almost there…'}
          </motion.p>
        </AnimatePresence>

        {/* ── stage list ────────────────────────────────────────────────── */}
        <ol className="mt-9 w-full space-y-px overflow-hidden rounded-2xl border border-white/[0.07]">
          {stages.map((stage, i) => {
            const done = i < activeIndex || (i === activeIndex && progress >= 1);
            const active = i === activeIndex && !done && !error;
            const failed = !!error && i === activeIndex;
            return (
              <li
                key={stage.id}
                className={`flex items-center gap-3 bg-white/[0.02] px-4 py-3 transition-colors ${
                  active ? 'bg-white/[0.05]' : ''
                }`}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  {done ? (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-glow/15">
                      <Check className="h-3 w-3 text-accent-glow" strokeWidth={3} />
                    </span>
                  ) : failed ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-accent-warm" />
                  ) : active ? (
                    <Loader2
                      className="h-[15px] w-[15px] animate-spin text-accent-glow"
                      strokeWidth={2.2}
                    />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-ink-700" />
                  )}
                </span>
                <span
                  className={`flex-1 text-[13.5px] leading-snug transition-colors ${
                    done
                      ? 'text-ink-300'
                      : active
                        ? 'text-ink-100'
                        : failed
                          ? 'text-accent-warm'
                          : 'text-ink-500'
                  }`}
                >
                  {stage.label}
                </span>
                <span className="font-mono text-[10.5px] tabular-nums text-ink-600">
                  {String(i + 1).padStart(2, '0')}
                </span>
              </li>
            );
          })}
        </ol>

        {note && !error && (
          <p className="mt-4 text-center text-[12px] leading-relaxed text-ink-500">
            {note}
          </p>
        )}

        <div className="mt-8 flex gap-3">
          {error && onRetry && (
            <Button size="md" onClick={onRetry}>
              Try again
            </Button>
          )}
          {onCancel && (
            <Button size="md" variant="ghost" onClick={onCancel}>
              {error ? 'Retake photos' : 'Cancel'}
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}
