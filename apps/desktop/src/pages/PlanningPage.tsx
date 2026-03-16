import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Lock, Plus, Trash2, Pencil, Send, Sparkles,
  ChevronDown, ChevronRight, ExternalLink, Globe,
} from 'lucide-react';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';
import { Input, Textarea } from '../components/Input';
import { SpanDefinition } from '../types/spec';
import { toast } from '../store/toast-store';

type SuggestionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'shown'; message: string; spans: SpanDefinition[] }
  | { status: 'accepted'; count: number }
  | { status: 'declined' };

// ── Inline markdown renderer ─────────────────────────────────────────────────
function renderInline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i} className="text-white font-semibold">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="font-mono text-sentry-purple-300 bg-sentry-purple-900/30 px-1 rounded text-[11px]">{part.slice(1, -1)}</code>;
    return part;
  });
}

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let key = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { nodes.push(<div key={key++} className="h-1.5" />); continue; }
    const numbered = line.match(/^(\d+)\.\s+(.*)/);
    if (numbered) {
      nodes.push(
        <div key={key++} className="flex gap-2 text-sm text-white/75 leading-relaxed">
          <span className="text-white/25 shrink-0 w-5 text-right tabular-nums">{numbered[1]}.</span>
          <span>{renderInline(numbered[2])}</span>
        </div>
      );
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)/);
    if (bullet) {
      nodes.push(
        <div key={key++} className="flex gap-2 text-sm text-white/75 leading-relaxed">
          <span className="text-white/25 shrink-0">·</span>
          <span>{renderInline(bullet[1])}</span>
        </div>
      );
      continue;
    }
    const boldLine = line.match(/^\*\*(.*)\*\*$/);
    if (boldLine) {
      nodes.push(<p key={key++} className="text-[11px] font-semibold text-white/40 uppercase tracking-wider mt-2">{boldLine[1]}</p>);
      continue;
    }
    nodes.push(<p key={key++} className="text-sm text-white/75 leading-relaxed">{renderInline(line)}</p>);
  }
  return nodes;
}
// ─────────────────────────────────────────────────────────────────────────────

const TRUNCATE_CHARS = 320;

