/**
 * Indicateur de chargement. lticket n'a pas de spinner : il affiche un état texte centré
 * `.empty` (apps/console/src/styles.css l. 407 : centré, atténué, 28×12 px). On garde ce
 * gabarit et on ajoute un anneau menthe discret, figé si l'utilisateur réduit les animations.
 * `role="status"` : le chargement est annoncé aux lecteurs d'écran.
 */
export function Spinner({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 px-3 py-7 text-center text-ink-muted">
      <span
        aria-hidden="true"
        className="inline-block h-4 w-4 rounded-full border-2 border-mint-200 border-t-primary motion-safe:animate-spin"
      />
      {label}
    </div>
  );
}
