import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';
import { Input } from '../components/Input';
import TroubleshootingChat from '../components/TroubleshootingChat';

export default function DataGeneratorPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { currentProject, loadProject } = useProjectStore();
  
  const [config, setConfig] = useState({
    frontendDsn: '',
    backendDsn: '',
    numTraces: 100,
    numErrors: 20,
    environment: 'development'
  });

  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [showChat, setShowChat] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
    }
  }, [projectId, loadProject]);

  useEffect(() => {
    // Set up output listeners
    const cleanupOutput = window.electronAPI.onDataOutput((data) => {
      setOutput(prev => [...prev, data]);
    });

    const cleanupError = window.electronAPI.onDataError((error) => {
      const errorMsg = `❌ ERROR: ${error}\n`;
      setOutput(prev => [...prev, errorMsg]);
      setErrors(prev => [...prev, error]);
    });

    return () => {
      cleanupOutput();
      cleanupError();
    };
  }, []);

  useEffect(() => {
    // Auto-scroll to bottom
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleRun = async () => {
    if (!projectId) return;
    
    if (!config.frontendDsn && !config.backendDsn) {
      alert('Please provide at least one Sentry DSN');
      return;
    }

    setRunning(true);
    setOutput(['🚀 Initializing data generation...\n\n']);

    try {
      const result = await window.electronAPI.runDataGenerator(projectId, config);
      
      if (result.success) {
        setOutput(prev => [...prev, '\n✅ Complete! Check your Sentry dashboard.\n']);
        // Refresh project state to ensure UI is in sync
        await loadProject(projectId);
      } else {
        setOutput(prev => [...prev, `\n❌ Failed: ${result.error}\n`]);
      }
    } catch (error) {
      setOutput(prev => [...prev, `\n❌ Error: ${error}\n`]);
    } finally {
      setRunning(false);
    }
  };

  const handleClearOutput = () => {
    setOutput([]);
  };

  if (!currentProject) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-6 border-b border-gray-200">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Run Data Generator</h1>
        <p className="text-gray-600">
          Generate realistic test data to populate your Sentry dashboard
        </p>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: Configuration */}
        <div className="w-1/2 border-r border-gray-200 p-6 overflow-y-auto">
          <h2 className="text-xl font-semibold mb-4">Configuration</h2>

          <div className="space-y-4 mb-6">
            <Input
              label="Frontend DSN"
              placeholder="https://...@sentry.io/..."
              value={config.frontendDsn}
              onChange={e => setConfig({ ...config, frontendDsn: e.target.value })}
            />

            <Input
              label="Backend DSN"
              placeholder="https://...@sentry.io/..."
              value={config.backendDsn}
              onChange={e => setConfig({ ...config, backendDsn: e.target.value })}
            />

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Number of Traces"
                type="number"
                min="1"
                value={config.numTraces}
                onChange={e => setConfig({ ...config, numTraces: parseInt(e.target.value) || 100 })}
              />

              <Input
                label="Number of Errors"
                type="number"
                min="1"
                value={config.numErrors}
                onChange={e => setConfig({ ...config, numErrors: parseInt(e.target.value) || 20 })}
              />
            </div>

            <Input
              label="Environment"
              placeholder="development"
              value={config.environment}
              onChange={e => setConfig({ ...config, environment: e.target.value })}
            />
          </div>

          <div className="bg-blue-50 p-4 rounded-lg text-sm text-blue-800 mb-6">
            <strong>What will be generated:</strong>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>{currentProject.instrumentation.spans.filter(s => s.layer === 'frontend').length} frontend custom spans</li>
              <li>{currentProject.instrumentation.spans.filter(s => s.layer === 'backend').length} backend custom spans</li>
              <li>Realistic attributes with fake data</li>
              <li>PII automatically redacted</li>
              <li>Variety of success/error outcomes</li>
            </ul>
          </div>

          <div className="bg-yellow-50 p-4 rounded-lg text-sm text-yellow-800 mb-6">
            <strong>Requirements:</strong>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Python 3.7+ installed</li>
              <li>Script generated (click Generate Data Script first)</li>
              <li>Valid Sentry DSN(s)</li>
            </ul>
          </div>

          <div className="space-y-3">
            <Button 
              onClick={handleRun} 
              disabled={running}
              size="lg"
              className="w-full"
            >
              {running ? '⏳ Generating Data...' : '🚀 Run Data Generator'}
            </Button>

            {(errors.length > 0 || output.length > 0) && (
              <Button 
                onClick={() => setShowChat(true)}
                variant="secondary"
                size="lg"
                className="w-full"
              >
                🤖 Ask AI for Help
              </Button>
            )}
          </div>
        </div>

        {/* Right: Output */}
        <div className="w-1/2 flex flex-col">
          <div className="p-6 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-xl font-semibold">Output</h2>
            <Button 
              size="sm" 
              variant="secondary" 
              onClick={handleClearOutput}
              disabled={running}
            >
              Clear
            </Button>
          </div>

          <div 
            ref={outputRef}
            className="flex-1 p-6 bg-gray-900 text-green-400 font-mono text-sm overflow-y-auto whitespace-pre-wrap"
          >
            {output.length === 0 ? (
              <div className="text-gray-500 text-center py-12">
                Output will appear here when you run the generator
              </div>
            ) : (
              output.map((line, idx) => (
                <div key={idx}>{line}</div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* AI Troubleshooting Chat */}
      {showChat && projectId && (
        <TroubleshootingChat
          context={{
            phase: 'data-generation',
            projectId,
            errors,
            output
          }}
          onClose={() => setShowChat(false)}
        />
      )}
    </div>
  );
}
