import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';
import { Input, Textarea } from '../components/Input';
import { SpanDefinition } from '../types/spec';

type SuggestionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'shown'; message: string; spans: SpanDefinition[] }
  | { status: 'accepted'; count: number }
  | { status: 'declined' };

export default function PlanningPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { currentProject, loadProject, sendMessage, generatePlan, addSpan, updateSpan, deleteSpan } = useProjectStore();

  const [chatInput, setInputValue] = useState('');
  const [generating, setGenerating] = useState(false);
  const [editingSpan, setEditingSpan] = useState<{ index: number; span: SpanDefinition } | null>(null);
  const [newSpansAdded, setNewSpansAdded] = useState<string[]>([]);
  const [suggestionState, setSuggestionState] = useState<SuggestionState>({ status: 'idle' });
  const chatEndRef = useRef<HTMLDivElement>(null);
  const suggestionTriggeredRef = useRef(false);

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
    }
  }, [projectId]);

  // Trigger span suggestions once when the page first loads with an empty chat
  useEffect(() => {
    if (
      currentProject &&
      currentProject.chatHistory.length === 0 &&
      suggestionState.status === 'idle' &&
      !suggestionTriggeredRef.current &&
      projectId
    ) {
      suggestionTriggeredRef.current = true;
      setSuggestionState({ status: 'loading' });
      window.electronAPI.suggestCustomSpans(projectId)
        .then(result => {
          setSuggestionState({ status: 'shown', message: result.message, spans: result.spans });
        })
        .catch(() => {
          // Silently clear on failure so the user isn't blocked
          setSuggestionState({ status: 'idle' });
        });
    }
  }, [currentProject?.id]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentProject?.chatHistory, suggestionState.status]);

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
          .map((s: SpanDefinition) => s.name);

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
    const hasWebsite = currentProject?.project.customerWebsite;
    const confirmMessage = hasWebsite
      ? 'Generate an instrumentation plan using AI? This will analyze your customer website and suggest relevant spans and attributes.'
      : 'Generate an instrumentation plan using AI? This will suggest spans and attributes based on your project.';

    if (!confirm(confirmMessage)) {
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

  const handleDeleteAllSpans = () => {
    if (!currentProject) return;

    const spanCount = currentProject.instrumentation.spans.length;
    if (spanCount === 0) return;

    if (confirm(`Delete all ${spanCount} span(s)? This cannot be undone.`)) {
      // Delete in reverse order to avoid index shifting issues
      for (let i = spanCount - 1; i >= 0; i--) {
        deleteSpan(i);
      }
    }
  };

  const handleAcceptSuggestions = () => {
    if (suggestionState.status !== 'shown') return;
    const { spans } = suggestionState;
    spans.forEach(span => addSpan(span));
    setNewSpansAdded(spans.map(s => s.name));
    setTimeout(() => setNewSpansAdded([]), 5000);
    setSuggestionState({ status: 'accepted', count: spans.length });
  };

  const handleDeclineSuggestions = () => {
    setSuggestionState({ status: 'declined' });
  };

  if (!currentProject) {
    return <div className="p-8">Loading...</div>;
  }

  const showSuggestionBubble =
    suggestionState.status === 'loading' ||
    suggestionState.status === 'shown';

  return (
    <div className="h-full flex">
      {/* Left: Chat */}
      <div className="w-1/2 border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">Chat & Planning</h2>
          <p className="text-gray-600 mt-1">Discuss instrumentation with AI</p>
          {currentProject.project.customerWebsite && (
            <div className="mt-3 bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
              <div className="flex items-center gap-2 text-blue-900">
                <span>🌐</span>
                <div>
                  <span className="font-medium">Context-aware mode:</span> AI will analyze{' '}
                  <a
                    href={currentProject.project.customerWebsite}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline font-medium"
                  >
                    {new URL(currentProject.project.customerWebsite).hostname}
                  </a>
                  {' '}to provide tailored recommendations
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Suggestion bubble — shown before any chat history */}
          {showSuggestionBubble && (
            <div className="bg-gray-100 text-gray-900 mr-8 p-4 rounded-lg">
              <div className="text-xs opacity-75 mb-1">Assistant</div>
              {suggestionState.status === 'loading' ? (
                <div className="flex items-center gap-2 text-gray-500">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  Analyzing your project for custom span suggestions…
                </div>
              ) : suggestionState.status === 'shown' ? (
                <>
                  <p className="whitespace-pre-wrap mb-3">{suggestionState.message}</p>
                  <div className="mb-3 space-y-2">
                    {suggestionState.spans.map((span, i) => (
                      <div key={i} className="bg-white border border-gray-200 rounded-md px-3 py-2 text-sm">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono font-semibold text-gray-800">{span.name}</span>
                          <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">{span.layer}</span>
                          <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">op: {span.op}</span>
                        </div>
                        {span.description && (
                          <p className="text-gray-500 mt-0.5 text-xs">{span.description}</p>
                        )}
                        {Object.keys(span.attributes).length > 0 && (
                          <p className="text-gray-400 mt-0.5 text-xs">
                            attrs: {Object.keys(span.attributes).join(', ')}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-sm text-gray-600 mb-3">
                    Would you like to add these custom spans to your instrumentation plan?
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleAcceptSuggestions}
                      className="px-4 py-1.5 bg-sentry-purple text-white text-sm rounded-lg hover:bg-purple-700 transition-colors font-medium"
                    >
                      Yes, add them
                    </button>
                    <button
                      onClick={handleDeclineSuggestions}
                      className="px-4 py-1.5 bg-white border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      No thanks
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          )}

          {/* Accepted/declined status message */}
          {suggestionState.status === 'accepted' && (
            <div className="bg-green-50 border border-green-200 text-green-800 mr-8 p-4 rounded-lg text-sm">
              <div className="text-xs opacity-75 mb-1">Assistant</div>
              Added {suggestionState.count} custom span{suggestionState.count !== 1 ? 's' : ''} to your plan. Feel free to edit them on the right, or continue chatting to refine further.
            </div>
          )}

          {suggestionState.status === 'declined' && (
            <div className="bg-gray-100 text-gray-600 mr-8 p-4 rounded-lg text-sm">
              <div className="text-xs opacity-75 mb-1">Assistant</div>
              No problem! You can generate a full plan with AI or start chatting to build your instrumentation spec.
            </div>
          )}

          {currentProject.chatHistory.length === 0 && !showSuggestionBubble && suggestionState.status === 'idle' ? (
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
              {generating
                ? (currentProject?.project.customerWebsite
                    ? '🔍 Analyzing website & generating...'
                    : '⏳ Generating...')
                : '✨ Generate Plan with AI'}
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
            {currentProject.project.githubRepoUrl && (
              <button
                onClick={() => window.electronAPI.openInChrome(currentProject.project.githubRepoUrl!)}
                className="text-purple-600 hover:underline text-xs mt-1 inline-block cursor-pointer bg-transparent border-none p-0"
              >
                📂 View on GitHub →
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAddSpan}>
              ➕ Add Span
            </Button>
            {currentProject.instrumentation.spans.length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={handleDeleteAllSpans}
              >
                🗑️ Delete All
              </Button>
            )}
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
