import { Routes, Route, Navigate } from 'react-router-dom';
import { useProjectStore } from './store/project-store';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import NewProjectPage from './pages/NewProjectPage';
import PlanningPage from './pages/PlanningPage';
import GeneratePage from './pages/GeneratePage';
import RefineCodePage from './pages/RefineCodePage';
import DataGeneratorPage from './pages/DataGeneratorPage';
import DeployPage from './pages/DeployPage';
import PublishPage from './pages/PublishPage';
import SettingsPage from './pages/SettingsPage';

function App() {
  const currentProject = useProjectStore(state => state.currentProject);

  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="new" element={<NewProjectPage />} />
        <Route path="settings" element={<SettingsPage />} />
        
        {/* Project-specific routes */}
        {currentProject && (
          <>
            <Route path="project/:projectId/plan" element={<PlanningPage />} />
            <Route path="project/:projectId/generate" element={<GeneratePage />} />
            <Route path="project/:projectId/refine" element={<RefineCodePage />} />
            <Route path="project/:projectId/data" element={<DataGeneratorPage />} />
            <Route path="project/:projectId/deploy" element={<DeployPage />} />
            <Route path="project/:projectId/publish" element={<PublishPage />} />
          </>
        )}
        
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default App;
