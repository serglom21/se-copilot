import { ButtonHTMLAttributes } from 'react';
import clsx from 'clsx';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
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
        'font-semibold rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed',
        {
          'bg-sentry-gradient hover:shadow-sentry text-white hover:scale-105': variant === 'primary',
          'bg-sentry-background-secondary hover:bg-sentry-background-tertiary text-white border border-sentry-border': variant === 'secondary',
          'bg-sentry-pink hover:bg-sentry-pink-dark text-white hover:shadow-lg': variant === 'danger',
          'px-3 py-1.5 text-sm': size === 'small' || size === 'sm',
          'px-4 py-2 text-base': size === 'md',
          'px-6 py-3 text-lg': size === 'lg',
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
