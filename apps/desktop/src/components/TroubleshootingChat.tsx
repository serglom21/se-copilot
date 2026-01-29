import { useState, useEffect, useRef } from 'react';
import Button from './Button';
import { Input } from './Input';

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
  const [renderError, setRenderError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      // Auto-send context on mount
      if (context.errors && context.errors.length > 0) {
        const errorSummary = context.errors.slice(-5).join('\n');
        const contextMessage = `I'm having an issue with ${context.phase}. Here are the recent errors:\n\n${errorSummary}\n\nCan you help me fix this?`;
        handleSendMessage(contextMessage, true);
      }
    } catch (error) {
      console.error('Error in useEffect:', error);
      setRenderError(String(error));
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = async (message?: string, isAuto = false) => {
    const messageToSend = message || input;
    if (!messageToSend.trim() || loading) return;

    if (!isAuto) {
      setInput('');
    }

    const userMessage: Message = {
      role: 'user',
      content: messageToSend,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setLoading(true);

    try {
      // Build context for AI
      const systemContext = buildSystemContext();
      
      console.log('Sending message to AI...', { projectId: context.projectId });
      
      const response = await window.electronAPI.sendChatMessage(context.projectId, 
        `${systemContext}\n\nUser question: ${messageToSend}`
      );

      console.log('Received response:', response);

      // Validate response
      if (!response || typeof response !== 'object') {
        throw new Error('Invalid response format from AI');
      }

      if (!response.content) {
        throw new Error('AI response missing content');
      }

      const assistantMessage: Message = {
        role: 'assistant',
        content: String(response.content), // Ensure it's a string
        timestamp: new Date()
      };

      console.log('Adding assistant message:', assistantMessage);
      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Chat error:', error);
      const errorMessage: Message = {
        role: 'system',
        content: `Error: ${error instanceof Error ? error.message : String(error)}. Please try again or check your LLM configuration in Settings.`,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  const buildSystemContext = (): string => {
    try {
      const recentOutput = (context.output || []).slice(-20).join('\n');
      const recentErrors = (context.errors || []).slice(-10).join('\n');
    
    let contextStr = `You are a helpful troubleshooting assistant for SE Copilot. The user is experiencing issues during ${context.phase}.\n\n`;
    
    if (context.phase === 'deployment') {
      contextStr += `DEPLOYMENT CONTEXT:
- Deploying a Next.js frontend (port 3000) and Express backend (port 3001)
- Using npm to install dependencies and run dev servers
- Common issues: port conflicts, missing dependencies, Sentry config errors

`;
    } else {
      contextStr += `DATA GENERATION CONTEXT:
- Running a Python script to generate test data for Sentry
- Using pip to install dependencies (sentry-sdk, faker, requests, python-dotenv)
- Common issues: Python not installed, missing packages, invalid DSNs

`;
    }

    if (recentErrors) {
      contextStr += `RECENT ERRORS:\n${recentErrors}\n\n`;
    }

    if (recentOutput) {
      contextStr += `RECENT OUTPUT:\n${recentOutput}\n\n`;
    }

    contextStr += `INSTRUCTIONS:
1. Analyze the error and output
2. Provide a clear, concise explanation of what went wrong
3. Give specific step-by-step fix instructions
4. If it's a command to run, format it clearly
5. Keep responses brief and actionable

`;

      return contextStr;
    } catch (error) {
      console.error('Error building context:', error);
      return 'Error building context. Please describe your issue manually.';
    }
  };

  if (renderError) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
          <h2 className="text-xl font-bold text-red-600 mb-4">Error</h2>
          <p className="text-gray-700 mb-4">{renderError}</p>
          <button
            onClick={onClose}
            className="w-full bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl h-[600px] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">🤖 AI Troubleshooter</h2>
            <p className="text-sm text-gray-600">
              Ask me about {context.phase === 'deployment' ? 'deployment' : 'data generation'} issues
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl"
          >
            ×
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              <div className="text-5xl mb-4">🤖</div>
              <p className="font-medium">Hi! I'm here to help troubleshoot issues.</p>
              <p className="text-sm mt-2">Describe your problem and I'll help you fix it.</p>
            </div>
          )}

          {messages.map((msg, idx) => {
            try {
              return (
                <div
                  key={idx}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg p-3 ${
                      msg.role === 'user'
                        ? 'bg-purple-600 text-white'
                        : msg.role === 'system'
                        ? 'bg-red-50 text-red-800 border border-red-200'
                        : 'bg-gray-100 text-gray-900'
                    }`}
                  >
                    {msg.role === 'assistant' && (
                      <div className="flex items-center gap-2 mb-2 text-sm font-medium">
                        <span>🤖</span>
                        <span>AI Assistant</span>
                      </div>
                    )}
                    <div className="whitespace-pre-wrap text-sm break-words">
                      {msg.content || '(empty response)'}
                    </div>
                    <div className="text-xs mt-2 opacity-70">
                      {msg.timestamp?.toLocaleTimeString() || 'Unknown time'}
                    </div>
                  </div>
                </div>
              );
            } catch (error) {
              console.error('Error rendering message:', error, msg);
              return (
                <div key={idx} className="text-red-500 text-sm p-2">
                  Error rendering message
                </div>
              );
            }
          })}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-gray-100 rounded-lg p-3">
                <div className="flex items-center gap-2 text-gray-600">
                  <div className="animate-spin">⏳</div>
                  <span className="text-sm">Thinking...</span>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="p-4 border-t border-gray-200">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder="Describe your issue or ask a question..."
              disabled={loading}
              className="flex-1"
            />
            <Button
              onClick={() => handleSendMessage()}
              disabled={loading || !input.trim()}
            >
              Send
            </Button>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            💡 Tip: I can see your recent errors and output. Just describe what you're trying to do!
          </div>
        </div>
      </div>
    </div>
  );
}
