import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';
import { Input, Textarea } from '../components/Input';
import { SpanDefinition } from '../types/spec';

export default function PlanningPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { currentProject, loadProject, sendMessage, generatePlan, addSpan, updateSpan, deleteSpan } = useProjectStore();
  
  const [chatInput, setInputValue] = useState('');
  const [generating, setGenerating] = useState(false);
  const [editingSpan, setEditingSpan] = useState<{ index: number; span: SpanDefinition } | null>(null);
  const [newSpansAdded, setNewSpansAdded] = useState<string[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
    }
  }, [projectId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentProject?.chatHistory]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !projectId) return;

    const message = chatInput;
    setInputValue('');
    
    try {
      // Send message and get response
      await sendMessage(message);
      
      // Reload project to get updated spans
      const updatedProject = await window.electronAPI.getProject(projectId);
      
      // Check for newly added spans
      const previousSpanCount = currentProject?.instrumentation.spans.length || 0;
      const currentSpanCount = updatedProject.instrumentation.spans.length;
      
      if (currentSpanCount > previousSpanCount) {
        const newSpans = updatedProject.instrumentation.spans
          .slice(previousSpanCount)
          .map(s => s.name);
        
        setNewSpansAdded(newSpans);
        
        // Clear notification after 5 seconds
        setTimeout(() => setNewSpansAdded([]), 5000);
      }
      
      // Reload the project in the store
      await loadProject(projectId);
    } catch (error) {
      alert('Error sending message: ' + error);
    }
  };

  const handleGeneratePlan = async () => {
    if (!confirm('Generate an instrumentation plan using AI? This will suggest spans and attributes based on your project.')) {
      return;
    }

    setGenerating(true);
    try {
      await generatePlan();
      alert('Plan generated successfully! Review the spans below.');
    } catch (error) {
      alert('Error generating plan: ' + error);
    } finally {
      setGenerating(false);
    }
  };

  const handleLockPlan = async () => {
    if (!currentProject) return;
    
    if (currentProject.instrumentation.spans.length === 0) {
      alert('Please add at least one span before locking the plan.');
      return;
    }

    if (confirm('Lock this plan and proceed to generation? You can still edit spans later.')) {
      await window.electronAPI.updateProject(currentProject.id, { status: 'locked' });
      navigate(`/project/${currentProject.id}/generate`);
    }
  };

  const handleAddSpan = () => {
    setEditingSpan({
      index: -1,
      span: {
        name: '',
        op: '',
        layer: 'backend',
        description: '',
        attributes: {},
        pii: { keys: [] }
      }
    });
  };

  const handleSaveSpan = () => {
    if (!editingSpan) return;

    if (editingSpan.index === -1) {
      addSpan(editingSpan.span);
    } else {
      updateSpan(editingSpan.index, editingSpan.span);
    }
    
    setEditingSpan(null);
  };

  if (!currentProject) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div className="h-full flex">
      {/* Left: Chat */}
      <div className="w-1/2 border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">Chat & Planning</h2>
          <p className="text-gray-600 mt-1">Discuss instrumentation with AI</p>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {currentProject.chatHistory.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <div className="text-4xl mb-3">💬</div>
              <p>Start a conversation or generate a plan</p>
            </div>
          ) : (
            currentProject.chatHistory.map((msg, idx) => (
              <div
                key={idx}
                className={`p-4 rounded-lg ${
                  msg.role === 'user'
                    ? 'bg-sentry-purple text-white ml-8'
                    : 'bg-gray-100 text-gray-900 mr-8'
                }`}
              >
                <div className="text-xs opacity-75 mb-1">
                  {msg.role === 'user' ? 'You' : 'Assistant'}
                </div>
                <div className="whitespace-pre-wrap">{msg.content}</div>
              </div>
            ))
          )}
          <div ref={chatEndRef} />
        </div>

        <form onSubmit={handleSendMessage} className="p-4 border-t border-gray-200">
          <div className="flex gap-2">
            <input
              type="text"
              value={chatInput}
              onChange={e => setInputValue(e.target.value)}
              placeholder="Ask about instrumentation..."
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sentry-purple"
            />
            <Button type="submit">Send</Button>
          </div>
          <div className="mt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={handleGeneratePlan}
              disabled={generating}
              className="w-full"
            >
              {generating ? '⏳ Generating...' : '✨ Generate Plan with AI'}
            </Button>
          </div>
        </form>
      </div>

      {/* Right: Spec Editor */}
      <div className="w-1/2 flex flex-col">
        <div className="p-6 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Instrumentation Spec</h2>
            <p className="text-gray-600 mt-1">
              {currentProject.instrumentation.spans.length} span(s) defined
            </p>
            {newSpansAdded.length > 0 && (
              <div className="mt-2 text-sm text-green-600 font-medium animate-pulse">
                ✨ Added {newSpansAdded.length} new span(s) from chat!
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAddSpan}>
              ➕ Add Span
            </Button>
            <Button size="sm" onClick={handleLockPlan}>
              🔒 Lock Plan
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {currentProject.instrumentation.spans.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <div className="text-5xl mb-4">📊</div>
              <p className="mb-4">No spans defined yet</p>
              <Button onClick={handleAddSpan}>Add First Span</Button>
            </div>
          ) : (
            <div className="space-y-3">
              {currentProject.instrumentation.spans.map((span, idx) => {
                const isNew = newSpansAdded.includes(span.name);
                return (
                  <div 
                    key={idx} 
                    className={`bg-white border rounded-lg p-4 transition-all ${
                      isNew 
                        ? 'border-green-400 shadow-lg ring-2 ring-green-200' 
                        : 'border-gray-200'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-gray-900">{span.name}</h3>
                          {isNew && (
                            <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                              NEW
                            </span>
                          )}
                        </div>
                        <div className="flex gap-2 mt-1 text-sm">
                          <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded">
                            {span.layer}
                          </span>
                          <span className="px-2 py-0.5 bg-gray-100 text-gray-800 rounded">
                            op: {span.op}
                          </span>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <button
                          onClick={() => setEditingSpan({ index: idx, span })}
                          className="text-blue-600 hover:text-blue-800 text-sm px-2 py-1"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => {
                            if (confirm('Delete this span?')) {
                              deleteSpan(idx);
                            }
                          }}
                          className="text-red-600 hover:text-red-800 text-sm px-2 py-1"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {span.description && (
                      <p className="text-sm text-gray-600 mb-2">{span.description}</p>
                    )}
                    {Object.keys(span.attributes).length > 0 && (
                      <div className="text-xs text-gray-500 mt-2">
                        <strong>Attributes:</strong> {Object.keys(span.attributes).join(', ')}
                      </div>
                    )}
                    {span.pii?.keys && span.pii.keys.length > 0 && (
                      <div className="text-xs text-orange-600 mt-1">
                        <strong>PII (will be redacted):</strong> {span.pii.keys.join(', ')}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Span Editor Modal */}
      {editingSpan && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-4">
              {editingSpan.index === -1 ? 'Add Span' : 'Edit Span'}
            </h3>
            
            <div className="space-y-4">
              <Input
                label="Span Name *"
                placeholder="e.g., checkout.validate_cart"
                value={editingSpan.span.name}
                onChange={e => setEditingSpan({
                  ...editingSpan,
                  span: { ...editingSpan.span, name: e.target.value }
                })}
              />

              <Input
                label="Operation *"
                placeholder="e.g., checkout"
                value={editingSpan.span.op}
                onChange={e => setEditingSpan({
                  ...editingSpan,
                  span: { ...editingSpan.span, op: e.target.value }
                })}
              />

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Layer *
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="layer"
                      value="frontend"
                      checked={editingSpan.span.layer === 'frontend'}
                      onChange={() => setEditingSpan({
                        ...editingSpan,
                        span: { ...editingSpan.span, layer: 'frontend' }
                      })}
                      className="mr-2"
                    />
                    Frontend
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="layer"
                      value="backend"
                      checked={editingSpan.span.layer === 'backend'}
                      onChange={() => setEditingSpan({
                        ...editingSpan,
                        span: { ...editingSpan.span, layer: 'backend' }
                      })}
                      className="mr-2"
                    />
                    Backend
                  </label>
                </div>
              </div>

              <Textarea
                label="Description"
                placeholder="What does this span measure?"
                value={editingSpan.span.description}
                onChange={e => setEditingSpan({
                  ...editingSpan,
                  span: { ...editingSpan.span, description: e.target.value }
                })}
                rows={2}
              />

              <div className="flex gap-3 pt-4">
                <Button onClick={handleSaveSpan} className="flex-1">
                  Save
                </Button>
                <Button variant="secondary" onClick={() => setEditingSpan(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
