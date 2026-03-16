import { ButtonHTMLAttributes } from 'react';
import clsx from 'clsx';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'small' | 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
}

export default function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={clsx(
        'font-medium rounded-lg transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5',
        {
          'bg-sentry-gradient hover:shadow-sentry text-white hover:brightness-110': variant === 'primary',
          'bg-sentry-background-secondary hover:bg-sentry-background-tertiary text-white border border-sentry-border': variant === 'secondary',
          'bg-sentry-pink hover:bg-sentry-pink-dark text-white': variant === 'danger',
          'text-white/60 hover:text-white hover:bg-white/5 border border-transparent': variant === 'ghost',
          'px-2.5 py-1 text-xs': size === 'small' || size === 'sm',
          'px-3.5 py-2 text-sm': size === 'md',
          'px-5 py-2.5 text-sm': size === 'lg',
          'w-full': fullWidth,
        },
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
