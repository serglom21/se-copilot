import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { useToastStore } from '../store/toast-store';

const ICONS = {
  success: <CheckCircle size={16} className="text-green-400 shrink-0" />,
  error: <AlertCircle size={16} className="text-sentry-pink shrink-0" />,
  warning: <AlertTriangle size={16} className="text-yellow-400 shrink-0" />,
  info: <Info size={16} className="text-sentry-purple-400 shrink-0" />,
};

const BORDERS = {
  success: 'border-green-500/40',
  error: 'border-sentry-pink/40',
  warning: 'border-yellow-500/40',
  info: 'border-sentry-purple-500/40',
};

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  return (
    <div className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`
            pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg
            bg-sentry-background-secondary border ${BORDERS[toast.type]}
            shadow-sentry-lg backdrop-blur-sm
            toast-enter
            max-w-sm text-sm text-white/90
          `}
        >
          {ICONS[toast.type]}
          <span className="flex-1">{toast.message}</span>
          <button
            onClick={() => removeToast(toast.id)}
            className="text-white/30 hover:text-white/70 transition-colors ml-1"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
