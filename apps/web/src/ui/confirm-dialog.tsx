import type { ReactNode } from 'react';
import { Button, type ButtonVariant } from './button.js';
import { Modal } from './modal.js';
import { ErrorNote } from './region-card.js';

/**
 * Confirmation d'une action (activation, révocation, rotation…) : modale lticket avec
 * « Annuler » et le bouton d'action. L'erreur serveur s'affiche DANS la boîte, qui reste
 * ouverte. `disabled` : action impossible tant qu'un champ requis (motif…) est vide.
 */
export function ConfirmDialog({
  open, title, confirmLabel, onConfirm, onClose, pending = false, error, disabled = false, variant = 'primary', children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  pending?: boolean;
  error?: string;
  disabled?: boolean;
  variant?: ButtonVariant;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Annuler</Button>
          <Button type="button" variant={variant} disabled={disabled || pending} onClick={onConfirm}>
            {pending ? 'Patientez…' : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-ink">
        {children}
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Modal>
  );
}
