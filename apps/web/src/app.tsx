import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { RequireAuth } from './shell/require-auth.js';
import { AppShell } from './shell/app-shell.js';
import { DashboardPage } from './features/dashboard/dashboard-page.js';
import { ContractsPage } from './features/contracts/contracts-page.js';
import { ContractNewPage } from './features/contracts/contract-new-page.js';
import { ContractImportPage } from './features/contracts/contract-import-page.js';
import { ImportValidationPage } from './features/imports/import-validation-page.js';
import { SettingsPage } from './features/settings/settings-page.js';
import { ApiClientsPage } from './features/settings/api-clients-page.js';
import { WebhooksPage } from './features/settings/webhooks-page.js';
import { PricingCatalogPage } from './features/pricing/pricing-catalog-page.js';
import { ContractDetailPage } from './features/contracts/contract-detail-page.js';
import { ContractEditPage } from './features/contracts/contract-edit-page.js';
import { VersionsPage } from './features/contracts/versions-page.js';
import { CustomersPage } from './features/customers/customers-page.js';
import { CustomerNewPage } from './features/customers/customer-new-page.js';
import { CustomerDetailPage } from './features/customers/customer-detail-page.js';
import { UsersPage } from './features/users/users-page.js';
import { AuditPage } from './features/audit/audit-page.js';
import { TemplatesPage } from './features/templates/templates-page.js';
import { TemplateDetailPage } from './features/templates/template-detail-page.js';
import { PortalApp } from './portal/portal-app.js';
import { StructureEditorPage } from './features/structure/structure-editor-page.js';
import { LibraryPage } from './features/library/library-page.js';
import { RemindersPage } from './features/reminders/reminders-page.js';
import { ProposalPublicPage } from './features/proposals/public/proposal-public-page.js';
import { PendingValidationsPage } from './features/proposals/pending-validations-page.js';

function InternalRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/customers/new" element={<CustomerNewPage />} />
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
        <Route path="/contracts" element={<ContractsPage />} />
        <Route path="/contracts/new" element={<ContractNewPage />} />
        <Route path="/contracts/import" element={<ContractImportPage />} />
        <Route path="/contracts/:id/import" element={<ImportValidationPage />} />
        <Route path="/contracts/:id/edit" element={<ContractEditPage />} />
        <Route path="/contracts/:id/versions" element={<VersionsPage />} />
        <Route path="/contracts/:id/structure" element={<StructureEditorPage />} />
        <Route path="/contracts/:id" element={<ContractDetailPage />} />
        <Route path="/reminders" element={<RemindersPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/api" element={<ApiClientsPage />} />
        <Route path="/settings/webhooks" element={<WebhooksPage />} />
        <Route path="/pricing" element={<PricingCatalogPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/templates/:id" element={<TemplateDetailPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/proposal-admin/pending" element={<PendingValidationsPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/portal/*" element={<PortalApp />} />
        {/* Lot 9 : page publique d'une proposition — lien personnel, HORS session. */}
        <Route path="/p/:token" element={<ProposalPublicPage />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <InternalRoutes />
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
