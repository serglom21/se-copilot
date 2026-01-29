import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';

export default function GeneratePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { currentProject, loadProject, generateApp, generateGuide, generateDashboard, generateDataScript } = useProjectStore();
  
  const [status, setStatus] = useState({
    app: { generated: false, loading: false, path: '' },
    guide: { generated: false, loading: false, path: '' },
    dashboard: { generated: false, loading: false, path: '' },
    dataScript: { generated: false, loading: false, path: '' }
  });

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
    }
  }, [projectId]);

  // Check if artifacts exist on mount
  useEffect(() => {
    if (currentProject) {
      // Set status based on project state
      if (currentProject.status === 'generated' || currentProject.status === 'published') {
        setStatus({
          app: { generated: true, loading: false, path: '' },
          guide: { generated: true, loading: false, path: '' },
          dashboard: { generated: true, loading: false, path: '' },
          dataScript: { generated: true, loading: false, path: '' }
        });
      }
    }
  }, [currentProject]);

  const handleGenerateApp = async () => {
    setStatus(s => ({ ...s, app: { ...s.app, loading: true } }));
    try {
      const result = await generateApp();
      if (result.success) {
        setStatus(s => ({
          ...s,
          app: { generated: true, loading: false, path: result.outputPath || '' }
        }));
        
        // Update project status
        if (currentProject) {
          await window.electronAPI.updateProject(currentProject.id, { status: 'generated' });
          await loadProject(currentProject.id);
        }
        
        alert('Reference app generated successfully!');
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      alert('Error generating app: ' + error);
      setStatus(s => ({ ...s, app: { ...s.app, loading: false } }));
    }
  };

  const handleGenerateGuide = async () => {
    setStatus(s => ({ ...s, guide: { ...s.guide, loading: true } }));
    try {
      const result = await generateGuide();
      if (result.success) {
        setStatus(s => ({
          ...s,
          guide: { generated: true, loading: false, path: result.outputPath || '' }
        }));
        alert('Implementation guide generated successfully!');
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      alert('Error generating guide: ' + error);
      setStatus(s => ({ ...s, guide: { ...s.guide, loading: false } }));
    }
  };

  const handleGenerateDashboard = async () => {
    setStatus(s => ({ ...s, dashboard: { ...s.dashboard, loading: true } }));
    try {
      const result = await generateDashboard();
      if (result.success) {
        setStatus(s => ({
          ...s,
          dashboard: { generated: true, loading: false, path: result.outputPath || '' }
        }));
        alert('Dashboard JSON generated successfully!');
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      alert('Error generating dashboard: ' + error);
      setStatus(s => ({ ...s, dashboard: { ...s.dashboard, loading: false } }));
    }
  };

  const handleGenerateDataScript = async () => {
    setStatus(s => ({ ...s, dataScript: { ...s.dataScript, loading: true } }));
    try {
      const result = await generateDataScript();
      if (result.success) {
        setStatus(s => ({
          ...s,
          dataScript: { generated: true, loading: false, path: result.outputPath || '' }
        }));
        alert('Data generation script created successfully!');
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      alert('Error generating data script: ' + error);
      setStatus(s => ({ ...s, dataScript: { ...s.dataScript, loading: false } }));
    }
  };

  const handleGenerateAll = async () => {
    setStatus({
      app: { generated: false, loading: true, path: '' },
      guide: { generated: false, loading: true, path: '' },
      dashboard: { generated: false, loading: true, path: '' },
      dataScript: { generated: false, loading: true, path: '' }
    });

    try {
      // Generate all artifacts
      const appResult = await generateApp();
      if (appResult.success) {
        setStatus(s => ({ ...s, app: { generated: true, loading: false, path: appResult.outputPath || '' } }));
      }

      const guideResult = await generateGuide();
      if (guideResult.success) {
        setStatus(s => ({ ...s, guide: { generated: true, loading: false, path: guideResult.outputPath || '' } }));
      }

      const dashboardResult = await generateDashboard();
      if (dashboardResult.success) {
        setStatus(s => ({ ...s, dashboard: { generated: true, loading: false, path: dashboardResult.outputPath || '' } }));
      }

      const dataScriptResult = await generateDataScript();
      if (dataScriptResult.success) {
        setStatus(s => ({ ...s, dataScript: { generated: true, loading: false, path: dataScriptResult.outputPath || '' } }));
      }

      // Update project status to 'generated'
      if (currentProject) {
        await window.electronAPI.updateProject(currentProject.id, { status: 'generated' });
        await loadProject(currentProject.id);
      }

      alert('All artifacts generated successfully!');
    } catch (error) {
      alert('Error during generation: ' + error);
    }
  };

  const allGenerated = status.app.generated && status.guide.generated && status.dashboard.generated && status.dataScript.generated;

  if (!currentProject) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Generate Artifacts</h1>
        <p className="text-gray-600">
          Generate reference app, implementation guide, and dashboard JSON
        </p>
      </div>

      {/* Summary */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">Project Summary</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="font-medium text-gray-700">Name:</span>
            <span className="ml-2">{currentProject.project.name}</span>
          </div>
          <div>
            <span className="font-medium text-gray-700">Vertical:</span>
            <span className="ml-2">{currentProject.project.vertical}</span>
          </div>
          <div>
            <span className="font-medium text-gray-700">Stack:</span>
            <span className="ml-2">Next.js + Express</span>
          </div>
          <div>
            <span className="font-medium text-gray-700">Custom Spans:</span>
            <span className="ml-2">{currentProject.instrumentation.spans.length}</span>
          </div>
        </div>
      </div>

      {/* Generation Cards */}
      <div className="space-y-4 mb-6">
        <GenerationCard
          icon="🏗️"
          title="Reference Application"
          description="Next.js frontend + Express backend with Sentry SDK and custom instrumentation"
          status={status.app}
          onGenerate={handleGenerateApp}
        />

        <GenerationCard
          icon="📝"
          title="Implementation Guide"
          description="Markdown documentation explaining the instrumentation and how to validate it"
          status={status.guide}
          onGenerate={handleGenerateGuide}
        />

        <GenerationCard
          icon="📊"
          title="Dashboard JSON"
          description="Sentry dashboard configuration file based on your instrumentation plan"
          status={status.dashboard}
          onGenerate={handleGenerateDashboard}
        />

        <GenerationCard
          icon="🎲"
          title="Data Generation Script"
          description="Python script to generate realistic test data with custom spans and attributes"
          status={status.dataScript}
          onGenerate={handleGenerateDataScript}
        />
      </div>

      {/* Actions */}
      <div className="flex gap-4">
        <Button size="lg" onClick={handleGenerateAll} className="flex-1">
          🚀 Generate All
        </Button>
        {allGenerated && (
          <Button
            size="lg"
            onClick={() => navigate(`/project/${currentProject.id}/publish`)}
          >
            Next: Publish →
          </Button>
        )}
      </div>
    </div>
  );
}

interface GenerationCardProps {
  icon: string;
  title: string;
  description: string;
  status: { generated: boolean; loading: boolean; path: string };
  onGenerate: () => void;
}

function GenerationCard({ icon, title, description, status, onGenerate }: GenerationCardProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-3xl">{icon}</span>
            <h3 className="text-xl font-semibold text-gray-900">{title}</h3>
          </div>
          <p className="text-gray-600 mb-4">{description}</p>
          {status.generated && status.path && (
            <div className="text-sm text-green-600 font-medium">
              ✓ Generated: {status.path}
            </div>
          )}
        </div>
        <Button
          onClick={onGenerate}
          disabled={status.loading}
          variant={status.generated ? 'secondary' : 'primary'}
        >
          {status.loading ? '⏳ Generating...' : status.generated ? 'Regenerate' : 'Generate'}
        </Button>
      </div>
    </div>
  );
}
