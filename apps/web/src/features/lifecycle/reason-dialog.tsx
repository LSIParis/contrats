import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage } from '../../lib/api.js';
import { Button, type ButtonVariant } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { controlClass } from '../../ui/input.js';
import { Modal } from '../../ui/modal.js';

/** Boîte de confirmation avec motif obligatoire (négociation, non-renouvellement, retrait de résiliation…). */
export function ReasonDialog({ open, title, label, intro, confirmLabel, variant = 'primary', pending, error, onClose, onConfirm }: {
  open: boolean;
  title: string;
  label: string;
  intro?: ReactNode;
  confirmLabel: string;
  variant?: ButtonVariant;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  const submit = (e: FormEvent) => { e.preventDefault(); if (reason.trim()) onConfirm(reason.trim()); };
  const id = `reason-${title.replace(/\W+/g, '-')}`;
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={submit} className="flex flex-col gap-3 text-sm">
        {intro}
        <Field label={label} htmlFor={id}>
          <textarea id={id} rows={3} maxLength={2000} required className={controlClass} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error ? <p role="alert" className="text-danger">{errorMessage(error)}</p> : null}
        <div className="flex gap-2">
          <Button type="submit" variant={variant} disabled={!reason.trim() || pending}>{pending ? 'Enregistrement…' : confirmLabel}</Button>
          <Button type="button" variant="secondary" onClick={onClose}>Annuler</Button>
        </div>
      </form>
    </Modal>
  );
}
