'use client';

import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  Boxes,
  Camera,
  Cpu,
  ExternalLink,
  RotateCw,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

// Annotated rather than `as const`: framer-motion's cubic-bezier type is a
// four-tuple, and a readonly tuple is not assignable to it.
const ease: [number, number, number, number] = [0.16, 1, 0.3, 1];

const STEPS = [
  {
    icon: Camera,
    title: 'Two photos',
    body: 'One facing the camera, one from the side. Your phone camera is enough.',
  },
  {
    icon: Cpu,
    title: 'Silhouette solve',
    body: 'Anatomical landmarks and biometric proportions are fitted to your outline.',
  },
  {
    icon: RotateCw,
    title: 'A model you can spin',
    body: 'A rigged, textured mesh you can orbit, inspect and export as .glb or .obj.',
  },
];

export default function LandingPage() {
  const reduce = useReducedMotion();
  const rise = (delay: number) =>
    reduce
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { delay } }
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.7, delay, ease },
        };

  return (
    <main className="relative min-h-dvh overflow-hidden bg-ink-950">
      {/* Ambient light, kept extremely restrained. */}
      <div className="pointer-events-none absolute inset-0 aura" aria-hidden />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/12 to-transparent"
        aria-hidden
      />

      <header className="safe-t relative mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
        <span className="flex items-center gap-2 text-[15px] font-medium tracking-tight text-ink-100">
          <Boxes className="h-[18px] w-[18px] text-accent-glow" strokeWidth={1.7} />
          Digital You
        </span>
        <a
          href="https://threejs.org"
          target="_blank"
          rel="noreferrer noopener"
          className="hidden items-center gap-1.5 text-[13px] text-ink-400 transition-colors hover:text-ink-200 sm:flex"
        >
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.7} />
          Built with Three.js
        </a>
      </header>

      <section className="relative mx-auto flex w-full max-w-5xl flex-col items-center px-6 pb-24 pt-10 text-center sm:pt-20">
        <motion.p
          {...rise(0)}
          className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-[12.5px] text-ink-300"
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-accent-glow animate-pulse-ring" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent-glow" />
          </span>
          Photogrammetric body reconstruction, in the browser
        </motion.p>

        <motion.h1
          {...rise(0.06)}
          className="text-balance text-[clamp(2.6rem,9vw,4.75rem)] font-semibold leading-[1.02] tracking-tightest text-ink-100"
        >
          Create Your Digital You.
        </motion.h1>

        <motion.p
          {...rise(0.13)}
          className="text-balance mt-5 max-w-lg text-[17px] leading-relaxed text-ink-300 sm:text-[19px]"
        >
          Turn a few photos into a realistic 3D avatar.
        </motion.p>

        <motion.div {...rise(0.2)} className="mt-10 flex flex-col items-center gap-4">
          <Link href="/create" className="w-full sm:w-auto">
            <Button size="lg" className="w-full sm:w-auto">
              Create My Avatar
              <ArrowRight className="h-[18px] w-[18px]" strokeWidth={2} />
            </Button>
          </Link>
          <span className="flex items-center gap-1.5 text-[12.5px] text-ink-500">
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.7} />
            Runs on your device by default — no account, no upload required
          </span>
        </motion.div>

        <motion.div
          {...rise(0.3)}
          className="mt-20 grid w-full gap-px overflow-hidden rounded-3xl border border-white/[0.07] bg-white/[0.05] text-left sm:grid-cols-3"
        >
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <div key={title} className="bg-ink-950/80 p-6">
              <div className="mb-4 flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]">
                  <Icon className="h-4 w-4 text-accent-glow" strokeWidth={1.7} />
                </span>
                <span className="font-mono text-[11px] text-ink-500">
                  0{i + 1}
                </span>
              </div>
              <h2 className="text-[15px] font-medium text-ink-100">{title}</h2>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-400">
                {body}
              </p>
            </div>
          ))}
        </motion.div>
      </section>

      <footer className="safe-b relative mx-auto w-full max-w-5xl px-6 pb-8">
        <p className="hairline-t pt-6 text-[12px] leading-relaxed text-ink-500">
          Measurements are estimates derived from your silhouette. Accuracy
          depends on framing, lighting and a plain background — not a substitute
          for a tailor&apos;s tape.
        </p>
      </footer>
    </main>
  );
}
