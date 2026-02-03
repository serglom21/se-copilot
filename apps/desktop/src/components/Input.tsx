import { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, className, ...props }: InputProps) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-gray-300 mb-2">
          {label}
        </label>
      )}
      <input
        className={clsx(
          'w-full px-4 py-2.5 bg-sentry-background-secondary border rounded-lg text-white placeholder-gray-500',
          'focus:outline-none focus:ring-2 focus:ring-sentry-purple-500 focus:border-transparent',
          'transition-all duration-200',
          error ? 'border-sentry-pink' : 'border-sentry-border hover:border-sentry-border-light',
          className
        )}
        {...props}
      />
      {error && (
        <p className="mt-2 text-sm text-sentry-pink">{error}</p>
      )}
    </div>
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export function Textarea({ label, error, className, ...props }: TextareaProps) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-gray-300 mb-2">
          {label}
        </label>
      )}
      <textarea
        className={clsx(
          'w-full px-4 py-2.5 bg-sentry-background-secondary border rounded-lg text-white placeholder-gray-500',
          'focus:outline-none focus:ring-2 focus:ring-sentry-purple-500 focus:border-transparent',
          'transition-all duration-200',
          error ? 'border-sentry-pink' : 'border-sentry-border hover:border-sentry-border-light',
          className
        )}
        {...props}
      />
      {error && (
        <p className="mt-2 text-sm text-sentry-pink">{error}</p>
      )}
    </div>
  );
}

interface SelectProps extends InputHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
}

export function Select({ label, error, options, className, ...props }: SelectProps) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-gray-300 mb-2">
          {label}
        </label>
      )}
      <select
        className={clsx(
          'w-full px-4 py-2.5 bg-sentry-background-secondary border rounded-lg text-white',
          'focus:outline-none focus:ring-2 focus:ring-sentry-purple-500 focus:border-transparent',
          'transition-all duration-200 cursor-pointer',
          error ? 'border-sentry-pink' : 'border-sentry-border hover:border-sentry-border-light',
          className
        )}
        {...props}
      >
        {options.map(option => (
          <option key={option.value} value={option.value} className="bg-sentry-background-secondary text-white">
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <p className="mt-2 text-sm text-sentry-pink">{error}</p>
      )}
    </div>
  );
}
