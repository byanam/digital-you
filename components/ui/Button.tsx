'use client';

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Stretch to the container width — the default on the capture screens. */
  block?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-ink-100 text-ink-950 hover:bg-white active:bg-ink-200 shadow-[0_1px_0_0_rgba(255,255,255,0.5)_inset]',
  secondary:
    'bg-ink-800/80 text-ink-100 border border-white/10 hover:bg-ink-700/80 active:bg-ink-700',
  ghost: 'text-ink-300 hover:text-ink-100 hover:bg-white/5 active:bg-white/10',
  danger: 'bg-red-500/12 text-red-300 border border-red-500/25 hover:bg-red-500/20',
};

const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-[13px] rounded-xl gap-1.5',
  md: 'h-11 px-5 text-[15px] rounded-2xl gap-2',
  lg: 'h-14 px-7 text-[17px] rounded-2xl gap-2.5',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', block, className = '', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={[
        'inline-flex select-none items-center justify-center font-medium',
        'transition-[background-color,color,transform,opacity] duration-150',
        'active:scale-[0.985] disabled:pointer-events-none disabled:opacity-40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-glow/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950',
        VARIANTS[variant],
        SIZES[size],
        block ? 'w-full' : '',
        className,
      ].join(' ')}
      {...rest}
    />
  );
});
