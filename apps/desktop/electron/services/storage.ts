import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { EngagementSpec, Settings, SettingsSchema, EngagementSpecSchema } from '../../src/types/spec';

export class StorageService {
  private dataDir: string;
  private projectsDir: string;
  private outputDir: string;
  private settingsPath: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.projectsDir = path.join(dataDir, 'projects');
    // Output to user's Documents folder
    const homeDir = os.homedir();
    this.outputDir = path.join(homeDir, 'Documents', 'SE-Copilot-Output');
    this.settingsPath = path.join(dataDir, 'settings.json');

    this.ensureDirectories();
  }

  private ensureDirectories() {
    [this.dataDir, this.projectsDir, this.outputDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  // Settings
  getSettings(): Settings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, 'utf-8');
        return SettingsSchema.parse(JSON.parse(data));
      }
    } catch (error) {
      console.error('Error reading settings:', error);
    }
    return SettingsSchema.parse({});
  }

  updateSettings(settings: Partial<Settings>): void {
    const current = this.getSettings();
    const updated = { ...current, ...settings };
    fs.writeFileSync(this.settingsPath, JSON.stringify(updated, null, 2));
  }

  // Projects
  listProjects(): EngagementSpec[] {
    const files = fs.readdirSync(this.projectsDir);
    const projects: EngagementSpec[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const data = fs.readFileSync(path.join(this.projectsDir, file), 'utf-8');
          const project = EngagementSpecSchema.parse(JSON.parse(data));
          projects.push(project);
        } catch (error) {
          console.error(`Error reading project ${file}:`, error);
        }
      }
    }

    return projects.sort((a, b) => 
      new Date(b.project.updatedAt).getTime() - new Date(a.project.updatedAt).getTime()
    );
  }

  getProject(projectId: string): EngagementSpec {
    const projectPath = path.join(this.projectsDir, `${projectId}.json`);
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project ${projectId} not found`);
    }
    const data = fs.readFileSync(projectPath, 'utf-8');
    return EngagementSpecSchema.parse(JSON.parse(data));
  }

  createProject(project: Omit<EngagementSpec, 'id' | 'project'>): EngagementSpec {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    
    const spec: EngagementSpec = {
      ...project,
      id,
      project: {
        ...project.project,
        createdAt: now,
        updatedAt: now
      },
      chatHistory: [],
      status: 'draft'
    };

    const validated = EngagementSpecSchema.parse(spec);
    const projectPath = path.join(this.projectsDir, `${id}.json`);
    fs.writeFileSync(projectPath, JSON.stringify(validated, null, 2));

    return validated;
  }

  updateProject(projectId: string, updates: Partial<EngagementSpec>): EngagementSpec {
    const current = this.getProject(projectId);
    const updated: EngagementSpec = {
      ...current,
      ...updates,
      project: {
        ...current.project,
        ...(updates.project || {}),
        updatedAt: new Date().toISOString()
      }
    };

    const validated = EngagementSpecSchema.parse(updated);
    const projectPath = path.join(this.projectsDir, `${projectId}.json`);
    fs.writeFileSync(projectPath, JSON.stringify(validated, null, 2));

    return validated;
  }

  deleteProject(projectId: string): void {
    const projectPath = path.join(this.projectsDir, `${projectId}.json`);
    if (fs.existsSync(projectPath)) {
      fs.unlinkSync(projectPath);
    }
  }

  getOutputPath(projectId: string): string {
    const project = this.getProject(projectId);
    const outputPath = path.join(this.outputDir, project.project.slug);
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }
    return outputPath;
  }

  saveToOutput(projectId: string, filename: string, content: string): string {
    const outputPath = this.getOutputPath(projectId);
    const filePath = path.join(outputPath, filename);
    fs.writeFileSync(filePath, content);
    return filePath;
  }
}
