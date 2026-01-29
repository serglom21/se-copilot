import { create } from 'zustand';
import { EngagementSpec, SpanDefinition } from '../types/spec';

interface ProjectStore {
  currentProject: EngagementSpec | null;
  projects: EngagementSpec[];
  loading: boolean;
  error: string | null;

  // Actions
  loadProjects: () => Promise<void>;
  loadProject: (projectId: string) => Promise<void>;
  createProject: (project: Partial<EngagementSpec>) => Promise<EngagementSpec>;
  updateProject: (projectId: string, updates: Partial<EngagementSpec>) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  setCurrentProject: (project: EngagementSpec | null) => void;
  
  // Instrumentation actions
  addSpan: (span: SpanDefinition) => void;
  updateSpan: (index: number, span: SpanDefinition) => void;
  deleteSpan: (index: number) => void;
  
  // Chat actions
  sendMessage: (message: string) => Promise<string>;
  generatePlan: () => Promise<void>;
  
  // Generation actions
  generateApp: () => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  generateGuide: () => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  generateDashboard: () => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  generateDataScript: () => Promise<{ success: boolean; outputPath?: string; error?: string }>;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  currentProject: null,
  projects: [],
  loading: false,
  error: null,

  loadProjects: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await window.electronAPI.listProjects();
      set({ projects, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  loadProject: async (projectId: string) => {
    set({ loading: true, error: null });
    try {
      const project = await window.electronAPI.getProject(projectId);
      set({ currentProject: project, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  createProject: async (projectData: any) => {
    set({ loading: true, error: null });
    try {
      const project = await window.electronAPI.createProject(projectData);
      set(state => ({
        projects: [project, ...state.projects],
        currentProject: project,
        loading: false
      }));
      return project;
    } catch (error) {
      set({ error: String(error), loading: false });
      throw error;
    }
  },

  updateProject: async (projectId: string, updates: Partial<EngagementSpec>) => {
    set({ loading: true, error: null });
    try {
      const updated = await window.electronAPI.updateProject(projectId, updates);
      set(state => ({
        currentProject: state.currentProject?.id === projectId ? updated : state.currentProject,
        projects: state.projects.map(p => p.id === projectId ? updated : p),
        loading: false
      }));
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  deleteProject: async (projectId: string) => {
    set({ loading: true, error: null });
    try {
      await window.electronAPI.deleteProject(projectId);
      set(state => ({
        projects: state.projects.filter(p => p.id !== projectId),
        currentProject: state.currentProject?.id === projectId ? null : state.currentProject,
        loading: false
      }));
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  setCurrentProject: (project: EngagementSpec | null) => {
    set({ currentProject: project });
  },

  addSpan: (span: SpanDefinition) => {
    const { currentProject } = get();
    if (!currentProject) return;

    const updated = {
      ...currentProject,
      instrumentation: {
        ...currentProject.instrumentation,
        spans: [...currentProject.instrumentation.spans, span]
      }
    };

    window.electronAPI.updateProject(currentProject.id, updated);
    set({ currentProject: updated });
  },

  updateSpan: (index: number, span: SpanDefinition) => {
    const { currentProject } = get();
    if (!currentProject) return;

    const spans = [...currentProject.instrumentation.spans];
    spans[index] = span;

    const updated = {
      ...currentProject,
      instrumentation: {
        ...currentProject.instrumentation,
        spans
      }
    };

    window.electronAPI.updateProject(currentProject.id, updated);
    set({ currentProject: updated });
  },

  deleteSpan: (index: number) => {
    const { currentProject } = get();
    if (!currentProject) return;

    const spans = currentProject.instrumentation.spans.filter((_, i) => i !== index);

    const updated = {
      ...currentProject,
      instrumentation: {
        ...currentProject.instrumentation,
        spans
      }
    };

    window.electronAPI.updateProject(currentProject.id, updated);
    set({ currentProject: updated });
  },

  sendMessage: async (message: string) => {
    const { currentProject } = get();
    if (!currentProject) throw new Error('No current project');

    const response = await window.electronAPI.sendChatMessage(currentProject.id, message);
    
    // Reload project to get updated chat history
    await get().loadProject(currentProject.id);
    
    return response.content;
  },

  generatePlan: async () => {
    const { currentProject } = get();
    if (!currentProject) throw new Error('No current project');

    set({ loading: true, error: null });
    try {
      const plan = await window.electronAPI.generatePlan(currentProject.id);
      
      const updated = {
        ...currentProject,
        instrumentation: {
          transactions: plan.transactions,
          spans: plan.spans
        },
        status: 'planning' as const
      };

      await window.electronAPI.updateProject(currentProject.id, updated);
      set({ currentProject: updated, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
      throw error;
    }
  },

  generateApp: async () => {
    const { currentProject } = get();
    if (!currentProject) throw new Error('No current project');

    return window.electronAPI.generateApp(currentProject.id);
  },

  generateGuide: async () => {
    const { currentProject } = get();
    if (!currentProject) throw new Error('No current project');

    return window.electronAPI.generateGuide(currentProject.id);
  },

  generateDashboard: async () => {
    const { currentProject } = get();
    if (!currentProject) throw new Error('No current project');

    return window.electronAPI.generateDashboard(currentProject.id);
  },

  generateDataScript: async () => {
    const { currentProject } = get();
    if (!currentProject) throw new Error('No current project');

    return window.electronAPI.generateDataScript(currentProject.id);
  }
}));
