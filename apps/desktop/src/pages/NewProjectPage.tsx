import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
      setErrors({ submit: String(error) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">New Project</h1>
      <p className="text-gray-600 mb-8">Create a new Sentry demo project</p>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6 space-y-6">
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

        <div className="bg-blue-50 p-4 rounded-lg border border-blue-200 -mt-3">
          <div className="flex items-start gap-2">
            <span className="text-blue-600 text-lg">ℹ️</span>
            <div className="text-sm text-blue-900">
              <p className="font-medium mb-1">How we use this information</p>
              <p className="text-blue-800">
                We'll analyze the website to provide specific performance metrics recommendations
                tailored to your customer's use case. <strong>Company names and branding will never
                appear in generated code</strong> – all examples remain abstract and generic.
              </p>
            </div>
          </div>
        </div>

        {formData.stackType === 'web' && (
          <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
            <h3 className="font-semibold text-blue-900 mb-2">Web Stack Details</h3>
            <div className="space-y-1 text-sm text-blue-800">
              <div>✓ Frontend: Next.js (React framework)</div>
              <div>✓ Backend: Express (Node.js)</div>
              <div>✓ Deployment: Local dev servers</div>
            </div>
          </div>
        )}

        {formData.stackType === 'mobile' && (
          <div className="bg-purple-50 p-4 rounded-lg border border-purple-200">
            <h3 className="font-semibold text-purple-900 mb-2">Mobile Stack Details</h3>
            <div className="space-y-1 text-sm text-purple-800">
              <div>✓ Frontend: React Native (Expo)</div>
              <div>✓ Backend: Express (Node.js)</div>
              <div>✓ Deployment: Expo Snack (browser simulator)</div>
            </div>
          </div>
        )}

        {formData.stackType === 'backend-only' && (
          <div className="bg-green-50 p-4 rounded-lg border border-green-200">
            <h3 className="font-semibold text-green-900 mb-2">Python Backend Details</h3>
            <div className="space-y-1 text-sm text-green-800">
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
          <div className="bg-red-50 text-red-800 p-3 rounded-lg text-sm">
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
