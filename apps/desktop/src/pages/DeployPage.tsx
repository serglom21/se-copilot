import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';
import TroubleshootingChat from '../components/TroubleshootingChat';

interface DeploymentStatus {
  frontend: {
    running: boolean;
    url: string;
    port: number;
  };
  backend: {
    running: boolean;
    url: string;
    port: number;
  };
}

export default function DeployPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { currentProject, loadProject } = useProjectStore();
  
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [showChat, setShowChat] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  // Mobile-specific state
  const [snackUrl, setSnackUrl] = useState<string | null>(null);
  const [snackEmbedUrl, setSnackEmbedUrl] = useState<string | null>(null);
  const [creatingSnack, setCreatingSnack] = useState(false);
  
  const isMobile = currentProject?.stack?.type === 'mobile';
  const isBackendOnly = currentProject?.stack?.type === 'backend-only';

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
    }
  }, [projectId, loadProject]);

  useEffect(() => {
    if (projectId && currentProject) {
      if (isMobile) {
        checkSnackStatus();
      } else if (!isBackendOnly) {
        checkStatus();
      } else {
        // Backend-only: check deployment status
        checkStatus();
      }
    }
  }, [projectId, isMobile, isBackendOnly]);

  const checkSnackStatus = async () => {
    if (!projectId) return;
    const snackStatus = await window.electronAPI.getExpoSnackStatus(projectId);
    if (snackStatus.hasSnack && snackStatus.url && snackStatus.embedUrl) {
      setSnackUrl(snackStatus.url);
      setSnackEmbedUrl(snackStatus.embedUrl);
    }
  };

  useEffect(() => {
    // Set up output listeners
    const cleanupOutput = window.electronAPI.onDeployOutput((data) => {
      setOutput(prev => [...prev, data]);
    });

    const cleanupError = window.electronAPI.onDeployError((error) => {
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

  const checkStatus = async () => {
    if (!projectId) return;
    const deploymentStatus = await window.electronAPI.getDeploymentStatus(projectId);
    setStatus(deploymentStatus);
  };

  const handleDeploy = async () => {
    if (!projectId) return;

    setDeploying(true);
    setOutput(['🚀 Initializing deployment...\n\n']);

    try {
      const result = await window.electronAPI.startDeployment(projectId);
      
      if (result.success && result.status) {
        setStatus(result.status);
        setOutput(prev => [...prev, '\n✅ Deployment complete! Browser will open automatically.\n']);
      } else {
        setOutput(prev => [...prev, `\n❌ Deployment failed: ${result.error}\n`]);
      }
    } catch (error) {
      setOutput(prev => [...prev, `\n❌ Error: ${error}\n`]);
    } finally {
      setDeploying(false);
      await checkStatus();
    }
  };

  const handleStop = async () => {
    if (!projectId) return;
    
    setOutput(prev => [...prev, '\n🛑 Stopping servers...\n']);
    await window.electronAPI.stopDeployment(projectId);
    setStatus(null);
    setOutput(prev => [...prev, '✅ Servers stopped\n']);
  };

  const handleClearOutput = () => {
    setOutput([]);
  };

  const handleOpenUrl = (url: string) => {
    window.open(url, '_blank');
  };

  const handleCreateSnack = async () => {
    if (!projectId) return;

    setCreatingSnack(true);
    setOutput(['📱 Creating Expo Snack...\n\n']);

    try {
      const result = await window.electronAPI.createExpoSnack(projectId);
      setSnackUrl(result.url);
      setSnackEmbedUrl(result.embedUrl);
      setOutput(prev => [...prev, `✅ Snack created successfully!\n\n🔗 URL: ${result.url}\n\nYou can now test your app in the browser simulator below, or scan the QR code with the Expo Go app on your mobile device.\n`]);
    } catch (error) {
      setOutput(prev => [...prev, `❌ Error creating Snack: ${error}\n`]);
      setErrors(prev => [...prev, String(error)]);
    } finally {
      setCreatingSnack(false);
    }
  };

  const handleUpdateSnack = async () => {
    if (!projectId) return;

    setCreatingSnack(true);
    setOutput(prev => [...prev, '\n🔄 Updating Expo Snack...\n\n']);

    try {
      const result = await window.electronAPI.updateExpoSnack(projectId);
      setOutput(prev => [...prev, `✅ Snack updated successfully!\n\nThe simulator below will reload with your latest changes.\n`]);
    } catch (error) {
      setOutput(prev => [...prev, `❌ Error updating Snack: ${error}\n`]);
      setErrors(prev => [...prev, String(error)]);
    } finally {
      setCreatingSnack(false);
    }
  };

  const handleOpenSnack = () => {
    if (snackUrl) {
      window.electronAPI.openExpoUrl(snackUrl);
    }
  };

  if (!currentProject) {
    return <div className="p-8">Loading...</div>;
  }

  const isRunning = status && (status.frontend.running || status.backend.running);

  // Render mobile deployment UI
  if (isMobile) {
    return (
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-gray-200">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">📱 Mobile Deployment</h1>
          <p className="text-gray-600">
            Deploy your React Native app to Expo Snack for browser-based testing
          </p>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Left: Controls */}
          <div className="w-1/3 border-r border-gray-200 p-6 overflow-y-auto">
            <h2 className="text-xl font-semibold mb-4">Controls</h2>

            <div className="space-y-4 mb-6">
              {!snackUrl ? (
                <Button 
                  onClick={handleCreateSnack} 
                  disabled={creatingSnack}
                  size="lg"
                  className="w-full"
                >
                  {creatingSnack ? '⏳ Creating Snack...' : '📱 Create Expo Snack'}
                </Button>
              ) : (
                <>
                  <Button 
                    onClick={handleOpenSnack}
                    size="lg"
                    className="w-full"
                  >
                    🔗 Open in New Tab
                  </Button>

                  <Button 
                    onClick={handleUpdateSnack}
                    variant="secondary"
                    size="lg"
                    className="w-full"
                    disabled={creatingSnack}
                  >
                    {creatingSnack ? '⏳ Updating...' : '🔄 Update Snack'}
                  </Button>
                </>
              )}

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

            {/* Info */}
            <div className="bg-purple-50 p-4 rounded-lg text-sm text-purple-800">
              <strong>About Expo Snack:</strong>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Browser-based React Native simulator</li>
                <li>No Xcode or Android Studio needed</li>
                <li>Test on real device with Expo Go app</li>
                <li>Shareable link for demos</li>
              </ul>
            </div>

            {snackUrl && (
              <div className="mt-4 bg-blue-50 p-4 rounded-lg text-sm text-blue-800">
                <strong>📲 Test on your phone:</strong>
                <p className="mt-2">
                  Install <strong>Expo Go</strong> app and scan the QR code in the simulator to test on your actual device!
                </p>
              </div>
            )}

            <div className="mt-4 bg-yellow-50 p-4 rounded-lg text-sm text-yellow-800">
              <strong>⚠️ Note:</strong> Make sure you've generated the mobile app first in the "Generate" tab!
            </div>

            {/* Console Output */}
            <div className="mt-6">
              <h3 className="text-lg font-semibold mb-2">Console</h3>
              <div 
                ref={outputRef}
                className="p-4 bg-gray-900 text-green-400 font-mono text-xs rounded-lg h-64 overflow-y-auto whitespace-pre-wrap"
              >
                {output.length === 0 ? (
                  <div className="text-gray-500 text-center py-8">
                    Output will appear here
                  </div>
                ) : (
                  output.map((line, idx) => (
                    <div key={idx}>{line}</div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right: Snack Simulator */}
          <div className="flex-1 flex flex-col bg-gray-100">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold">Expo Snack Simulator</h2>
            </div>

            <div className="flex-1 flex items-center justify-center p-6">
              {snackEmbedUrl ? (
                <iframe
                  src={snackEmbedUrl}
                  className="w-full h-full rounded-lg shadow-lg border-2 border-gray-300"
                  title="Expo Snack"
                  allow="accelerometer; camera; encrypted-media; geolocation; gyroscope; microphone; usb; xr-spatial-tracking"
                  sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-downloads"
                />
              ) : (
                <div className="text-center text-gray-500">
                  <div className="text-6xl mb-4">📱</div>
                  <p className="text-lg">Click "Create Expo Snack" to deploy your mobile app</p>
                  <p className="text-sm mt-2">The simulator will appear here</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* AI Troubleshooting Chat */}
        {showChat && projectId && (
          <TroubleshootingChat
            context={{
              phase: 'deployment',
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

  // Render web or backend-only deployment UI
  const headerIcon = isBackendOnly ? '🐍' : '🌐';
  const headerTitle = isBackendOnly 
    ? `${currentProject?.stack.backend === 'flask' ? 'Flask' : 'FastAPI'} Backend Deployment`
    : 'Web Deployment';
  const headerDescription = isBackendOnly
    ? 'Start the Python backend API locally for testing'
    : 'Start the reference app locally for testing and demos';

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-6 border-b border-gray-200">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">{headerIcon} {headerTitle}</h1>
        <p className="text-gray-600">
          {headerDescription}
        </p>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: Controls & Status */}
        <div className="w-1/2 border-r border-gray-200 p-6 overflow-y-auto">
          <h2 className="text-xl font-semibold mb-4">Controls</h2>

          <div className="space-y-4 mb-6">
            <Button 
              onClick={handleDeploy} 
              disabled={deploying || isRunning}
              size="lg"
              className="w-full"
            >
              {deploying ? '⏳ Deploying...' : '🚀 Deploy & Run'}
            </Button>

            {isRunning && (
              <Button 
                onClick={handleStop}
                variant="danger"
                size="lg"
                className="w-full"
              >
                🛑 Stop Servers
              </Button>
            )}

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

          {/* Status Cards */}
          {status && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Server Status</h3>

              {/* Frontend Status */}
              <div className={`p-4 rounded-lg border-2 ${
                status.frontend.running 
                  ? 'bg-green-50 border-green-300' 
                  : 'bg-gray-50 border-gray-300'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">🌐</span>
                    <span className="font-semibold">Frontend</span>
                  </div>
                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                    status.frontend.running
                      ? 'bg-green-200 text-green-800'
                      : 'bg-gray-200 text-gray-800'
                  }`}>
                    {status.frontend.running ? 'RUNNING' : 'STOPPED'}
                  </span>
                </div>
                {status.frontend.running && (
                  <>
                    <div className="text-sm text-gray-600 mb-2">
                      {status.frontend.url}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => handleOpenUrl(status.frontend.url)}
                    >
                      Open in Browser →
                    </Button>
                  </>
                )}
              </div>

              {/* Backend Status */}
              <div className={`p-4 rounded-lg border-2 ${
                status.backend.running 
                  ? 'bg-green-50 border-green-300' 
                  : 'bg-gray-50 border-gray-300'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">{isBackendOnly ? '🐍' : '🔧'}</span>
                    <span className="font-semibold">
                      {isBackendOnly 
                        ? `${currentProject?.stack.backend === 'flask' ? 'Flask' : 'FastAPI'} Backend`
                        : 'Backend API'
                      }
                    </span>
                  </div>
                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                    status.backend.running
                      ? 'bg-green-200 text-green-800'
                      : 'bg-gray-200 text-gray-800'
                  }`}>
                    {status.backend.running ? 'RUNNING' : 'STOPPED'}
                  </span>
                </div>
                {status.backend.running && (
                  <>
                    <div className="text-sm text-gray-600 mb-2">
                      {status.backend.url}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleOpenUrl(status.backend.url)}
                      >
                        Open API →
                      </Button>
                      {isBackendOnly && currentProject?.stack.backend === 'fastapi' && (
                        <Button
                          size="sm"
                          onClick={() => handleOpenUrl(`${status.backend.url}/docs`)}
                        >
                          📚 API Docs →
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Info */}
          <div className="mt-6 bg-blue-50 p-4 rounded-lg text-sm text-blue-800">
            <strong>What happens on deploy:</strong>
            <ol className="list-decimal list-inside mt-2 space-y-1">
              {isBackendOnly ? (
                <>
                  <li>Create Python virtual environment (if needed)</li>
                  <li>Install Python dependencies via pip</li>
                  <li>Start {currentProject?.stack.backend === 'flask' ? 'Flask' : 'FastAPI'} server</li>
                  <li>Auto-open {currentProject?.stack.backend === 'fastapi' ? 'API docs' : 'API'} in browser</li>
                </>
              ) : (
                <>
                  <li>Install npm dependencies (frontend + backend)</li>
                  <li>Start backend server on port 3001</li>
                  <li>Start frontend server on port 3000</li>
                  <li>Auto-open browser to your app</li>
                </>
              )}
            </ol>
          </div>

          <div className="mt-4 bg-yellow-50 p-4 rounded-lg text-sm text-yellow-800">
            <strong>💡 Pro tip:</strong> Generate test data before deploying to see live data in your Sentry dashboard as you use the app!
          </div>
        </div>

        {/* Right: Output Console */}
        <div className="w-1/2 flex flex-col">
          <div className="p-6 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-xl font-semibold">Console Output</h2>
            <Button 
              size="sm" 
              variant="secondary" 
              onClick={handleClearOutput}
              disabled={deploying}
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
                <div className="text-4xl mb-4">🖥️</div>
                <p>Console output will appear here</p>
                <p className="text-xs mt-2">Click "Deploy & Run" to start</p>
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
            phase: 'deployment',
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
