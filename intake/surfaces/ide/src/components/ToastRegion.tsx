import { useEffect } from 'react';
import { Icon } from './Icon';
import { useUIStore, type Toast } from '@/store/uiStore';

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useUIStore((state) => state.removeToast);
  useEffect(() => {
    const timer = window.setTimeout(() => removeToast(toast.id), 4200);
    return () => window.clearTimeout(timer);
  }, [removeToast, toast.id]);

  return (
    <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      <Icon name={toast.kind === 'success' ? 'check' : toast.kind === 'warning' || toast.kind === 'error' ? 'warning' : 'info'} size={16} />
      <span>{toast.message}</span>
      <button className="icon-button compact" onClick={() => removeToast(toast.id)} aria-label="Dismiss notification"><Icon name="close" size={14} /></button>
    </div>
  );
}

export function ToastRegion() {
  const toasts = useUIStore((state) => state.toasts);
  return <div className="toast-region" aria-live="polite">{toasts.map((toast) => <ToastItem key={toast.id} toast={toast} />)}</div>;
}
