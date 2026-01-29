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
        'font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        {
          'bg-sentry-purple hover:bg-sentry-purple/90 text-white': variant === 'primary',
          'bg-gray-200 hover:bg-gray-300 text-gray-800': variant === 'secondary',
          'bg-red-600 hover:bg-red-700 text-white': variant === 'danger',
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
