import { Button } from '../ui/button.js';
import { AuthScreen } from '../ui/layout.js';
import { login } from '../lib/api.js';

/** Écran de connexion — gabarit de pages/Login.tsx de lticket (carte centrée, logo, sous-titre). */
export function Login() {
  return (
    <AuthScreen title="LSI Contrats" subtitle="Connectez-vous pour accéder à votre espace.">
      <Button onClick={login} className="mt-1 w-full">Se connecter avec Microsoft 365</Button>
    </AuthScreen>
  );
}
