import { useState } from 'react';
import { canDo } from '../../lib/permissions.js';
import { useMe } from '../../lib/queries.js';
import { Breadcrumb } from '../../ui/breadcrumb.js';
import { Spinner } from '../../ui/spinner.js';
import { Tabs, type TabDef } from '../../ui/tabs.js';
import { IndexesPanel } from './indexes-panel.js';
import { QuotePanel } from './quote-panel.js';
import { RulesPanel } from './rules-panel.js';

/**
 * Référentiels de tarification (`/pricing`) : indices et catalogue de règles
 * (lecture pour tout interne, écriture MSP_ADMIN), devis rapide
 * (`pricing.simulate`). Le barème de chaque contrat se gère sur sa fiche
 * (onglet Tarification).
 */
export function PricingCatalogPage() {
  const me = useMe();
  const [tab, setTab] = useState('indices');
  if (me.isLoading) return <Spinner />;
  const canQuote = canDo(me.data, 'pricing.simulate');
  const tabs: TabDef[] = [
    { id: 'indices', label: 'Indices' },
    { id: 'regles', label: 'Règles' },
    ...(canQuote ? [{ id: 'devis', label: 'Devis' }] : []),
  ];
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: 'Tarification' }]} />
      <h1>Tarification — référentiels</h1>
      <p className="text-13 text-ink-muted">Le barème, les révisions et le simulateur de chaque contrat se trouvent dans l’onglet « Tarification » de sa fiche.</p>
      <Tabs
        label="Référentiels de tarification"
        tabs={tabs}
        active={tabs.some((t) => t.id === tab) ? tab : 'indices'}
        onChange={setTab}
        panels={{
          indices: <IndexesPanel canManage={canDo(me.data, 'pricing.indexes.manage')} />,
          regles: <RulesPanel canManage={canDo(me.data, 'pricing.rules.manage')} />,
          devis: canQuote ? <QuotePanel /> : null,
        }}
      />
    </div>
  );
}
