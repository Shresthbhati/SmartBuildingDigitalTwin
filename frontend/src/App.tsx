import { Navigate, Route, Routes } from 'react-router-dom';
import { AnticipatePage } from './anticipate/AnticipatePage';
import { ExperimentPage } from './scenario/ScenarioWorkbench';
import { InvestigatePage } from './pages/InvestigatePage';
import { ObservePage } from './pages/ObservePage';
import { SystemPage } from './pages/SystemPage';
import { Shell } from './shell/Shell';

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/observe" replace />} />
        <Route path="/observe" element={<ObservePage />} />
        <Route path="/investigate" element={<InvestigatePage />} />
        <Route path="/anticipate" element={<AnticipatePage />} />
        <Route path="/experiment" element={<ExperimentPage />} />
        <Route path="/system" element={<SystemPage />} />
        <Route path="*" element={<Navigate to="/observe" replace />} />
      </Route>
    </Routes>
  );
}
