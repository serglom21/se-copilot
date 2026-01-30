import { StorageService } from './storage';
import { EngagementSpec } from '../../src/types/spec';
import fs from 'fs';
import path from 'path';

const SENTRY_API_BASE = 'https://sentry.io/api/0';

export class SentryAPIService {
  private storage: StorageService;

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  async verifyConnection(): Promise<{ success: boolean; organization?: string; error?: string }> {
    const settings = this.storage.getSettings();

    if (!settings.sentry.authToken || !settings.sentry.organization) {
      return {
        success: false,
        error: 'Sentry auth token and organization are required'
      };
    }

    try {
      const response = await fetch(
        `${SENTRY_API_BASE}/organizations/${settings.sentry.organization}/`,
        {
          headers: {
            'Authorization': `Bearer ${settings.sentry.authToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error: ${response.status} ${error}`);
      }

      const data = await response.json();
      return {
        success: true,
        organization: data.name
      };
    } catch (error) {
      console.error('Sentry connection verification failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async createDashboard(
    projectId: string,
    dashboardTitle?: string
  ): Promise<{ success: boolean; dashboardUrl?: string; error?: string }> {
    try {
      const settings = this.storage.getSettings();

      if (!settings.sentry.authToken || !settings.sentry.organization || !settings.sentry.project) {
        throw new Error('Sentry credentials not configured. Please add auth token, organization, and project in Settings.');
      }

      // Load the dashboard JSON
      const outputPath = this.storage.getOutputPath(projectId);
      const dashboardPath = path.join(outputPath, 'sentry-dashboard.json');

      if (!fs.existsSync(dashboardPath)) {
        throw new Error('Dashboard JSON not found. Please generate the dashboard first.');
      }

      const dashboardJson = JSON.parse(fs.readFileSync(dashboardPath, 'utf-8'));

      // Get project details
      const project = this.storage.getProject(projectId);

      // Prepare dashboard payload for Sentry API
      const payload = {
        title: dashboardTitle || dashboardJson.title || `${project.project.name} - Performance Dashboard`,
        widgets: dashboardJson.widgets.map((widget: any) => ({
          title: widget.title,
          displayType: widget.displayType || widget.type,
          queries: [
            {
              fields: this.extractFieldsFromQuery(widget.query),
              aggregates: this.extractAggregatesFromQuery(widget.query),
              columns: this.extractColumnsFromQuery(widget.query),
              conditions: this.extractConditionsFromQuery(widget.query),
              orderby: widget.interval || '-time',
              name: widget.title
            }
          ],
          widgetType: widget.widgetType || 'discover',
          interval: widget.interval || '5m',
          layout: widget.layout || null
        }))
      };

      console.log('Creating dashboard in Sentry...');
      console.log(`Organization: ${settings.sentry.organization}`);
      console.log(`Project: ${settings.sentry.project}`);

      // Create dashboard via Sentry API
      const response = await fetch(
        `${SENTRY_API_BASE}/organizations/${settings.sentry.organization}/dashboards/`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${settings.sentry.authToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Sentry API error:', errorText);
        throw new Error(`Failed to create dashboard: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      console.log('✅ Dashboard created successfully');

      // Construct dashboard URL
      const dashboardUrl = `https://sentry.io/organizations/${settings.sentry.organization}/dashboard/${result.id}/`;

      return {
        success: true,
        dashboardUrl
      };
    } catch (error) {
      console.error('Error creating dashboard in Sentry:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private extractFieldsFromQuery(query: string): string[] {
    // Extract field names from query string
    // Example: "count()" => ["count()"]
    // Example: "avg(transaction.duration)" => ["avg(transaction.duration)"]

    const fields: string[] = [];

    // Match aggregation functions
    const aggMatches = query.matchAll(/\b(count|avg|sum|max|min|p50|p75|p95|p99)\s*\([^)]*\)/gi);
    for (const match of aggMatches) {
      fields.push(match[0]);
    }

    // If no aggregations found, default to count
    if (fields.length === 0) {
      fields.push('count()');
    }

    return fields;
  }

  private extractAggregatesFromQuery(query: string): string[] {
    // Similar to fields but returns just the aggregation names
    const fields = this.extractFieldsFromQuery(query);
    return fields.filter(f => /^(count|avg|sum|max|min|p50|p75|p95|p99)/i.test(f));
  }

  private extractColumnsFromQuery(query: string): string[] {
    // Extract column names for grouping
    // Example: "transaction.name" from "WHERE transaction.name = 'checkout'"

    const columns: string[] = [];

    // Look for common column patterns
    const columnPatterns = [
      /transaction\.name/g,
      /transaction\.op/g,
      /span\.op/g,
      /span\.description/g,
      /user\.id/g,
      /user\.email/g
    ];

    for (const pattern of columnPatterns) {
      if (pattern.test(query)) {
        const match = query.match(pattern);
        if (match) columns.push(match[0]);
      }
    }

    return [...new Set(columns)]; // Remove duplicates
  }

  private extractConditionsFromQuery(query: string): string {
    // Extract WHERE conditions
    // Example: "transaction.name:checkout" from query

    // Look for specific transaction or span names
    const transactionMatch = query.match(/transaction\.name[:\s]*["']?([^"'\s]+)["']?/);
    if (transactionMatch) {
      return `transaction.name:${transactionMatch[1]}`;
    }

    const spanMatch = query.match(/span\.op[:\s]*["']?([^"'\s]+)["']?/);
    if (spanMatch) {
      return `span.op:${spanMatch[1]}`;
    }

    return '';
  }

  async listDashboards(): Promise<{ success: boolean; dashboards?: any[]; error?: string }> {
    try {
      const settings = this.storage.getSettings();

      if (!settings.sentry.authToken || !settings.sentry.organization) {
        throw new Error('Sentry credentials not configured');
      }

      const response = await fetch(
        `${SENTRY_API_BASE}/organizations/${settings.sentry.organization}/dashboards/`,
        {
          headers: {
            'Authorization': `Bearer ${settings.sentry.authToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to list dashboards: ${response.status}`);
      }

      const dashboards = await response.json();

      return {
        success: true,
        dashboards
      };
    } catch (error) {
      console.error('Error listing dashboards:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
