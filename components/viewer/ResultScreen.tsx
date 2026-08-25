'use client';

/**
 * The result screen: viewport plus chrome.
 *
 * On a phone the model deserves the whole screen, so the controls live in a
 * frosted sheet over the canvas rather than in a sidebar, and the sheet collapses
 * to a single row the moment the user starts dragging — the first orbit is when
 * they most want the pixels back.
 *
 * Every number in the telemetry panel is derived from the mesh that is actually
 * on screen (see measureField / scoreSilhouette in the pipeline), which is why
 * the accuracy figure is presented as a measured IoU rather than a marketing
 * percentage.
 */

import { useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Box,
  ChevronDown,
  Cpu,
  Download,
  Image as ImageIcon,
  Info,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { AvatarViewer, type ViewPreset } from './AvatarViewer';
import { download, exportGlb, exportObj, exportTexture } from '@/lib/three/export';
import type { AvatarObject } from '@/lib/three/avatar';
import type { AvatarResult } from '@/lib/types';

/** A triangle-mesh glyph — closer to what the toggle does than any stock icon. */
function MeshIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 3 21 8.4v7.2L12 21 3 15.6V8.4z" />
      <path d="M3 8.4 12 12l9-3.6M12 12v9" />
      <path d="M12 3v9M3 15.6 12 12l9 3.6" />
    </svg>
  );
}

export interface ResultScreenProps {
  avatar: AvatarObject;
  result: AvatarResult;
  /** The baked atlas, when the local pipeline produced one. */
  atlas: HTMLCanvasElement | null;
  onRestart: () => void;
}

const PRESETS: Array<{ id: ViewPreset; label: string }> = [
  { id: 'front', label: 'Front' },
  { id: 'side', label: 'Profile' },
  { id: 'back', label: 'Back' },
  { id: 'head', label: 'Head' },
];

type Units = 'cm' | 'in';

function fmtLength(cm: number, units: Units): string {
  if (!Number.isFinite(cm) || cm <= 0) return '—';
  return units === 'cm' ? `${cm.toFixed(1)} cm` : `${(cm / 2.54).toFixed(1)} in`;
}

function fmtStature(cm: number, units: Units): string {
  if (!Number.isFinite(cm) || cm <= 0) return '—';
  if (units === 'cm') return `${Math.round(cm)} cm`;
  const total = cm / 2.54;
  const ft = Math.floor(total / 12);
  const inch = Math.round(total - ft * 12);
  return inch === 12 ? `${ft + 1}′ 0″` : `${ft}′ ${inch}″`;
}

