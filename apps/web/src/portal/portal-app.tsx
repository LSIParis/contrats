import { Routes, Route, Navigate } from 'react-router-dom';
import { PortalLoginPage } from './portal-login-page.js';
import { PortalLayout } from './portal-layout.js';
import { PortalContractsPage } from './portal-contracts-page.js';
import { PortalContractPage } from './portal-contract-page.js';

export function PortalApp() {
  return (
    <Routes>
      <Route path="login" element={<PortalLoginPage />} />
      <Route element={<PortalLayout />}>
        <Route path="contracts" element={<PortalContractsPage />} />
        <Route path="contracts/:id" element={<PortalContractPage />} />
        <Route index element={<Navigate to="contracts" replace />} />
      </Route>
    </Routes>
  );
}
