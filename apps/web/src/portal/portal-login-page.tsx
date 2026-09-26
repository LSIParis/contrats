import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { portalPost } from './portal-api.js';
import { Button } from '../ui/button.js';
import { Field } from '../ui/field.js';
import { Input } from '../ui/input.js';
import { AuthScreen } from '../ui/layout.js';

export function PortalLoginPage() {
  const [email, setEmail] = useState('');
  const m = useMutation({
    mutationFn: () => portalPost('/v1/portal/auth/request-link', { email: email.trim() }),
  });

  return (
    <AuthScreen title="Espace client — LSI Maintenance" subtitle="Recevez un lien de connexion par email.">
      {m.isSuccess ? (
        <p role="status" className="text-center text-sm text-ink-muted">
          Si un compte existe, un lien de connexion vient d'être envoyé à cette adresse.
        </p>
      ) : (
        <form
          className="flex w-full flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) m.mutate();
          }}
        >
          <Field label="Adresse email" htmlFor="portal-email">
            <Input
              id="portal-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="vous@exemple.fr"
              required
            />
          </Field>
          <Button type="submit" disabled={!email.trim() || m.isPending}>
            {m.isPending ? 'Envoi…' : 'Recevoir un lien de connexion'}
          </Button>
        </form>
      )}
    </AuthScreen>
  );
}