export function ResultScreen({ avatar, result, atlas, onRestart }: ResultScreenProps) {
  const [preset, setPreset] = useState<ViewPreset>('front');
  const [presetNonce, setPresetNonce] = useState(0);
  const [wireframe, setWireframe] = useState(false);
  const [units, setUnits] = useState<Units>('cm');
  const [sheet, setSheet] = useState(true);
  const [busy, setBusy] = useState<null | 'glb' | 'obj' | 'png'>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const m = result.metrics;

  const rows = useMemo(
    () => [
      { label: 'Height', value: fmtStature(m.heightCm, units) },
      { label: 'Chest', value: fmtLength(m.chestCm, units) },
      { label: 'Waist', value: fmtLength(m.waistCm, units) },
      { label: 'Hips', value: fmtLength(m.hipCm, units) },
    ],
    [m.heightCm, m.chestCm, m.waistCm, m.hipCm, units],
  );

  const secondary = useMemo(
    () => [
      { label: 'Shoulders', value: fmtLength(m.shoulderWidthCm, units) },
      { label: 'Neck', value: fmtLength(m.neckCm, units) },
      { label: 'Thigh', value: fmtLength(m.thighCm, units) },
      { label: 'Upper arm', value: fmtLength(m.upperArmCm, units) },
      { label: 'Inseam', value: fmtLength(m.inseamCm, units) },
      { label: 'Arm length', value: fmtLength(m.armLengthCm, units) },
    ],
    [
      m.shoulderWidthCm,
      m.neckCm,
      m.thighCm,
      m.upperArmCm,
      m.inseamCm,
      m.armLengthCm,
      units,
    ],
  );

  const pickPreset = useCallback((next: ViewPreset) => {
    setPreset(next);
    // A second tap on the active preset should still recentre.
    setPresetNonce((n) => n + 1);
  }, []);

  const run = useCallback(
    async (kind: 'glb' | 'obj' | 'png') => {
      setBusy(kind);
      setExportError(null);
      try {
        if (kind === 'glb') {
          download(await exportGlb(avatar.root), 'digital-you.glb');
        } else if (kind === 'obj') {
          download(exportObj(avatar.root), 'digital-you.obj');
        } else if (atlas) {
          download(await exportTexture(atlas), 'digital-you-texture.png');
        }
      } catch (err) {
        setExportError(
          err instanceof Error ? err.message : 'The export could not be written.',
        );
      } finally {
        setBusy(null);
      }
    },
    [atlas, avatar.root],
  );

  const accuracy = Math.max(0, Math.min(99.5, m.silhouetteAccuracy));

  return (
    <main className="relative h-dvh overflow-hidden bg-ink-950">
      <div className="pointer-events-none absolute inset-0 aura" aria-hidden />

      {/* ── canvas ───────────────────────────────────────────────────────── */}
      <div className="absolute inset-0">
        <AvatarViewer
          avatar={avatar}
          wireframe={wireframe}
          preset={preset}
          presetNonce={presetNonce}
          onInteract={() => setSheet(false)}
        />
      </div>

      {/* ── top bar ──────────────────────────────────────────────────────── */}
      <header className="safe-t absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 px-4 pt-3">
        <button
          type="button"
          onClick={onRestart}
          className="panel flex h-10 items-center gap-1.5 rounded-full px-3.5 text-[13px] text-ink-200 transition-colors hover:text-ink-100"
        >
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
          Start over
        </button>

        <div className="flex flex-col items-end gap-2">
          <span className="panel flex h-10 items-center gap-2 rounded-full px-3.5 text-[12.5px] text-ink-200">
            {result.mode === 'neural' ? (
              <Sparkles className="h-3.5 w-3.5 text-accent-glow" strokeWidth={1.9} />
            ) : (
              <Cpu className="h-3.5 w-3.5 text-accent-glow" strokeWidth={1.9} />
            )}
            {result.mode === 'neural'
              ? `Neural · ${result.provider ?? 'provider'}`
              : 'On-device'}
          </span>
          <span className="panel flex h-8 items-center gap-1.5 rounded-full px-3 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-300">
            {accuracy.toFixed(1)}% match
          </span>
        </div>
      </header>

      {/* ── bottom stack ─────────────────────────────────────────────────── */}
      <div className="safe-b absolute inset-x-0 bottom-0 z-10 px-3 pb-3">
        {/* view controls */}
        <div className="mb-3 flex items-center justify-center gap-2">
          <div className="panel flex rounded-full p-1">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => pickPreset(p.id)}
                className={`h-9 rounded-full px-3.5 text-[12.5px] font-medium transition-colors ${
                  preset === p.id
                    ? 'bg-ink-100 text-ink-950'
                    : 'text-ink-300 hover:text-ink-100'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setWireframe((w) => !w)}
            aria-label="Toggle wireframe"
            aria-pressed={wireframe}
            className={`panel flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
              wireframe ? 'text-accent-glow' : 'text-ink-300 hover:text-ink-100'
            }`}
          >
            <MeshIcon className="h-[19px] w-[19px]" />
          </button>
        </div>

        {/* telemetry sheet */}
        <div className="panel overflow-hidden rounded-[26px]">
          <button
            type="button"
            onClick={() => setSheet((s) => !s)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
            aria-expanded={sheet}
          >
            <span className="flex-1">
              <span className="block text-[13.5px] font-semibold text-ink-100">
                Biometric telemetry
              </span>
              <span className="block text-[11.5px] text-ink-500">
                {fmtStature(m.heightCm, units)} · {result.triangles.toLocaleString()}{' '}
                triangles
              </span>
            </span>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-ink-400 transition-transform duration-300 ${
                sheet ? 'rotate-180' : ''
              }`}
              strokeWidth={2}
            />
          </button>

          <AnimatePresence initial={false}>
            {sheet && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                {/* Capped and scrollable: the panel must never push the view
                    controls off a short screen. */}
                <div className="no-scrollbar max-h-[52dvh] overflow-y-auto px-4 pb-4">
                  <div className="hairline-t -mx-4 mb-3" />

                  <div className="mb-3 flex items-center justify-between">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-500">
                      Measurements
                    </span>
                    <div className="flex rounded-full border border-white/[0.07] p-0.5">
                      {(['cm', 'in'] as Units[]).map((u) => (
                        <button
                          key={u}
                          type="button"
                          onClick={() => setUnits(u)}
                          className={`h-6 rounded-full px-2.5 text-[11px] font-medium transition-colors ${
                            units === u
                              ? 'bg-white/10 text-ink-100'
                              : 'text-ink-500 hover:text-ink-300'
                          }`}
                        >
                          {u}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    {rows.map((r) => (
                      <div
                        key={r.label}
                        className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5"
                      >
                        <div className="text-[11px] text-ink-500">{r.label}</div>
                        <div className="mt-0.5 text-[16px] font-semibold tabular-nums tracking-tight text-ink-100">
                          {r.value}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Accuracy */}
                  <div className="mt-2 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                    <div className="flex items-baseline justify-between">
                      <span className="text-[11px] text-ink-500">
                        Silhouette accuracy
                      </span>
                      <span className="text-[15px] font-semibold tabular-nums text-accent-glow">
                        {accuracy.toFixed(1)}%
                      </span>
                    </div>
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.07]">
                      <motion.div
                        className="h-full rounded-full bg-accent-glow"
                        initial={{ width: 0 }}
                        animate={{ width: `${accuracy}%` }}
                        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                      />
                    </div>
                    <div className="mt-2 font-mono text-[10.5px] text-ink-600">
                      front {(m.frontIoU * 100).toFixed(1)}% · profile{' '}
                      {m.profileIoU > 0 ? `${(m.profileIoU * 100).toFixed(1)}%` : 'n/a'}
                    </div>
                  </div>

                  {/* Secondary measures */}
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
                    {secondary.map((s) => (
                      <div key={s.label} className="flex items-baseline justify-between">
                        <dt className="text-[12px] text-ink-500">{s.label}</dt>
                        <dd className="text-[12.5px] tabular-nums text-ink-200">
                          {s.value}
                        </dd>
                      </div>
                    ))}
                  </dl>

                  <div className="mt-3 flex items-start gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                    <Info
                      className="mt-px h-3.5 w-3.5 shrink-0 text-ink-500"
                      strokeWidth={1.9}
                    />
                    <p className="text-[11.5px] leading-relaxed text-ink-500">
                      Scale from{' '}
                      {m.scaleSource === 'user-height'
                        ? 'the height you entered'
                        : 'an estimated head-to-height ratio'}
                      . Circumferences are computed from the delivered mesh — good for
                      fit previews, not for tailoring.
                      {result.note ? ` ${result.note}` : ''}
                    </p>
                  </div>

                  {/* ── export ───────────────────────────────────────────── */}
                  <div className="hairline-t -mx-4 my-3" />
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-500">
                    Export
                  </span>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="md"
                      className="flex-1"
                      onClick={() => void run('glb')}
                      disabled={busy !== null}
                    >
                      {busy === 'glb' ? (
                        <RefreshCw className="h-4 w-4 animate-spin" strokeWidth={2} />
                      ) : (
                        <Download className="h-4 w-4" strokeWidth={2} />
                      )}
                      .glb
                    </Button>
                    <Button
                      size="md"
                      variant="secondary"
                      className="flex-1"
                      onClick={() => void run('obj')}
                      disabled={busy !== null}
                    >
                      <Box className="h-4 w-4" strokeWidth={1.9} />
                      .obj
                    </Button>
                    {atlas && (
                      <Button
                        size="md"
                        variant="secondary"
                        onClick={() => void run('png')}
                        disabled={busy !== null}
                        aria-label="Download the texture atlas"
                      >
                        <ImageIcon className="h-4 w-4" strokeWidth={1.9} />
                      </Button>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-ink-600">
                    The .glb keeps the humanoid rig and baked atlas, so it drops straight
                    into a garment simulation or a game engine.
                  </p>
                  {exportError && (
                    <p className="mt-2 text-[11.5px] text-accent-warm">{exportError}</p>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </main>
  );
}
