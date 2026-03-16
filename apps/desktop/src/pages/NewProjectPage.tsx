import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';
import { Input, Textarea, Select } from '../components/Input';
import { toast } from '../store/toast-store';

const STACK_DESCRIPTIONS: Record<string, string> = {
  web: 'Next.js frontend + Express backend, local dev servers',
  mobile: 'React Native (Expo) + Express backend, Expo Snack simulator',
  'backend-only-fastapi': 'FastAPI (async, auto-docs), local uvicorn server',
  'backend-only-flask': 'Flask (lightweight), local dev server',
};

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
    { value: 'other', label: 'Other' },
  ];

  const stackOptions = [
    { value: 'web', label: 'Web App (Next.js + Express)' },
    { value: 'mobile', label: 'Mobile App (React Native + Express)' },
    { value: 'backend-only', label: 'Backend Only (Python API)' },
  ];

  const pythonFrameworkOptions = [
    { value: 'fastapi', label: 'FastAPI (modern, async, auto-docs)' },
    { value: 'flask', label: 'Flask (lightweight, simple)' },
  ];

  const stackDescKey = formData.stackType === 'backend-only'
    ? `backend-only-${formData.backendFramework}`
    : formData.stackType;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const newErrors: Record<string, string> = {};
    if (!formData.name.trim()) newErrors.name = 'Project name is required';
    if (formData.customerWebsite.trim()) {
      try { new URL(formData.customerWebsite); } catch {
        newErrors.customerWebsite = 'Please enter a valid URL (e.g., https://example.com)';
      }
    }

    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }

    setLoading(true);
    Sentry.setContext('project', { vertical: formData.vertical, stackType: formData.stackType });

    try {
      const slug = formData.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const project = await createProject({
        project: {
          name: formData.name, slug,
          vertical: formData.vertical,
          customerWebsite: formData.customerWebsite,
          notes: formData.notes,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        stack: {
          type: formData.stackType,
          frontend: formData.stackType === 'backend-only' ? undefined :
                    (formData.stackType === 'web' ? 'nextjs' : 'react-native'),
          backend: formData.stackType === 'backend-only' ? formData.backendFramework : 'express',
          ...(formData.stackType === 'mobile' && { mobile_framework: 'react-native' as const }),
        },
        instrumentation: { transactions: [], spans: [] },
        dashboard: { widgets: [] },
        chatHistory: [],
        status: 'draft',
      });

      navigate(`/project/${project.id}/plan`);
    } catch (error) {
      Sentry.captureException(error);
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-8 max-w-xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">New Project</h1>
        <p className="text-sm text-white/45 mt-0.5">Create a new Sentry demo project</p>
      </div>

      <form onSubmit={handleSubmit} className="card p-6 space-y-5">
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

        <div>
          <Select
            label="Tech Stack *"
            value={formData.stackType}
            onChange={e => setFormData({ ...formData, stackType: e.target.value as any })}
            options={stackOptions}
          />
          {formData.stackType !== 'backend-only' && (
            <p className="mt-1.5 text-xs text-white/35">{STACK_DESCRIPTIONS[stackDescKey]}</p>
          )}
        </div>

        {formData.stackType === 'backend-only' && (
          <div>
            <Select
              label="Python Framework *"
              value={formData.backendFramework}
              onChange={e => setFormData({ ...formData, backendFramework: e.target.value as any })}
              options={pythonFrameworkOptions}
            />
            <p className="mt-1.5 text-xs text-white/35">{STACK_DESCRIPTIONS[stackDescKey]}</p>
          </div>
        )}

        <div>
          <Input
            label="Customer Website"
            placeholder="https://example.com"
            value={formData.customerWebsite}
            onChange={e => setFormData({ ...formData, customerWebsite: e.target.value })}
            error={errors.customerWebsite}
          />
          <p className="mt-1.5 text-xs text-white/35">
            Optional — AI will analyze the site for tailored span recommendations. Company names never appear in generated code.
          </p>
        </div>

        <Textarea
          label="Notes"
          placeholder="Additional context (optional)"
          value={formData.notes}
          onChange={e => setFormData({ ...formData, notes: e.target.value })}
          rows={3}
        />

        <div className="flex gap-3 pt-1">
          <Button type="submit" disabled={loading} fullWidth>
            {loading ? 'Creating…' : 'Create Project'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate('/')}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
