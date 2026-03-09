import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';
import { Input, Textarea, Select } from '../components/Input';

export default function NewProjectPage() {
  const navigate = useNavigate();
  const createProject = useProjectStore(state => state.createProject);
  
  const [formData, setFormData] = useState({
    name: '',
    vertical: 'ecommerce' as const,
    stackType: 'web' as 'web' | 'mobile' | 'backend-only',
    backendFramework: 'fastapi' as 'express' | 'flask' | 'fastapi',
    customerWebsite: '',
    notes: ''
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const verticalOptions = [
    { value: 'ecommerce', label: 'E-commerce' },
    { value: 'fintech', label: 'FinTech' },
    { value: 'healthcare', label: 'Healthcare' },
    { value: 'saas', label: 'SaaS' },
    { value: 'gaming', label: 'Gaming' },
    { value: 'media', label: 'Media' },
    { value: 'other', label: 'Other' }
  ];

  const stackOptions = [
    { value: 'web', label: '🌐 Web App (Next.js + Express)' },
    { value: 'mobile', label: '📱 Mobile App (React Native + Express)' },
    { value: 'backend-only', label: '🐍 Backend Only (Python API)' }
  ];

  const pythonFrameworkOptions = [
    { value: 'fastapi', label: 'FastAPI (Modern, async, auto-docs)' },
    { value: 'flask', label: 'Flask (Lightweight, simple)' }
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validation
    const newErrors: Record<string, string> = {};
    if (!formData.name.trim()) {
      newErrors.name = 'Project name is required';
    }

    // Validate URL format if provided
    if (formData.customerWebsite.trim()) {
      try {
        new URL(formData.customerWebsite);
      } catch {
        newErrors.customerWebsite = 'Please enter a valid URL (e.g., https://example.com)';
      }
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setLoading(true);

    // Track project metadata
    Sentry.setContext('project', {
      vertical: formData.vertical,
      stackType: formData.stackType,
      backendFramework: formData.backendFramework,
    });

    try {
      const slug = formData.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

      const project = await createProject({
        project: {
          name: formData.name,
          slug,
          vertical: formData.vertical,
          customerWebsite: formData.customerWebsite,
          notes: formData.notes,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        stack: {
          type: formData.stackType,
          frontend: formData.stackType === 'backend-only' ? undefined : 
                    (formData.stackType === 'web' ? 'nextjs' : 'react-native'),
          backend: formData.stackType === 'backend-only' ? formData.backendFramework : 'express',
          ...(formData.stackType === 'mobile' && { mobile_framework: 'react-native' as const })
        },
        instrumentation: {
          transactions: [],
          spans: []
        },
        dashboard: {
          widgets: []
        },
        chatHistory: [],
        status: 'draft'
      });

      navigate(`/project/${project.id}/plan`);
    } catch (error) {
      Sentry.captureException(error);
      setErrors({ submit: String(error) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">New Project</h1>
        <p className="text-gray-400 text-lg">Create a new Sentry demo project</p>
      </div>

      <form onSubmit={handleSubmit} className="card p-8 space-y-6">
        <Input
          label="Project Name *"
          placeholder="My Customer Demo"
          value={formData.name}
          onChange={e => setFormData({ ...formData, name: e.target.value })}
          error={errors.name}
        />

        <Select
          label="Customer Vertical *"
          value={formData.vertical}
          onChange={e => setFormData({ ...formData, vertical: e.target.value as any })}
          options={verticalOptions}
        />

        <Select
          label="Tech Stack *"
          value={formData.stackType}
          onChange={e => setFormData({ ...formData, stackType: e.target.value as 'web' | 'mobile' | 'backend-only' })}
          options={stackOptions}
        />

        {formData.stackType === 'backend-only' && (
          <Select
            label="Python Framework *"
            value={formData.backendFramework}
            onChange={e => setFormData({ ...formData, backendFramework: e.target.value as 'flask' | 'fastapi' })}
            options={pythonFrameworkOptions}
          />
        )}

        <Input
          label="Customer Website"
          placeholder="https://example.com"
          value={formData.customerWebsite}
          onChange={e => setFormData({ ...formData, customerWebsite: e.target.value })}
          error={errors.customerWebsite}
        />

        <div className="bg-blue-900/20 p-4 rounded-lg border border-blue-700/50 -mt-3">
          <div className="flex items-start gap-3">
            <span className="text-blue-400 text-xl">ℹ️</span>
            <div className="text-sm text-blue-200">
              <p className="font-semibold mb-1 text-blue-100">How we use this information</p>
              <p className="text-blue-300">
                We'll analyze the website to provide specific performance metrics recommendations
                tailored to your customer's use case. <strong className="text-blue-100">Company names and branding will never
                appear in generated code</strong> – all examples remain abstract and generic.
              </p>
            </div>
          </div>
        </div>

        {formData.stackType === 'web' && (
          <div className="bg-blue-900/20 p-4 rounded-lg border border-blue-700/50">
            <h3 className="font-semibold text-blue-100 mb-2">🌐 Web Stack Details</h3>
            <div className="space-y-1 text-sm text-blue-300">
              <div>✓ Frontend: Next.js (React framework)</div>
              <div>✓ Backend: Express (Node.js)</div>
              <div>✓ Deployment: Local dev servers</div>
            </div>
          </div>
        )}

        {formData.stackType === 'mobile' && (
          <div className="bg-sentry-purple-900/20 p-4 rounded-lg border border-sentry-purple-700/50">
            <h3 className="font-semibold text-sentry-purple-100 mb-2">📱 Mobile Stack Details</h3>
            <div className="space-y-1 text-sm text-sentry-purple-300">
              <div>✓ Frontend: React Native (Expo)</div>
              <div>✓ Backend: Express (Node.js)</div>
              <div>✓ Deployment: Expo Snack (browser simulator)</div>
            </div>
          </div>
        )}

        {formData.stackType === 'backend-only' && (
          <div className="bg-green-900/20 p-4 rounded-lg border border-green-700/50">
            <h3 className="font-semibold text-green-100 mb-2">🐍 Python Backend Details</h3>
            <div className="space-y-1 text-sm text-green-300">
              <div>✓ Framework: {formData.backendFramework === 'fastapi' ? 'FastAPI (modern, async)' : 'Flask (lightweight)'}</div>
              <div>✓ Features: RESTful API, Sentry instrumentation, auto-docs</div>
              <div>✓ Deployment: Local dev server (uvicorn/flask)</div>
            </div>
          </div>
        )}

        <Textarea
          label="Notes"
          placeholder="Additional context about this demo (optional)"
          value={formData.notes}
          onChange={e => setFormData({ ...formData, notes: e.target.value })}
          rows={4}
        />

        {errors.submit && (
          <div className="bg-sentry-pink/20 text-sentry-pink-light p-4 rounded-lg text-sm border border-sentry-pink/50 font-medium">
            {errors.submit}
          </div>
        )}

        <div className="flex gap-3 pt-4">
          <Button type="submit" disabled={loading} className="flex-1">
            {loading ? 'Creating...' : 'Create Project'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => navigate('/')}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
