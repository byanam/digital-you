'use client';

/**
 * The whole flow, in one client component.
 *
 * It is a state machine rather than nested routes on purpose: the captured
 * photos, the WebGL context and the generated mesh are all large, live objects
 * that must not survive a navigation, and a route change in the App Router would
 * either drop them or force them into a store that outlives them. Keeping the
 * flow in one mounted component also means "Back" from the profile shot returns
 * to a still-warm camera instead of re-requesting permission.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import * as THREE from 'three';
import { ArrowRight, ChevronLeft, Ruler } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { CaptureStep } from '@/components/capture/CaptureStep';
import { ProcessingScreen } from '@/components/ProcessingScreen';
import { ResultScreen } from '@/components/viewer/ResultScreen';
import { runPipeline, type PipelineOutput } from '@/lib/pipeline';
import {
  PIPELINE_STAGES,
  type CapturedPhoto,
  type PipelineStageId,
  type UserProfileInput,
} from '@/lib/types';

type Phase = 'details' | 'front' | 'profile' | 'processing' | 'result';

/** Release GPU memory for a finished avatar before building the next one. */
function disposeAvatar(output: PipelineOutput | null) {
  if (!output) return;
  output.avatar.root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

export default function CreatePage() {
  const [phase, setPhase] = useState<Phase>('details');
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [profile, setProfile] = useState<UserProfileInput>({});

  const [stageIndex, setStageIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<PipelineOutput | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<PipelineOutput | null>(null);
  outputRef.current = output;

  // Abort any in-flight reconstruction and free the last mesh on unmount.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      disposeAvatar(outputRef.current);
    },
    [],
  );

  const build = useCallback(
    async (shots: CapturedPhoto[], details: UserProfileInput) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      disposeAvatar(outputRef.current);
      setOutput(null);
      setError(null);
      setNote(null);
      setStageIndex(0);
      setProgress(0);
      setPhase('processing');

      try {
        const result = await runPipeline({
          photos: shots,
          profile: details,
          signal: controller.signal,
          report: (stage: PipelineStageId, value: number, message?: string) => {
            if (controller.signal.aborted) return;
            const index = PIPELINE_STAGES.findIndex((s) => s.id === stage);
            if (index >= 0) setStageIndex(index);
            setProgress(value);
            if (message !== undefined) setNote(message);
          },
        });
        if (controller.signal.aborted) {
          disposeAvatar(result);
          return;
        }
        setStageIndex(PIPELINE_STAGES.length - 1);
        setProgress(1);
        setOutput(result);
        setNote(result.result.note ?? null);
        setPhase('result');
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return;
        setError(
          err instanceof Error
            ? err.message
            : 'Something went wrong while building your avatar.',
        );
      }
    },
    [],
  );

  const onFront = useCallback((photo: CapturedPhoto) => {
    setPhotos([photo]);
    setPhase('profile');
  }, []);

  const onProfile = useCallback(
    (photo: CapturedPhoto) => {
      const shots = [photos[0], photo].filter(Boolean) as CapturedPhoto[];
      setPhotos(shots);
      void build(shots, profile);
    },
    [build, photos, profile],
  );

  const restart = useCallback(() => {
    abortRef.current?.abort();
    disposeAvatar(outputRef.current);
    setOutput(null);
    setPhotos([]);
    setError(null);
    setNote(null);
    setPhase('details');
  }, []);

  const cancelProcessing = useCallback(() => {
    abortRef.current?.abort();
    setError(null);
    setPhase('profile');
  }, []);

  if (phase === 'result' && output) {
    return (
      <ResultScreen
        avatar={output.avatar}
        result={output.result}
        atlas={output.atlas}
        onRestart={restart}
      />
    );
  }

  if (phase === 'processing') {
    return (
      <ProcessingScreen
        stages={PIPELINE_STAGES}
        activeIndex={stageIndex}
        progress={progress}
        note={note}
        error={error}
        onRetry={error ? () => void build(photos, profile) : undefined}
        onCancel={cancelProcessing}
      />
    );
  }

  if (phase === 'front' || phase === 'profile') {
    return (
      <CaptureStep
        key={phase}
        view={phase === 'front' ? 'front' : 'profile'}
        onCapture={phase === 'front' ? onFront : onProfile}
        onBack={() => setPhase(phase === 'front' ? 'details' : 'front')}
      />
    );
  }

  return (
    <DetailsStep
      value={profile}
      onChange={setProfile}
      onContinue={() => setPhase('front')}
    />
  );
}

// ───────────────────────────────────────────────────────────────── details ──

/**
 * One optional question, asked once.
 *
 * Stature is the only input that fixes absolute scale: without it the solver
 * falls back to a head-to-height ratio, which is accurate to roughly ±4 cm on an
 * adult and rather worse if the crown is cropped. Everything else the model needs
 * it can measure from the photographs, so this is the only field.
 */
