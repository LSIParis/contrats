import { Link } from 'react-router-dom';
import { AuthScreen } from '../ui/layout.js';
import { Icon } from '../ui/icons.js';

export function PortalSignatureCompletePage() {
  return (
    <AuthScreen title="Merci">
      <p className="flex items-center justify-center gap-2 text-center text-ink-muted">
        <span className="text-success"><Icon name="checkCircle" /></span>
        Votre signature a bien été enregistrée.
      </p>
      <Link to="/portal/contracts" className="text-center text-primary hover:underline">Revenir à mes contrats</Link>
    </AuthScreen>
  );
}
