import { useState, type FormEvent } from 'react';
import { Button } from '../../../ui/button.js';
import { Field } from '../../../ui/field.js';
import { Input } from '../../../ui/input.js';
import { Select } from '../../../ui/select.js';
import { publicApi, setOtpSession, type AcceptResult, type PublicView } from './public-api.js';

const DECLINE_REASONS: [string, string][] = [
  ['PRICE', 'Prix'],
  ['COMPETITOR', 'Autre prestataire retenu'],
  ['TIMING', 'Calendrier / pas maintenant'],
  ['SCOPE', 'Périmètre ne correspondant pas'],
  ['NO_PROJECT', 'Projet abandonné'],
  ['OTHER', 'Autre'],
];

/**
 * Code à usage unique envoyé par e-mail (propositions sensibles, acceptation par
 * clic). La session obtenue reste dans l'onglet (sessionStorage).
 */
export function OtpGate({ token, intro, onVerified }: { token: string; intro: string; onVerified: () => void }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      setSentTo((await publicApi.requestOtp(token)).sentTo);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await publicApi.verifyOtp(token, code.trim());
      setOtpSession(token, r.otpSession);
      onVerified();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" aria-label="Vérification par code">
      <p className="text-sm text-ink-muted">{intro}</p>
      {!sentTo ? (
        <Button type="button" onClick={() => void request()} disabled={busy} className="self-start">Recevoir un code par e-mail</Button>
      ) : (
        <form onSubmit={(e) => void verify(e)} className="flex flex-col gap-3">
          <p className="text-13 text-ink-muted">Code envoyé à {sentTo} (valable 10 minutes).</p>
          <Field label="Code à 6 chiffres" htmlFor="otp-code">
            <Input id="otp-code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || code.trim().length !== 6}>Vérifier</Button>
            <Button type="button" variant="ghost" onClick={() => void request()} disabled={busy}>Renvoyer un code</Button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="text-13 text-danger">{error}</p>}
    </div>
  );
}

/** Signature DocuSeal intégrée (`embed_src`), même principe que la signature intégrée des contrats. */
export function EmbeddedSigning({ src }: { src: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink-muted">Signez le bon pour accord ci-dessous. Vous recevrez une copie signée par e-mail.</p>
      <iframe title="Signature électronique du bon pour accord" src={src} className="h-[720px] w-full rounded-lg border border-line bg-surface" />
    </div>
  );
}

/** Zone « Acceptation et signature » : accepter (signature ou clic) ou décliner avec un motif. */
export function DecisionPanel({ token, view, onDone }: { token: string; view: PublicView; onDone: () => void }) {
  const actions = view.actions;
  const [mode, setMode] = useState<'idle' | 'accept' | 'decline'>('idle');
  const [fullName, setFullName] = useState(view.recipient.fullName);
  const [jobTitle, setJobTitle] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [reasonCode, setReasonCode] = useState('PRICE');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AcceptResult | null>(null);
  const [otpOk, setOtpOk] = useState(view.otp.verified);

  if (view.signature?.embedSrc) return <EmbeddedSigning src={view.signature.embedSrc} />;
  if (result?.signature?.embedSrc) return <EmbeddedSigning src={result.signature.embedSrc} />;
  if (result) {
    return (
      <p role="status" className="rounded border border-success bg-success-bg px-3 py-2 text-sm text-success">
        {result.status === 'SIGNED'
          ? 'Merci : votre acceptation est enregistrée. Votre interlocuteur LSI-Maintenance revient vers vous pour la suite.'
          : result.status === 'PENDING_SIGNATURE'
            ? 'Merci : votre acceptation est enregistrée. La signature électronique vous est adressée par e-mail.'
            : 'Merci : votre acceptation est enregistrée. La signature électronique vous sera adressée par e-mail ou par votre interlocuteur.'}
      </p>
    );
  }
  if (!actions) return null;
  if (view.recipient.role === 'READER') {
    return <p className="text-sm text-ink-muted">Vous consultez cette proposition en lecture : la décision revient au signataire désigné.</p>;
  }
  if (!actions.canAccept && !actions.canDecline) return null;

  const accept = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await publicApi.accept(token, { fullName, jobTitle, email, consent: true }));
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decline = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await publicApi.decline(token, { reasonCode, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {mode === 'idle' && (
        <div className="flex flex-wrap gap-2">
          {actions.canAccept && (
            <Button type="button" onClick={() => setMode('accept')}>
              {view.proposal.acceptanceMode === 'CLICK_ACCEPT' ? 'Accepter la proposition' : 'Accepter et signer'}
            </Button>
          )}
          {actions.canDecline && <Button type="button" variant="secondary" onClick={() => setMode('decline')}>Décliner</Button>}
        </div>
      )}

      {mode === 'accept' && actions.acceptRequiresOtp && !otpOk && (
        <OtpGate token={token} intro="Pour accepter, confirmez votre adresse e-mail avec un code à usage unique." onVerified={() => setOtpOk(true)} />
      )}

      {mode === 'accept' && (!actions.acceptRequiresOtp || otpOk) && (
        <form onSubmit={(e) => void accept(e)} className="flex flex-col gap-3" aria-label="Acceptation">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nom et prénom" htmlFor="acc-nom"><Input id="acc-nom" value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} autoComplete="name" /></Field>
            <Field label="Fonction" htmlFor="acc-fonction"><Input id="acc-fonction" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} required minLength={2} autoComplete="organization-title" /></Field>
            <Field label="Adresse e-mail" htmlFor="acc-email"><Input id="acc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></Field>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>J’ai pris connaissance de la proposition, de la configuration retenue et des conditions générales, et je les accepte.</span>
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !consent}>{view.proposal.acceptanceMode === 'CLICK_ACCEPT' ? 'Confirmer l’acceptation' : 'Accepter et passer à la signature'}</Button>
            <Button type="button" variant="ghost" onClick={() => setMode('idle')}>Annuler</Button>
          </div>
        </form>
      )}

      {mode === 'decline' && (
        <form onSubmit={(e) => void decline(e)} className="flex flex-col gap-3" aria-label="Refus">
          <Field label="Motif" htmlFor="dec-motif">
            <Select id="dec-motif" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              {DECLINE_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Précision (facultative)" htmlFor="dec-precision">
            <textarea id="dec-precision" className="w-full rounded border border-line-strong bg-surface px-2.5 py-2 text-sm" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={busy}>Décliner la proposition</Button>
            <Button type="button" variant="ghost" onClick={() => setMode('idle')}>Annuler</Button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="text-13 text-danger">{error}</p>}
    </div>
  );
}
