import { z } from 'zod';

// Vertical enum
export const VerticalSchema = z.enum([
  'ecommerce',
  'fintech',
  'healthcare',
  'saas',
  'gaming',
  'media',
  'other'
]);

export type Vertical = z.infer<typeof VerticalSchema>;

// Stack configuration
export const StackConfigSchema = z.object({
  type: z.enum(['web', 'mobile', 'backend-only']).default('web'),
  frontend: z.string().optional(), // 'nextjs' for web, 'react-native' for mobile, undefined for backend-only
  backend: z.enum(['express', 'flask', 'fastapi']),
  mobile_framework: z.enum(['react-native']).optional()
});

export type StackConfig = z.infer<typeof StackConfigSchema>;

// Span definition
export const SpanDefinitionSchema = z.object({
  name: z.string().min(1, 'Span name is required'),
  op: z.string().min(1, 'Operation is required'),
  layer: z.enum(['frontend', 'backend']),
  description: z.string().optional(),
  attributes: z.record(z.string(), z.string()).default({}),
  pii: z.object({
    keys: z.array(z.string()).default([])
  }).default({ keys: [] })
});

export type SpanDefinition = z.infer<typeof SpanDefinitionSchema>;

// Instrumentation plan
export const InstrumentationPlanSchema = z.object({
  transactions: z.array(z.string()).default([]),
  spans: z.array(SpanDefinitionSchema).default([])
});

export type InstrumentationPlan = z.infer<typeof InstrumentationPlanSchema>;

// Dashboard widget
export const DashboardWidgetSchema = z.object({
  title: z.string().min(1),
  type: z.enum(['timeseries', 'table', 'area', 'line', 'big_number']),
  query: z.string().min(1),
  description: z.string().optional(),
  displayType: z.string().optional(),
  widgetType: z.string().optional(),
  interval: z.string().optional(),
  layout: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    minH: z.number().optional()
  })
});

export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;

// Dashboard configuration
export const DashboardConfigSchema = z.object({
  widgets: z.array(DashboardWidgetSchema).default([])
});

export type DashboardConfig = z.infer<typeof DashboardConfigSchema>;

// Project metadata
export const ProjectMetadataSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  slug: z.string().min(1, 'Project slug is required'),
  vertical: VerticalSchema,
  notes: z.string().default(''),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

// Complete engagement spec
export const EngagementSpecSchema = z.object({
  id: z.string().uuid(),
  project: ProjectMetadataSchema,
  stack: StackConfigSchema,
  instrumentation: InstrumentationPlanSchema,
  dashboard: DashboardConfigSchema,
  chatHistory: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    timestamp: z.string().datetime()
  })).default([]),
  status: z.enum(['draft', 'planning', 'locked', 'generated', 'published']).default('draft'),
  outputPath: z.string().optional(),
  snackUrl: z.string().optional(),
  snackId: z.string().optional()
});

export type EngagementSpec = z.infer<typeof EngagementSpecSchema>;

// Settings
export const SettingsSchema = z.object({
  llm: z.object({
    baseUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
    model: z.string().default('gpt-4-turbo-preview')
  }).default({}),
  github: z.object({
    accessToken: z.string().optional(),
    username: z.string().optional()
  }).default({})
});

export type Settings = z.infer<typeof SettingsSchema>;
