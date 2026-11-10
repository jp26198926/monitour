import { useState, useCallback, createContext, useContext, type ReactNode } from 'react';

interface ModalOptions {
  title: string;
  message: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmModalState extends ModalOptions {
  type: 'confirm';
  resolve: (value: boolean) => void;
}

interface AlertModalState extends ModalOptions {
  type: 'alert';
  resolve: () => void;
}

type ModalState = ConfirmModalState | AlertModalState;

interface ModalContextValue {
  confirm: (opts: ModalOptions) => Promise<boolean>;
  alert: (opts: ModalOptions) => Promise<void>;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export function useModal(): ModalContextValue {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('useModal must be used within ModalProvider');
  return ctx;
}

export function ModalProvider({ children }: { children: ReactNode }) {
  const [modal, setModal] = useState<ModalState | null>(null);

  const confirm = useCallback((opts: ModalOptions) => {
    return new Promise<boolean>((resolve) => {
      setModal({ ...opts, type: 'confirm', resolve });
    });
  }, []);

  const alert = useCallback((opts: ModalOptions) => {
    return new Promise<void>((resolve) => {
      setModal({ ...opts, type: 'alert', resolve });
    });
  }, []);

  const handleClose = (value: boolean) => {
    if (modal) {
      if (modal.type === 'confirm') modal.resolve(value);
      else modal.resolve();
      setModal(null);
    }
  };

  return (
    <ModalContext.Provider value={{ confirm, alert }}>
      {children}
      {modal && (
        <div className="modal-backdrop" onClick={() => handleClose(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{modal.title}</h3>
            </div>
            <div className="modal-body">
              <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 }}>
                {modal.message}
              </p>
            </div>
            <div className="modal-footer">
              {modal.type === 'confirm' && (
                <button className="btn btn-secondary" onClick={() => handleClose(false)}>
                  {modal.cancelText || 'Cancel'}
                </button>
              )}
              <button
                className={`btn ${modal.danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => handleClose(true)}
                autoFocus
              >
                {modal.okText || 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ModalContext.Provider>
  );
}
