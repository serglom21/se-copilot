import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';

interface Suggestion {
  file: string;
  suggestion: string;
  priority: 'high' | 'medium' | 'low';
}

export default function RefineCodePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { currentProject, loadProject } = useProjectStore();
  
  const [files, setFiles] = useState<Record<string, string>>({});
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [refinementRequest, setRefinementRequest] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
      loadFiles();
      analyzeApp();
    }
  }, [projectId]);

  const loadFiles = async () => {
    if (!projectId) return;
    try {
      const result = await window.electronAPI.readGeneratedFiles(projectId);
      setFiles(result);
      const fileKeys = Object.keys(result);
      if (fileKeys.length > 0) {
        setSelectedFile(fileKeys[0]);
      }
    } catch (error) {
      console.error('Error loading files:', error);
    }
  };

  const analyzeApp = async () => {
    if (!projectId) return;
    setAnalyzing(true);
    try {
      const result = await window.electronAPI.analyzeGeneratedApp(projectId);
      setSuggestions(result.suggestions || []);
    } catch (error) {
      console.error('Error analyzing app:', error);
      setSuggestions([]);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleRefine = async () => {
    if (!projectId || !selectedFile || !refinementRequest.trim()) {
      alert('Please select a file and enter a refinement request');
      return;
    }
    
    setLoading(true);
    try {
      const result = await window.electronAPI.refineFile(
        projectId,
        selectedFile,
        refinementRequest
      );
      
      alert(`✅ File Updated!\n\n${result.changes}\n\nThe file has been updated. You can now regenerate artifacts or push to GitHub.`);
      
      // Reload files to show new code
      await loadFiles();
      setRefinementRequest('');
      
      // Re-analyze to get new suggestions
      await analyzeApp();
    } catch (error) {
      alert('Error refining code: ' + error);
    } finally {
      setLoading(false);
    }
  };

  const handleApplySuggestion = (suggestion: Suggestion) => {
    setSelectedFile(suggestion.file);
    setRefinementRequest(suggestion.suggestion);
    window.scrollTo({ top: 300, behavior: 'smooth' });
  };

  const handleRegenerateArtifacts = async () => {
    if (!projectId) return;
    
    setRegenerating(true);
    try {
      const result = await window.electronAPI.regenerateArtifacts(projectId);
      
      if (result.success) {
        alert('✅ Artifacts Regenerated!\n\nThe Implementation Guide and Dashboard JSON have been updated with your latest code changes.');
      } else {
        alert(`⚠️ Partial Success:\n\nGuide: ${result.guideError || 'OK'}\nDashboard: ${result.dashboardError || 'OK'}`);
      }
    } catch (error) {
      alert('Error regenerating artifacts: ' + error);
    } finally {
      setRegenerating(false);
    }
  };

  const handlePushToGitHub = () => {
    if (!projectId) return;
    // Navigate to publish page for GitHub push
    navigate(`/publish/${projectId}`);
  };

  const handleUpdateSnack = async () => {
    if (!projectId || !currentProject) return;
    
    if (currentProject.stack.type !== 'mobile') {
      alert('Expo Snack is only available for mobile projects');
      return;
    }

    setLoading(true);
    try {
      const result = await window.electronAPI.updateExpoSnack(projectId);
      alert(`✅ Expo Snack Updated!\n\nYour changes are now live in the simulator.\n\nURL: ${result.url}`);
    } catch (error) {
      alert('Error updating Snack: ' + error);
    } finally {
      setLoading(false);
    }
  };

  if (!currentProject) {
    return (
      <div className="p-8">
        <div className="text-center">
          <p className="text-gray-500">Loading project...</p>
        </div>
      </div>
    );
  }

  if (Object.keys(files).length === 0) {
    return (
      <div className="p-8">
        <h1 className="text-3xl font-bold mb-6">Refine Generated Code</h1>
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-yellow-900 mb-2">No Generated Code Found</h3>
          <p className="text-yellow-800 mb-4">
            You need to generate the reference app first before you can refine it.
          </p>
          <Button onClick={() => navigate(`/generate/${projectId}`)}>
            Go to Generate Page
          </Button>
        </div>
      </div>
    );
  }

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'bg-red-50 border-red-200 text-red-900';
      case 'medium': return 'bg-yellow-50 border-yellow-200 text-yellow-900';
      case 'low': return 'bg-blue-50 border-blue-200 text-blue-900';
      default: return 'bg-gray-50 border-gray-200 text-gray-900';
    }
  };

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'high': return 'bg-red-100 text-red-800';
      case 'medium': return 'bg-yellow-100 text-yellow-800';
      case 'low': return 'bg-blue-100 text-blue-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">🔧 Refine Generated Code</h1>
        <p className="text-gray-600">
          Use AI to iteratively improve your generated app. Select a file, describe your change, and let the LLM refine the code.
        </p>
      </div>

      {/* Action Buttons Row */}
      <div className="mb-6 flex gap-3">
        <Button onClick={handleRegenerateArtifacts} disabled={regenerating}>
          {regenerating ? '⏳ Regenerating...' : '📝 Regenerate Artifacts'}
        </Button>
        <Button onClick={handlePushToGitHub}>
          🚀 Push to GitHub
        </Button>
        {currentProject.stack.type === 'mobile' && (
          <Button onClick={handleUpdateSnack} disabled={loading}>
            📱 Update Expo Snack
          </Button>
        )}
      </div>

      {/* AI Suggestions */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold">💡 AI Suggestions</h2>
          <Button onClick={analyzeApp} disabled={analyzing} variant="secondary">
            {analyzing ? '🔍 Analyzing...' : '🔄 Re-analyze'}
          </Button>
        </div>
        
        {analyzing ? (
          <div className="bg-gray-50 rounded-lg p-8 text-center">
            <div className="animate-spin inline-block w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full mb-4"></div>
            <p className="text-gray-600">Analyzing your code with AI...</p>
          </div>
        ) : suggestions.length > 0 ? (
          <div className="grid gap-3">
            {suggestions.map((s, i) => (
              <div key={i} className={`border rounded-lg p-4 ${getPriorityColor(s.priority)}`}>
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs font-semibold px-2 py-1 rounded ${getPriorityBadge(s.priority)}`}>
                        {s.priority.toUpperCase()}
                      </span>
                      <span className="font-mono text-sm">{s.file}</span>
                    </div>
                    <p className="font-medium">{s.suggestion}</p>
                  </div>
                  <Button
                    onClick={() => handleApplySuggestion(s)}
                    variant="secondary"
                    size="small"
                  >
                    Apply →
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-gray-50 rounded-lg p-6 text-center">
            <p className="text-gray-500">No suggestions available. Click "Re-analyze" to get AI recommendations.</p>
          </div>
        )}
      </div>

      {/* File Editor */}
      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
        <h2 className="text-2xl font-bold mb-4">Edit File</h2>
        
        {/* File Selector */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Select File to Refine
          </label>
          <select
            value={selectedFile}
            onChange={(e) => setSelectedFile(e.target.value)}
            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
          >
            {Object.keys(files).map(file => (
              <option key={file} value={file}>{file}</option>
            ))}
          </select>
        </div>

        {/* Current Code Preview */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-gray-700">
              Current Code ({files[selectedFile]?.split('\n').length || 0} lines)
            </label>
            <button
              onClick={() => setShowCode(!showCode)}
              className="text-sm text-purple-600 hover:text-purple-700"
            >
              {showCode ? 'Hide Code' : 'Show Code'}
            </button>
          </div>
          {showCode && (
            <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-auto max-h-96 text-xs font-mono">
              {files[selectedFile]}
            </pre>
          )}
        </div>

        {/* Refinement Request */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Describe Your Changes
          </label>
          <textarea
            value={refinementRequest}
            onChange={(e) => setRefinementRequest(e.target.value)}
            placeholder="Examples:&#10;• Add a search bar to filter items&#10;• Add pull-to-refresh functionality&#10;• Improve error messages with user-friendly text&#10;• Add loading animations&#10;• Add authentication check before API calls"
            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm"
            rows={4}
          />
        </div>

        <Button 
          onClick={handleRefine} 
          disabled={loading || !refinementRequest.trim()}
          fullWidth
        >
          {loading ? '🤖 AI is refining your code...' : '✨ Refine Code with AI'}
        </Button>
      </div>

      {/* Info Box */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-semibold text-blue-900 mb-2">💡 Tips</h3>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>• Be specific in your refinement requests for better results</li>
          <li>• All changes are backed up automatically in the /backups folder</li>
          <li>• After refining, regenerate artifacts to update your guide and dashboard</li>
          <li>• For mobile apps, update the Expo Snack to see changes in the simulator</li>
          <li>• Push to GitHub when you're satisfied with all changes</li>
        </ul>
      </div>
    </div>
  );
}
