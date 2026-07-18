import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { RequireAuth } from './shell/require-auth.js';
import { AppShell } from './shell/app-shell.js';
import { DashboardPage } from './features/dashboard/dashboard-page.js';
import { ContractsPage } from './features/contracts/contracts-page.js';
import { ContractDetailPage } from './features/contracts/contract-detail-page.js';

export function App() {
  return (
    <BrowserRouter>
      <RequireAuth>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/contracts" element={<ContractsPage />} />
            <Route path="/contracts/:id" element={<ContractDetailPage />} />
            <Route path="/reminders" element={<div>Rappels</div>} />
          </Route>
        </Routes>
      </RequireAuth>
    </BrowserRouter>
  );
}