export default function PlanningPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { currentProject, loadProject, sendMessage, generatePlan, addSpan, updateSpan, deleteSpan } = useProjectStore();

  const [chatInput, setInputValue] = useState('');
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [editingSpan, setEditingSpan] = useState<{ index: number; span: SpanDefinition } | null>(null);
  const [newSpansAdded, setNewSpansAdded] = useState<string[]>([]);
  const [suggestionState, setSuggestionState] = useState<SuggestionState>({ status: 'idle' });
  const [lockConfirm, setLockConfirm] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  // which message indices are expanded
  const [expandedMsgs, setExpandedMsgs] = useState<Set<number>>(new Set());
  // accordion state for spec panel
  const [openLayers, setOpenLayers] = useState<Set<string>>(new Set(['frontend', 'backend']));
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const suggestionTriggeredRef = useRef(false);

  useEffect(() => { if (projectId) loadProject(projectId); }, [projectId]);

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
        .then(r => setSuggestionState({ status: 'shown', message: r.message, spans: r.spans }))
        .catch(() => setSuggestionState({ status: 'idle' }));
    }
  }, [currentProject?.id]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentProject?.chatHistory, suggestionState.status, sending]);

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!chatInput.trim() || !projectId || sending) return;
    setChatError(null);
    setSending(true);
    const message = chatInput;
    setInputValue('');
    try {
      await sendMessage(message);
      const updated = await window.electronAPI.getProject(projectId);
      const prev = currentProject?.instrumentation.spans.length || 0;
      if (updated.instrumentation.spans.length > prev) {
        const names = updated.instrumentation.spans.slice(prev).map((s: SpanDefinition) => s.name);
        setNewSpansAdded(names);
        setTimeout(() => setNewSpansAdded([]), 5000);
      }
      await loadProject(projectId);
    } catch (err) {
      setChatError(String(err));
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleGeneratePlan = async () => {
    setGenerating(true);
    try { await generatePlan(); toast.success('Plan generated'); }
    catch (err) { toast.error('Failed: ' + err); }
    finally { setGenerating(false); }
  };

  const handleLockPlan = async () => {
    if (!currentProject) return;
    if (currentProject.instrumentation.spans.length === 0) { toast.warning('Add at least one span first'); return; }
    setLockConfirm(true);
  };

  const confirmLock = async () => {
    if (!currentProject) return;
    setLockConfirm(false);
    await window.electronAPI.updateProject(currentProject.id, { status: 'locked' });
    navigate(`/project/${currentProject.id}/generate`);
  };

  const handleAddSpan = () =>
    setEditingSpan({ index: -1, span: { name: '', op: '', layer: 'backend', description: '', attributes: {}, pii: { keys: [] } } });

  const handleSaveSpan = () => {
    if (!editingSpan) return;
    if (!editingSpan.span.name.trim()) { toast.warning('Span name is required'); return; }
    editingSpan.index === -1 ? addSpan(editingSpan.span) : updateSpan(editingSpan.index, editingSpan.span);
    setEditingSpan(null);
  };

  const handleAcceptSuggestions = () => {
    if (suggestionState.status !== 'shown') return;
    suggestionState.spans.forEach(s => addSpan(s));
    setNewSpansAdded(suggestionState.spans.map(s => s.name));
    setTimeout(() => setNewSpansAdded([]), 5000);
    setSuggestionState({ status: 'accepted', count: suggestionState.spans.length });
  };

  const handleAddSingleSpan = (span: SpanDefinition) => {
    addSpan(span);
    setNewSpansAdded(prev => [...prev, span.name]);
    setTimeout(() => setNewSpansAdded([]), 5000);
  };

  const toggleLayer = (layer: string) =>
    setOpenLayers(prev => {
      const next = new Set(prev);
      next.has(layer) ? next.delete(layer) : next.add(layer);
      return next;
    });

  const toggleExpand = (idx: number) =>
    setExpandedMsgs(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });

  if (!currentProject) return <div className="p-8 text-white/50 text-sm">Loading…</div>;

  const spans = currentProject.instrumentation.spans;
  const feSpans = spans.filter(s => s.layer === 'frontend');
  const beSpans = spans.filter(s => s.layer === 'backend');
  const showSuggestion = suggestionState.status === 'loading' || suggestionState.status === 'shown';
  const project = currentProject.project;
  const stackType = currentProject.stack?.type;

  return (
    <div className="h-full flex overflow-hidden relative">

      {/* ══════════════════════════════════════════════
          LEFT: Context panel
      ══════════════════════════════════════════════ */}
      <div className="w-52 shrink-0 border-r border-sentry-border flex flex-col bg-sentry-background overflow-hidden">
        {/* Project card */}
        <div className="px-4 py-5 border-b border-sentry-border space-y-3">
          <div>
            <p className="text-[10px] font-semibold text-white/25 uppercase tracking-wider mb-1">Project</p>
            <p className="text-sm font-semibold text-white leading-tight line-clamp-2">{project.name}</p>
            <p className="text-[11px] text-sentry-purple-400/70 mt-0.5 capitalize">{stackType} · {project.vertical}</p>
          </div>

          {project.customerWebsite && (
            <button
              onClick={() => window.electronAPI.openInChrome(project.customerWebsite!)}
              className="flex items-center gap-1.5 text-[11px] text-white/30 hover:text-white/60 transition-colors w-full"
            >
              <Globe size={11} />
              <span className="truncate">{new URL(project.customerWebsite).hostname}</span>
              <ExternalLink size={10} className="shrink-0 ml-auto" />
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="px-4 py-4 space-y-2">
          <button
            onClick={handleGeneratePlan}
            disabled={generating}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg bg-sentry-gradient text-white text-xs font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            <Sparkles size={12} />
            {generating ? 'Generating…' : 'Generate Plan'}
          </button>
          <button
            onClick={handleLockPlan}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-sentry-border text-white/55 text-xs font-medium hover:text-white hover:border-sentry-purple-500/50 hover:bg-sentry-surface transition-all"
          >
            <Lock size={12} />
            Lock &amp; Continue
          </button>
        </div>

        {/* Stats */}
        <div className="px-4 py-3 border-t border-sentry-border mt-auto">
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-sentry-surface rounded-lg p-2.5">
              <p className="text-lg font-semibold text-white leading-none">{feSpans.length}</p>
              <p className="text-[10px] text-white/30 mt-0.5">Frontend</p>
            </div>
            <div className="bg-sentry-surface rounded-lg p-2.5">
              <p className="text-lg font-semibold text-white leading-none">{beSpans.length}</p>
              <p className="text-[10px] text-white/30 mt-0.5">Backend</p>
            </div>
          </div>
          {newSpansAdded.length > 0 && (
            <p className="text-[11px] text-green-400 mt-2 font-medium">+{newSpansAdded.length} spans added</p>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════
          CENTER: Chat  (main focus)
      ══════════════════════════════════════════════ */}
      <div className="flex-1 min-w-0 flex flex-col bg-sentry-background">
        {/* Chat header */}
        <div className="px-5 py-3 border-b border-sentry-border shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-sentry-gradient flex items-center justify-center">
              <Sparkles size={12} className="text-white" />
            </div>
            <span className="text-sm font-semibold text-white">AI Planning</span>
          </div>
          <span className="text-[11px] text-white/25">{currentProject.chatHistory.length > 0 ? `${currentProject.chatHistory.filter(m => m.role === 'user').length} messages` : 'New conversation'}</span>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">

          {/* Initial suggestion */}
          {showSuggestion && (
            <AIMessage>
              {suggestionState.status === 'loading' ? (
                <div className="flex items-center gap-2.5 text-white/40 text-sm">
                  <TypingDots /> Analyzing your project…
                </div>
              ) : suggestionState.status === 'shown' ? (
                <div className="space-y-3">
                  <p className="text-sm text-white/75 leading-relaxed">{suggestionState.message.split('\n')[0]}</p>
                  <div className="flex flex-wrap gap-2">
                    {suggestionState.spans.map((span, i) => (
                      <SuggestionChip key={i} span={span} onAdd={() => handleAddSingleSpan(span)} />
                    ))}
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={handleAcceptSuggestions}
                      className="px-3 py-1.5 bg-sentry-purple-500 text-white text-xs rounded-lg hover:bg-sentry-purple-400 transition-colors font-medium"
                    >
                      Add all {suggestionState.spans.length} spans
                    </button>
                    <button
                      onClick={() => setSuggestionState({ status: 'declined' })}
                      className="px-3 py-1.5 bg-white/5 border border-sentry-border text-white/40 text-xs rounded-lg hover:bg-white/10 transition-colors"
                    >
                      Skip
                    </button>
                  </div>
                </div>
              ) : null}
            </AIMessage>
          )}

          {suggestionState.status === 'accepted' && (
            <AIMessage>
              <p className="text-sm text-green-400">{suggestionState.count} spans added. Keep chatting to refine the plan.</p>
            </AIMessage>
          )}

          {suggestionState.status === 'declined' && (
            <AIMessage>
              <p className="text-sm text-white/40">No problem. Describe what you want to track and I'll help design the spans.</p>
            </AIMessage>
          )}

          {currentProject.chatHistory.length === 0 && !showSuggestion && suggestionState.status === 'idle' && (
            <div className="flex flex-col items-center justify-center h-32 text-center">
              <p className="text-sm text-white/20">Describe your app and I'll help plan the instrumentation.</p>
              <p className="text-xs text-white/12 mt-1">Shift+Enter for new line · Enter to send</p>
            </div>
          )}

          {currentProject.chatHistory.map((msg, idx) =>
            msg.role === 'user' ? (
              <div key={idx} className="flex justify-end">
                <div className="max-w-[70%] bg-sentry-purple-500/15 border border-sentry-purple-500/20 rounded-2xl rounded-tr-sm px-4 py-3">
                  <p className="text-sm text-white/85 leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            ) : (
              <AIMessage key={idx}>
                <CollapsibleContent
                  content={msg.content}
                  expanded={expandedMsgs.has(idx)}
                  onToggle={() => toggleExpand(idx)}
                />
              </AIMessage>
            )
          )}

          {sending && (
            <AIMessage>
              <TypingDots />
            </AIMessage>
          )}

          {chatError && !sending && (
            <AIMessage>
              <p className="text-sm text-sentry-pink">{chatError}</p>
            </AIMessage>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Input */}
        <div className="px-5 py-4 border-t border-sentry-border shrink-0">
          <div className="flex gap-3 items-end bg-sentry-surface border border-sentry-border rounded-xl px-4 py-3 focus-within:ring-1 focus-within:ring-sentry-purple-500/40 transition-all">
            <textarea
              ref={inputRef}
              value={chatInput}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about instrumentation, request spans, describe your app…"
              disabled={sending}
              rows={1}
              className="flex-1 bg-transparent text-sm text-white placeholder:text-white/20 focus:outline-none resize-none leading-relaxed max-h-32 overflow-y-auto"
              style={{ minHeight: '20px' }}
            />
            <button
              onClick={() => handleSendMessage()}
              disabled={sending || !chatInput.trim()}
              className="text-white/25 hover:text-sentry-purple-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0 pb-0.5"
            >
              <Send size={15} />
            </button>
          </div>
          <p className="text-[11px] text-white/15 mt-1.5 px-1">Enter to send · Shift+Enter for new line</p>
        </div>
      </div>

      {/* ══════════════════════════════════════════════
          RIGHT: Spec panel  (accordion by layer)
      ══════════════════════════════════════════════ */}
      <div className="w-72 shrink-0 border-l border-sentry-border flex flex-col bg-sentry-background overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-sentry-border flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-xs font-semibold text-white">Instrumentation Spec</h2>
            <p className="text-[10px] text-white/30 mt-0.5">{spans.length} span{spans.length !== 1 ? 's' : ''} defined</p>
          </div>
          <button
            onClick={handleAddSpan}
            className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/70 transition-colors px-2 py-1 rounded hover:bg-white/5 border border-transparent hover:border-sentry-border"
          >
            <Plus size={12} /> Add
          </button>
        </div>

        {/* Accordion */}
        <div className="flex-1 overflow-y-auto">
          {spans.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <div className="w-9 h-9 rounded-xl bg-sentry-surface border border-sentry-border flex items-center justify-center mx-auto mb-3">
                <Sparkles size={15} className="text-white/20" />
              </div>
              <p className="text-xs text-white/30 leading-relaxed">Chat to define spans or use Generate Plan.</p>
            </div>
          ) : (
            <>
              <LayerSection
                label="Frontend"
                layer="frontend"
                spans={feSpans}
                allSpans={spans}
                open={openLayers.has('frontend')}
                newSpansAdded={newSpansAdded}
                onToggle={() => toggleLayer('frontend')}
                onEdit={(span) => {
                  const idx = spans.indexOf(span);
                  setEditingSpan({ index: idx, span });
                }}
                onDelete={(span) => {
                  const idx = spans.indexOf(span);
                  setPendingDelete(idx);
                }}
              />
              <LayerSection
                label="Backend"
                layer="backend"
                spans={beSpans}
                allSpans={spans}
                open={openLayers.has('backend')}
                newSpansAdded={newSpansAdded}
                onToggle={() => toggleLayer('backend')}
                onEdit={(span) => {
                  const idx = spans.indexOf(span);
                  setEditingSpan({ index: idx, span });
                }}
                onDelete={(span) => {
                  const idx = spans.indexOf(span);
                  setPendingDelete(idx);
                }}
              />
            </>
          )}
        </div>
      </div>

      {/* ── Lock confirm ── */}
      {lockConfirm && (
        <div className="absolute bottom-0 left-0 right-0 bg-sentry-background-secondary border-t-2 border-sentry-purple-500/40 px-6 py-3.5 flex items-center justify-between z-30">
          <div>
            <p className="text-sm font-semibold text-white">Lock plan and go to Generate?</p>
            <p className="text-xs text-white/35 mt-0.5">Spans can still be edited after locking.</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setLockConfirm(false)}>Cancel</Button>
            <Button size="sm" onClick={confirmLock}><Lock size={13} /> Lock &amp; Continue</Button>
          </div>
        </div>
      )}

      {/* ── Delete confirm ── */}
      {pendingDelete !== null && (
        <div className="absolute bottom-0 left-0 right-0 bg-sentry-background-secondary border-t border-sentry-border px-6 py-3.5 flex items-center justify-between z-30">
          <p className="text-sm text-white">
            Delete <code className="font-mono text-xs bg-white/5 px-1.5 py-0.5 rounded text-white/70">{spans[pendingDelete]?.name}</code>?
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button size="sm" variant="danger" onClick={() => { deleteSpan(pendingDelete); setPendingDelete(null); }}>Delete</Button>
          </div>
        </div>
      )}

      {/* ── Span editor modal ── */}
      {editingSpan && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={() => setEditingSpan(null)}>
          <div className="bg-sentry-background-secondary border border-sentry-border rounded-xl max-w-lg w-full shadow-sentry-lg" onClick={e => e.stopPropagation()}>
            <div className="border-b border-sentry-border px-5 py-4">
              <h3 className="text-sm font-semibold text-white">{editingSpan.index === -1 ? 'Add Span' : 'Edit Span'}</h3>
            </div>
            <div className="p-5 space-y-4">
              <Input label="Span Name *" placeholder="e.g., checkout.validate_cart"
                value={editingSpan.span.name}
                onChange={e => setEditingSpan({ ...editingSpan, span: { ...editingSpan.span, name: e.target.value } })} />
              <Input label="Operation *" placeholder="e.g., checkout"
                value={editingSpan.span.op}
                onChange={e => setEditingSpan({ ...editingSpan, span: { ...editingSpan.span, op: e.target.value } })} />
              <div>
                <label className="block text-xs font-medium text-white/50 mb-2">Layer *</label>
                <div className="flex gap-4">
                  {(['frontend', 'backend'] as const).map(layer => (
                    <label key={layer} className="flex items-center gap-2 cursor-pointer text-sm text-white/65">
                      <input type="radio" name="layer" value={layer}
                        checked={editingSpan.span.layer === layer}
                        onChange={() => setEditingSpan({ ...editingSpan, span: { ...editingSpan.span, layer } })}
                        className="accent-sentry-purple" />
                      {layer.charAt(0).toUpperCase() + layer.slice(1)}
                    </label>
                  ))}
                </div>
              </div>
              <Textarea label="Description" placeholder="What does this span measure?"
                value={editingSpan.span.description} rows={2}
                onChange={e => setEditingSpan({ ...editingSpan, span: { ...editingSpan.span, description: e.target.value } })} />
              <div className="flex gap-2 pt-2">
                <Button onClick={handleSaveSpan} fullWidth>Save</Button>
                <Button variant="secondary" onClick={() => setEditingSpan(null)}>Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Collapsible AI message content ──────────────────────────────────────────
function CollapsibleContent({ content, expanded, onToggle }: {
  content: string; expanded: boolean; onToggle: () => void;
}) {
  const isLong = content.length > TRUNCATE_CHARS;
  const displayText = isLong && !expanded ? content.slice(0, TRUNCATE_CHARS) + '…' : content;
  return (
    <div className="space-y-0.5">
      <div>{renderMarkdown(displayText)}</div>
      {isLong && (
        <button
          onClick={onToggle}
          className="text-[11px] text-sentry-purple-400/70 hover:text-sentry-purple-300 transition-colors mt-1.5 font-medium"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

// ── AI message wrapper ───────────────────────────────────────────────────────
function AIMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-start gap-2.5">
      <div className="w-6 h-6 rounded-full bg-sentry-gradient flex items-center justify-center shrink-0 mt-0.5">
        <Sparkles size={11} className="text-white" />
      </div>
      <div className="max-w-[80%] bg-sentry-surface border border-sentry-border rounded-2xl rounded-tl-sm px-4 py-3">
        {children}
      </div>
    </div>
  );
}

// ── Suggestion chip ──────────────────────────────────────────────────────────
function SuggestionChip({ span, onAdd }: { span: SpanDefinition; onAdd: () => void }) {
  const [added, setAdded] = useState(false);
  const handleAdd = () => {
    setAdded(true);
    onAdd();
  };
  return (
    <div className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-all ${
      added
        ? 'border-green-500/30 bg-green-500/8 opacity-60'
        : 'border-sentry-border bg-sentry-background hover:border-sentry-purple-500/40'
    }`}>
      <code className="text-[11px] font-mono font-semibold text-white">{span.name}</code>
      <span className={`text-[10px] px-1 rounded ${
        span.layer === 'frontend' ? 'text-blue-300/70' : 'text-sentry-purple-400/70'
      }`}>{span.layer}</span>
      {!added && (
        <button
          onClick={handleAdd}
          className="text-[10px] text-white/30 hover:text-white/70 transition-colors ml-0.5"
        >
          <Plus size={11} />
        </button>
      )}
    </div>
  );
}

// ── Layer accordion section ──────────────────────────────────────────────────
function LayerSection({
  label, layer, spans, open, newSpansAdded, onToggle, onEdit, onDelete,
}: {
  label: string;
  layer: string;
  spans: SpanDefinition[];
  allSpans: SpanDefinition[];
  open: boolean;
  newSpansAdded: string[];
  onToggle: () => void;
  onEdit: (span: SpanDefinition) => void;
  onDelete: (span: SpanDefinition) => void;
}) {
  return (
    <div className="border-b border-sentry-border last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/3 transition-colors"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={13} className="text-white/30" /> : <ChevronRight size={13} className="text-white/30" />}
          <span className="text-xs font-semibold text-white/70">{label}</span>
          <span className="text-[10px] text-white/25 bg-white/5 rounded px-1.5 py-0.5">{spans.length}</span>
        </div>
        <span className={`w-1.5 h-1.5 rounded-full ${layer === 'frontend' ? 'bg-blue-400/50' : 'bg-sentry-purple-400/50'}`} />
      </button>

      {open && (
        <div className="pb-2">
          {spans.length === 0 ? (
            <p className="text-[11px] text-white/20 px-4 pb-3 italic">No {label.toLowerCase()} spans yet</p>
          ) : (
            spans.map((span, i) => (
              <SpecRow
                key={i}
                span={span}
                isNew={newSpansAdded.includes(span.name)}
                onEdit={() => onEdit(span)}
                onDelete={() => onDelete(span)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Spec row ─────────────────────────────────────────────────────────────────
function SpecRow({ span, isNew, onEdit, onDelete }: {
  span: SpanDefinition; isNew: boolean; onEdit: () => void; onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`mx-2 mb-1 rounded-lg border transition-all ${
      isNew ? 'border-green-500/30 bg-green-900/6' : 'border-transparent hover:border-sentry-border hover:bg-sentry-surface/50'
    }`}>
      <div
        className="flex items-center gap-2 px-2.5 py-2 cursor-pointer group"
        onClick={() => setExpanded(v => !v)}
      >
        <ChevronRight
          size={11}
          className={`text-white/20 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <div className="flex-1 min-w-0">
          <code className="text-[11px] font-mono text-white/80 block truncate">{span.name}</code>
          <span className="text-[10px] text-white/25 font-mono">op: {span.op}</span>
        </div>
        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            onClick={e => { e.stopPropagation(); onEdit(); }}
            className="p-1 rounded text-white/25 hover:text-white/60 hover:bg-white/5 transition-colors"
          >
            <Pencil size={10} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            className="p-1 rounded text-white/25 hover:text-sentry-pink hover:bg-white/5 transition-colors"
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-2.5 space-y-1.5">
          {span.description && (
            <p className="text-[11px] text-white/40 leading-relaxed">{span.description}</p>
          )}
          {Object.keys(span.attributes).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {Object.keys(span.attributes).map(k => (
                <code key={k} className="text-[10px] font-mono text-white/30 bg-white/5 px-1.5 py-0.5 rounded">{k}</code>
              ))}
            </div>
          )}
          {span.pii?.keys?.length > 0 && (
            <p className="text-[10px] text-yellow-500/50">pii: {span.pii.keys.join(', ')}</p>
          )}
        </div>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-0.5">
      {[0, 1, 2].map(i => (
        <span key={i} className="w-1.5 h-1.5 rounded-full bg-white/30"
          style={{ animation: `td 1.2s ${i * 0.2}s ease-in-out infinite` }} />
      ))}
      <style>{`@keyframes td{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}`}</style>
    </div>
  );
}
