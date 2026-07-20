import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { portalPost } from './portal-api.js';
import { Button } from '../ui/button.js';
import { Field } from '../ui/field.js';
import { Input } from '../ui/input.js';

export function PortalLoginPage() {
  const [email, setEmail] = useState('');
  const m = useMutation({
    mutationFn: () => portalPost('/v1/portal/auth/request-link', { email: email.trim() }),
  });

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-2xl font-semibold text-lsi">Espace client — LSI Maintenance</h1>
      {m.isSuccess ? (
        <p className="max-w-sm text-center text-sm text-gray-600">
          Si un compte existe, un lien de connexion vient d'être envoyé à cette adresse.
        </p>
      ) : (
        <form
          className="flex w-full max-w-sm flex-col gap-4"
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
    </div>
  );
}
