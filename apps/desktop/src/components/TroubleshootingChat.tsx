import { useState, useEffect, useRef } from 'react';
import { X, Bot, Send } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

interface TroubleshootingChatProps {
  context: {
    phase: 'deployment' | 'data-generation';
    projectId: string;
    errors: string[];
    output: string[];
    systemInfo?: string;
  };
  onClose: () => void;
}

export default function TroubleshootingChat({ context, onClose }: TroubleshootingChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (context.errors?.length > 0) {
      const summary = context.errors.slice(-5).join('\n');
      handleSend(`I'm having an issue with ${context.phase}. Here are the recent errors:\n\n${summary}\n\nCan you help me fix this?`, true);
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (message?: string, isAuto = false) => {
    const text = message || input;
    if (!text.trim() || loading) return;
    if (!isAuto) setInput('');

    setMessages(prev => [...prev, { role: 'user', content: text, timestamp: new Date() }]);
    setLoading(true);

    try {
      const recentOutput = (context.output || []).slice(-20).join('\n');
      const recentErrors = (context.errors || []).slice(-10).join('\n');

      let ctx = `You are a concise troubleshooting assistant for SE Copilot. The user has an issue during ${context.phase}.\n\n`;
      if (context.phase === 'deployment') {
        ctx += `Context: Deploying Next.js (port 3000) + Express (port 3001). Common issues: port conflicts, missing deps, Sentry config.\n\n`;
      } else {
        ctx += `Context: Running data generator (Live = Puppeteer + real SDKs, Script = Python sentry-sdk). Common issues: missing Node/Python, invalid DSN.\n\n`;
      }
      if (recentErrors) ctx += `Recent errors:\n${recentErrors}\n\n`;
      if (recentOutput) ctx += `Recent output:\n${recentOutput}\n\n`;
      ctx += `Instructions: Be brief, actionable. Format commands in code blocks.\n\n`;

      const response = await window.electronAPI.sendChatMessage(context.projectId, `${ctx}User: ${text}`);

      if (!response?.content) throw new Error('No response from AI');
      setMessages(prev => [...prev, { role: 'assistant', content: String(response.content), timestamp: new Date() }]);
    } catch (error) {
      setMessages(prev => [...prev, {
        role: 'system',
        content: `Could not reach AI: ${error instanceof Error ? error.message : String(error)}. Check your LLM settings.`,
        timestamp: new Date()
      }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-sentry-background-secondary border border-sentry-border rounded-xl w-full max-w-2xl flex flex-col shadow-sentry-lg"
        style={{ height: 'min(580px, 85vh)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-sentry-border">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-sentry-gradient flex items-center justify-center">
              <Bot size={14} className="text-white" />
            </div>
            <div>
              <div className="text-sm font-semibold text-white">AI Troubleshooter</div>
              <div className="text-[11px] text-white/35 capitalize">{context.phase.replace('-', ' ')} issues</div>
            </div>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/70 transition-colors p-1">
            <X size={16} />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-10 h-10 rounded-full bg-sentry-surface border border-sentry-border flex items-center justify-center mb-3">
                <Bot size={18} className="text-white/30" />
              </div>
              <p className="text-sm text-white/45">Describe your issue and I'll help fix it.</p>
              <p className="text-xs text-white/25 mt-1">I can already see your recent errors and output.</p>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm ${
                msg.role === 'user'
                  ? 'bg-sentry-purple-500/20 border border-sentry-purple-500/30 text-white/90'
                  : msg.role === 'system'
                    ? 'bg-sentry-pink/10 border border-sentry-pink/30 text-sentry-pink'
                    : 'bg-sentry-surface border border-sentry-border text-white/85'
              }`}>
                {msg.role === 'assistant' && (
                  <div className="text-[10px] text-white/30 uppercase tracking-widest mb-1.5">Assistant</div>
                )}
                <div className="whitespace-pre-wrap break-words leading-relaxed">{msg.content}</div>
                <div className="text-[10px] text-white/20 mt-1.5">{msg.timestamp?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-sentry-surface border border-sentry-border rounded-xl px-4 py-3">
                <TypingDots />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-sentry-border">
          <div className="flex items-center gap-2 bg-sentry-surface border border-sentry-border rounded-xl px-3 py-2 focus-within:ring-1 focus-within:ring-sentry-purple-500 transition-all">
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Describe your issue…"
              disabled={loading}
              className="flex-1 bg-transparent text-sm text-white placeholder:text-white/25 focus:outline-none"
            />
            <button
              onClick={() => handleSend()}
              disabled={loading || !input.trim()}
              className="text-white/30 hover:text-sentry-purple-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors p-0.5"
            >
              <Send size={15} />
            </button>
          </div>
          <p className="text-[11px] text-white/20 mt-1.5 px-1">Press Enter to send · I can see your recent errors and output</p>
        </div>
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-0.5">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-white/35"
          style={{ animation: `typing-dot 1.2s ${i * 0.2}s ease-in-out infinite` }}
        />
      ))}
      <style>{`
        @keyframes typing-dot {
          0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-3px); }
        }
      `}</style>
    </div>
  );
}
