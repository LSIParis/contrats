import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { RequireAuth } from './shell/require-auth.js';
import { AppShell } from './shell/app-shell.js';

export function App() {
  return (
    <BrowserRouter>
      <RequireAuth>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<div>Tableau de bord</div>} />
            <Route path="/contracts" element={<div>Contrats</div>} />
            <Route path="/reminders" element={<div>Rappels</div>} />
          </Route>
        </Routes>
      </RequireAuth>
    </BrowserRouter>
  );
}
