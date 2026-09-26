import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Icon, type IconName } from './icons.js';

/**
 * Gabarit de page commun (console interne et portail client) — reprise de lticket :
 * `.shell` / `.sidebar` / `.topbar` / `.content` / `.footer`
 * (apps/console/src/styles.css l. 83-194 ; components/Sidebar.tsx, Footer.tsx ; App.tsx l. 162-222).
 */

/** Logo LSI dans sa pastille blanche (`.brand-chip`, l. 95-96). `public/logo-lsi.jpg` vient de lticket. */
export function BrandChip({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <span className={`inline-flex justify-center self-start rounded bg-white ${size === 'lg' ? 'border border-line px-4 py-2.5' : 'px-2.5 py-1.5'}`}>
      <img
        src="/logo-lsi.jpg"
        alt="LSI Maintenance"
        className={`block w-auto ${size === 'lg' ? 'h-[34px]' : 'h-5'}`}
      />
    </span>
  );
}

/** Lien d'accès rapide au contenu (RGAA 12.7), visible seulement au focus clavier. */
export function SkipLink() {
  return (
    <a
      href="#contenu"
      className="sr-only z-[300] rounded bg-surface px-3 py-2 text-primary shadow-pop focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
    >
      Aller au contenu
    </a>
  );
}

/** Barre latérale pétrole (`.sidebar`, l. 88-94). */
export function Sidebar({ appName, children, bottom }: { appName: string; children: ReactNode; bottom?: ReactNode }) {
  return (
    <aside className="sticky top-0 flex h-screen flex-col gap-1 self-start overflow-y-auto bg-petrol-900 px-3 py-[18px] text-slate-100 print:hidden">
      <div className="flex items-center gap-2.5 px-1 pb-3.5 pt-0.5">
        <BrandChip />
        <span className="text-13 font-semibold text-slate-100">{appName}</span>
      </div>
      <nav aria-label="Navigation principale" className="flex flex-col gap-1">{children}</nav>
      {bottom && <div className="mt-auto border-t border-white/[.08] pt-3">{bottom}</div>}
    </aside>
  );
}

/** Intitulé de section du menu (`.nav-section > .nav-label`, l. 98-101). */
export function NavSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-2.5 flex flex-col gap-1">
      <div className="px-2.5 pb-1 pt-1.5 text-2xs uppercase tracking-[.07em] text-slate-400">{label}</div>
      {children}
    </div>
  );
}

/** Entrée de menu (`.nav-item`, `.nav-item.active`, l. 102-115). */
export function NavItem({ to, icon, children, end }: { to: string; icon: IconName; children: ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded px-2.5 py-2 font-medium no-underline transition-colors duration-100 ${
          isActive
            ? 'bg-[rgba(27,218,157,.14)] text-white shadow-[inset_3px_0_0_var(--accent)]'
            : 'text-slate-200 hover:bg-white/[.06] hover:text-white'
        }`
      }
    >
      <span className="opacity-[.85]"><Icon name={icon} /></span>
      {children}
    </NavLink>
  );
}

/** Barre de titre translucide (`.topbar`, l. 145-152) ; le titre n'est pas un h1 (la page a le sien). */
export function Topbar({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex h-topbar items-center justify-between gap-4 border-b border-line bg-white/90 px-7 backdrop-blur-[8px] print:hidden">
      <div className="text-18 font-title tracking-[-0.01em] text-ink">{title}</div>
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}

/** Pastille compte (`.avatar`, l. 160-170) : initiales sur menthe 800 + nom. */
export function AccountChip({ name, detail }: { name: string; detail?: string }) {
  const initials =
    name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '?';
  return (
    <span className="inline-flex items-center gap-2.5 rounded-full border border-line py-1 pl-3 pr-1.5 font-medium text-ink" title={detail}>
      <span className="text-13">{name}</span>
      {detail && <span className="sr-only">({detail})</span>}
      <span aria-hidden="true" className="grid h-[30px] w-[30px] place-items-center rounded-full bg-mint-800 text-xs font-bold text-white">
        {initials}
      </span>
    </span>
  );
}

/** Zone de contenu (`.content`, `.content-inner`, l. 153-157). */
export function PageContent({ children }: { children: ReactNode }) {
  return (
    <main id="contenu" tabIndex={-1} className="flex-1 px-7 pb-10 pt-6 outline-none">
      <div className="mx-auto max-w-content">{children}</div>
    </main>
  );
}

/** Pied de page légal (components/Footer.tsx ; `.footer`, l. 188-194). */
export function LegalFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-line bg-surface px-7 py-[18px] text-xs text-ink-faint print:hidden">
      <div className="mx-auto flex max-w-content flex-wrap items-center gap-x-3.5 gap-y-1">
        <strong className="font-semibold text-ink-muted">LSI</strong>
        <span>SAS au capital de 5 000 €</span>
        <span>· RCS Aix-en-Provence 821 439 379</span>
        <span>· SIRET 821 439 379 00057</span>
        <span>· TVA FR72 821 439 379</span>
        <span>· APE 6202A</span>
        <span>· 849 rue de la Gare, 13770 Venelles</span>
        <span className="ml-auto">© {year} LSI Maintenance</span>
      </div>
    </footer>
  );
}

/** Coquille complète : grille barre latérale 248 px + colonne principale (`.shell`, l. 83). */
export function Shell({ sidebar, topbar, children }: { sidebar: ReactNode; topbar: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-screen grid-cols-[var(--sidebar-w)_1fr] print:block">
      <SkipLink />
      {sidebar}
      <div className="flex min-w-0 flex-col">
        {topbar}
        <PageContent>{children}</PageContent>
        <LegalFooter />
      </div>
    </div>
  );
}

/** Écran d'authentification centré (`.auth-wrap`, `.auth-card`, l. 410-412 ; pages/Login.tsx). */
export function AuthScreen({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-[radial-gradient(1200px_500px_at_50%_-10%,var(--mint-50),var(--bg)_60%)] p-6">
      <main className="flex w-[360px] max-w-full flex-col gap-3.5 rounded-lg border border-line bg-surface p-5 shadow-md">
        <div className="self-center"><BrandChip size="lg" /></div>
        <div className="text-center">
          <h1 className="text-[20px]">{title}</h1>
          {subtitle && <p className="text-ink-muted">{subtitle}</p>}
        </div>
        {children}
        <p className="mt-1 text-center text-13 text-ink-faint">LSI Maintenance · RCS Aix-en-Provence 821 439 379</p>
      </main>
    </div>
  );
}
