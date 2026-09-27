import { useId, useState, type ReactNode } from 'react';
import { Button } from '../../ui/button.js';
import { Icon } from '../../ui/icons.js';
import { Modal } from '../../ui/modal.js';

/**
 * Affichage UNIQUE d'un secret (clé d'API, secret HMAC d'un webhook) : l'API
 * ne le stocke que haché/chiffré et ne le renverra plus jamais. Champ en
 * lecture seule sélectionnable, bouton « Copier », avertissement explicite.
 * Le secret n'est gardé qu'en mémoire du composant : fermé, il disparaît.
 */
export function SecretOnceDialog({
  title, label, value, doneLabel, children, onClose,
}: {
  title: string;
  label: string;
  value: string;
  doneLabel: string;
  children?: ReactNode;
  onClose: () => void;
}) {
  const id = useId();
  const [copied, setCopied] = useState<'ok' | 'ko' | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied('ok');
    } catch {
      setCopied('ko');
    }
  }
  return (
    <Modal open title={title} onClose={onClose} width={620} footer={<Button type="button" onClick={onClose}>{doneLabel}</Button>}>
      <div className="flex flex-col gap-3 text-sm">
        <p role="note" className="flex items-start gap-2 rounded border border-warn bg-warn-bg px-3 py-2 text-warn">
          <Icon name="alert" />
          <span>
            Cette valeur ne sera plus jamais affichée : l’application n’en conserve qu’une empreinte. Copiez-la maintenant et
            transmettez-la par votre gestionnaire de secrets, jamais par messagerie.
          </span>
        </p>
        {children}
        <label htmlFor={id} className="text-xs+ font-button text-ink-muted">{label}</label>
        <div className="flex gap-2">
          <input
            id={id}
            readOnly
            value={value}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded border border-line-strong bg-slate-50 px-2.5 py-2 font-mono text-13 text-ink"
          />
          <Button type="button" variant="secondary" onClick={() => void copy()}>
            <Icon name="copy" />Copier
          </Button>
        </div>
        <p aria-live="polite" className="text-13">
          {copied === 'ok' && <span className="text-success">Copiée dans le presse-papiers.</span>}
          {copied === 'ko' && <span className="text-danger">Copie impossible : sélectionnez le texte et copiez-le manuellement.</span>}
        </p>
      </div>
    </Modal>
  );
}
