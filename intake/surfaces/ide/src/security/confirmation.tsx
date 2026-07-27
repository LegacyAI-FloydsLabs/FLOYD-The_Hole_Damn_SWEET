// CURSE'M IDE — Security: Confirmation Dialog (§9).
//
// §9: "Require confirmation for destructive filesystem and Git operations."
//
// React component for displaying confirmation dialogs for destructive
// operations. In dev mode, the gateway uses window.confirm. In production,
// this component provides a custom UI.

import { useState, useCallback } from 'react';

export interface ConfirmationRequest {
  operation: string;
  details: string;
  resolve: (granted: boolean) => void;
}

export function ConfirmationDialog({
  request,
  onClose,
}: {
  request: ConfirmationRequest;
  onClose: () => void;
}) {
  const handleConfirm = useCallback(() => {
    request.resolve(true);
    onClose();
  }, [request, onClose]);

  const handleCancel = useCallback(() => {
    request.resolve(false);
    onClose();
  }, [request, onClose]);

  return (
    <div className="command-palette-overlay">
      <div style={{
        width: 400,
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border)',
        borderRadius: 6,
        padding: 16,
      }}>
        <h3 style={{ marginBottom: 8, color: 'var(--color-error)' }}>
          {request.operation}
        </h3>
        <p style={{ marginBottom: 16, color: 'var(--color-text)' }}>
          {request.details}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="debug-button" onClick={handleCancel}>Cancel</button>
          <button
            className="debug-button"
            onClick={handleConfirm}
            style={{ background: 'var(--color-error)', color: '#fff' }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

/** Hook for managing confirmation dialogs. */
export function useConfirmation() {
  const [request, setRequest] = useState<ConfirmationRequest | null>(null);

  const confirm = useCallback((operation: string, details: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setRequest({ operation, details, resolve });
    });
  }, []);

  const close = useCallback(() => {
    setRequest(null);
  }, []);

  return { request, confirm, close };
}