function DetailsStep({
  value,
  onChange,
  onContinue,
}: {
  value: UserProfileInput;
  onChange: (next: UserProfileInput) => void;
  onContinue: () => void;
}) {
  const [unit, setUnit] = useState<'cm' | 'ft'>('cm');
  const [cm, setCm] = useState('');
  const [ft, setFt] = useState('');
  const [inch, setInch] = useState('');

  const commit = useCallback(
    (heightCm: number | undefined) => {
      onChange({ ...value, heightCm });
    },
    [onChange, value],
  );

  useEffect(() => {
    if (unit === 'cm') {
      const n = Number.parseFloat(cm);
      commit(Number.isFinite(n) && n >= 90 && n <= 240 ? n : undefined);
    } else {
      const f = Number.parseFloat(ft);
      const i = Number.parseFloat(inch) || 0;
      const total = (Number.isFinite(f) ? f : 0) * 30.48 + i * 2.54;
      commit(total >= 90 && total <= 240 ? total : undefined);
    }
    // `commit` closes over `value`, which changes on every commit; depending on it
    // would loop. The inputs are the only real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit, cm, ft, inch]);

  const known = value.heightCm !== undefined;

  return (
    <main className="relative flex min-h-dvh flex-col bg-ink-950">
      <div className="pointer-events-none absolute inset-0 aura" aria-hidden />

      <header className="safe-t relative z-10 flex items-center px-5 pb-2 pt-4">
        <Link
          href="/"
          className="-ml-2 flex h-9 items-center gap-1 rounded-xl px-2 text-[14px] text-ink-300 transition-colors hover:text-ink-100"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={2} />
          Back
        </Link>
      </header>

      <div className="relative z-10 flex flex-1 flex-col justify-center px-6 pb-10">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto w-full max-w-sm"
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-[12px] text-ink-300">
            <Ruler className="h-3.5 w-3.5 text-accent-glow" strokeWidth={1.9} />
            Optional, but worth it
          </span>

          <h1 className="text-balance mt-5 text-[30px] font-semibold leading-[1.1] tracking-tightest text-ink-100">
            How tall are you?
          </h1>
          <p className="mt-3 text-[14.5px] leading-relaxed text-ink-400">
            Your height is the one number a photo cannot recover on its own. With it,
            every other measurement is to scale — without it, they are proportional
            estimates.
          </p>

          <div className="mt-7 flex rounded-full border border-white/[0.07] p-0.5">
            {(['cm', 'ft'] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                className={`h-8 flex-1 rounded-full text-[12.5px] font-medium transition-colors ${
                  unit === u ? 'bg-white/10 text-ink-100' : 'text-ink-500'
                }`}
              >
                {u === 'cm' ? 'Centimetres' : 'Feet & inches'}
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={unit}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
              className="mt-3 flex gap-2"
            >
              {unit === 'cm' ? (
                <Field
                  value={cm}
                  onChange={setCm}
                  suffix="cm"
                  placeholder="172"
                  label="Height in centimetres"
                  autoFocus
                />
              ) : (
                <>
                  <Field
                    value={ft}
                    onChange={setFt}
                    suffix="ft"
                    placeholder="5"
                    label="Height, feet"
                    autoFocus
                  />
                  <Field
                    value={inch}
                    onChange={setInch}
                    suffix="in"
                    placeholder="8"
                    label="Height, inches"
                  />
                </>
              )}
            </motion.div>
          </AnimatePresence>

          <p className="mt-2.5 h-4 text-[12px] text-ink-500">
            {known ? `Using ${Math.round(value.heightCm!)} cm.` : ''}
          </p>

          <Button size="lg" block className="mt-6" onClick={onContinue}>
            {known ? 'Continue' : 'Skip and estimate it'}
            <ArrowRight className="h-[18px] w-[18px]" strokeWidth={2} />
          </Button>

          <p className="mt-4 text-center text-[11.5px] leading-relaxed text-ink-600">
            Nothing here is stored or sent anywhere. Two photos come next.
          </p>
        </motion.div>
      </div>
    </main>
  );
}

function Field({
  value,
  onChange,
  suffix,
  placeholder,
  label,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  suffix: string;
  placeholder: string;
  label: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="relative flex-1">
      <span className="sr-only">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
        className="h-14 w-full rounded-2xl border border-white/[0.09] bg-white/[0.03] pl-4 pr-12 text-[19px] font-semibold tabular-nums tracking-tight text-ink-100 outline-none transition-colors placeholder:font-normal placeholder:text-ink-600 focus:border-accent-glow/50 focus:bg-white/[0.05]"
      />
      <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px] text-ink-500">
        {suffix}
      </span>
    </label>
  );
}
