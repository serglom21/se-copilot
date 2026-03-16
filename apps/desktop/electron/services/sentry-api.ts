import { StorageService } from './storage';
import { EngagementSpec } from '../../src/types/spec';
import fs from 'fs';
import path from 'path';

// Default to sentry.io, but support custom instances via organization slug
function getSentryApiBase(organization: string): string {
  // Check if organization slug appears to be a custom instance (contains domain-like patterns)
  // For custom instances, use: https://{org}.sentry.io/api/0
  // For standard: https://sentry.io/api/0
  if (organization.includes('.')) {
    // If the org has a dot, it's likely a full domain, use sentry.io
    return 'https://sentry.io/api/0';
  }
  // Try custom instance first (many orgs have dedicated instances)
  return `https://${organization}.sentry.io/api/0`;
}

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
      const apiBase = getSentryApiBase(settings.sentry.organization);
      const response = await fetch(
        `${apiBase}/organizations/${settings.sentry.organization}/`,
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
    dashboardTitle?: string,
    credentials?: {
      authToken: string;
      organization: string;
    }
  ): Promise<{ success: boolean; dashboardUrl?: string; error?: string }> {
    try {
      // Use provided credentials or fall back to settings
      const settings = this.storage.getSettings();
      const authToken = (credentials?.authToken || settings.sentry.authToken).trim();
      const organization = (credentials?.organization || settings.sentry.organization).trim();

      if (!authToken || !organization) {
        throw new Error('Sentry credentials required. Please provide auth token and organization.');
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
        widgets: dashboardJson.widgets.map((widget: any) => {
          // If widget already has queries array (new format), use it directly
          if (widget.queries && Array.isArray(widget.queries)) {
            return {
              title: widget.title,
              description: widget.description || null,
              displayType: widget.displayType || 'area',
              widgetType: widget.widgetType || 'spans',
              interval: widget.interval || '1h',
              limit: widget.limit || 10, // Required by Sentry API, max is 10
              queries: widget.queries.map((q: any) => ({
                fields: q.fields || [],
                aggregates: q.aggregates || [],
                columns: q.columns || [],
                conditions: q.conditions || '',
                orderby: q.orderby || '',
                name: q.name || widget.title
              })),
              layout: widget.layout || null
            };
          }

          // Legacy format: extract from widget.query string
          return {
            title: widget.title,
            displayType: widget.displayType || widget.type,
            widgetType: widget.widgetType || 'spans',
            interval: widget.interval || '1h',
            limit: widget.limit || 10, // Required by Sentry API, max is 10
            queries: [
              {
                fields: this.extractFieldsFromQuery(widget.query),
                aggregates: this.extractAggregatesFromQuery(widget.query),
                columns: this.extractColumnsFromQuery(widget.query),
                conditions: this.extractConditionsFromQuery(widget.query) || 'is_transaction:true',
                orderby: '',
                name: widget.title
              }
            ],
            layout: widget.layout || null
          };
        })
      };

      console.log('Creating dashboard in Sentry...');
      console.log(`Organization: ${organization}`);
      console.log(`Auth token length: ${authToken.length}`);
      console.log(`Auth token has spaces: ${authToken.includes(' ')}`);
      console.log(`Auth token first 10 chars: ${authToken.substring(0, 10)}`);

      // Determine API base - try custom instance first
      const apiBase = getSentryApiBase(organization);
      console.log(`Using API base: ${apiBase}`);
      console.log(`Uploading ${payload.widgets.length} widgets...`);

      // Create dashboard via Sentry API with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      let response;
      try {
        console.log('[SENTRY] Starting fetch request...');
        response = await fetch(
          `${apiBase}/organizations/${organization}/dashboards/`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${authToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
          }
        );
        clearTimeout(timeoutId);
        console.log(`[SENTRY] Got response: ${response.status}`);

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[SENTRY] API error:', errorText);
          throw new Error(`Failed to create dashboard: ${response.status} ${errorText}`);
        }

        const result = await response.json();
        console.log('[SENTRY] ✅ Dashboard created successfully, ID:', result.id);

        // Construct dashboard URL (use custom instance format)
        const dashboardUrl = `https://${organization}.sentry.io/organizations/${organization}/dashboard/${result.id}/`;

        return {
          success: true,
          dashboardUrl
        };
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        console.error('[SENTRY] Fetch error:', fetchError);
        if (fetchError.name === 'AbortError') {
          throw new Error('Dashboard upload timed out after 30 seconds. Please try again.');
        }
        throw fetchError;
      }
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

  async listRecentTraceIds(projectSlug?: string): Promise<{ success: boolean; traceIds?: string[]; error?: string }> {
    try {
      const settings = this.storage.getSettings();
      if (!settings.sentry.authToken || !settings.sentry.organization) {
        throw new Error('Sentry credentials not configured');
      }

      const org = settings.sentry.organization.trim();
      const token = settings.sentry.authToken.trim();
      const apiBase = getSentryApiBase(org);

      const projectFilter = projectSlug ? `&project=${projectSlug}` : '';
      const url = `${apiBase}/organizations/${org}/events/?dataset=transactions&field=trace,id,transaction,timestamp&query=is_transaction:true&sort=-timestamp&limit=25${projectFilter}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch traces: ${response.status}`);
      }

      const data = await response.json();
      const events: any[] = data.data || [];
      // Deduplicate trace IDs
      const seen = new Set<string>();
      const traceIds: string[] = [];
      for (const event of events) {
        const tid = event.trace || event['trace'];
        if (tid && !seen.has(tid)) {
          seen.add(tid);
          traceIds.push(tid);
        }
      }

      return { success: true, traceIds };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async fetchTraceSpans(traceIds: string[]): Promise<{ success: boolean; spans?: any[]; error?: string }> {
    try {
      const settings = this.storage.getSettings();
      if (!settings.sentry.authToken || !settings.sentry.organization) {
        throw new Error('Sentry credentials not configured');
      }

      const org = settings.sentry.organization.trim();
      const token = settings.sentry.authToken.trim();
      const apiBase = getSentryApiBase(org);

      const fields = [
        'trace_id', 'span_id', 'parent_span_id', 'op', 'description',
        'start_timestamp', 'timestamp', 'status', 'data', 'sampled', 'transaction'
      ].join(',');

      const allSpans: any[] = [];

      for (const traceId of traceIds) {
        const url = `${apiBase}/organizations/${org}/events/?dataset=spansIndexed&field=${encodeURIComponent(fields)}&query=trace:${traceId}&limit=100`;
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });

        if (!response.ok) {
          console.warn(`[fetchTraceSpans] Failed to fetch trace ${traceId}: ${response.status}`);
          continue;
        }

        const data = await response.json();
        const spans: any[] = data.data || [];
        allSpans.push(...spans);
      }

      return { success: true, spans: allSpans };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listDashboards(): Promise<{ success: boolean; dashboards?: any[]; error?: string }> {
    try {
      const settings = this.storage.getSettings();

      if (!settings.sentry.authToken || !settings.sentry.organization) {
        throw new Error('Sentry credentials not configured');
      }

      const apiBase = getSentryApiBase(settings.sentry.organization);
      const response = await fetch(
        `${apiBase}/organizations/${settings.sentry.organization}/dashboards/`,
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
