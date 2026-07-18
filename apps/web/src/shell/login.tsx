import { Button } from '../ui/button.js';
import { login } from '../lib/api.js';
export function Login() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-2xl font-semibold text-lsi">LSI Contrats</h1>
      <Button onClick={login}>Se connecter avec Microsoft 365</Button>
    </div>
  );
}
