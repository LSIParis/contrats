import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { RequireAuth } from './shell/require-auth.js';
import { AppShell } from './shell/app-shell.js';
import { DashboardPage } from './features/dashboard/dashboard-page.js';
import { ContractsPage } from './features/contracts/contracts-page.js';
import { ContractNewPage } from './features/contracts/contract-new-page.js';
import { ContractDetailPage } from './features/contracts/contract-detail-page.js';
import { ContractEditPage } from './features/contracts/contract-edit-page.js';
import { CustomersPage } from './features/customers/customers-page.js';
import { CustomerNewPage } from './features/customers/customer-new-page.js';
import { CustomerDetailPage } from './features/customers/customer-detail-page.js';

export function App() {
  return (
    <BrowserRouter>
      <RequireAuth>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/customers/new" element={<CustomerNewPage />} />
            <Route path="/customers/:id" element={<CustomerDetailPage />} />
            <Route path="/contracts" element={<ContractsPage />} />
            <Route path="/contracts/new" element={<ContractNewPage />} />
            <Route path="/contracts/:id/edit" element={<ContractEditPage />} />
            <Route path="/contracts/:id" element={<ContractDetailPage />} />
            <Route path="/reminders" element={<div>Rappels</div>} />
          </Route>
        </Routes>
      </RequireAuth>
    </BrowserRouter>
  );
}
