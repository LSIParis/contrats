import { Link } from 'react-router-dom';

export function PortalSignatureCompletePage() {
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-xl font-semibold">Merci</h1>
      <p className="mt-2 text-gray-600">Votre signature a bien été enregistrée.</p>
      <Link to="/portal/contracts" className="mt-4 inline-block text-lsi hover:underline">Revenir à mes contrats</Link>
    </div>
  );
}
