export interface WidgetIntent {
  intent: string;
  priority: 'KPI' | 'chart' | 'detail';
}

interface SpanDefinition {
  name: string;
  op: string;
  layer: 'frontend' | 'backend';
  description?: string;
  attributes: Record<string, string>;
}

interface InstrumentationPlan {
  transactions: string[];
  spans: SpanDefinition[];
}

export interface ResolvedWidget {
  title: string;
  displayType: 'big_number' | 'area' | 'line' | 'table' | 'bar';
  widgetType: 'spans' | 'error-events';
  queries: Array<{
    name?: string;
    conditions: string;
    fields: string[];
    aggregates: string[];
    columns: string[];
    orderby: string;
  }>;
  layout: { x: number; y: number; w: number; h: number };
  priority: 'KPI' | 'chart' | 'detail';
}

export interface WidgetFailure {
  intent: string;
  reason: string;
  detail?: string;
}

export interface ResolutionResult {
  widgets: ResolvedWidget[];
  failures: WidgetFailure[];
}

// ── Template Bank ─────────────────────────────────────────────────────────────

export const WIDGET_TEMPLATE_BANK: ResolvedWidget[] = [
  {
    title: 'P95 Latency',
    displayType: 'big_number',
    widgetType: 'spans',
    queries: [{ name: '', conditions: '', fields: ['p95(span.duration)'], aggregates: ['p95(span.duration)'], columns: [], orderby: '' }],
    layout: { x: 0, y: 0, w: 2, h: 1 },
    priority: 'KPI'
  },
  {
    title: 'Error Rate',
    displayType: 'big_number',
    widgetType: 'spans',
    queries: [{ name: '', conditions: '', fields: ['failure_rate()'], aggregates: ['failure_rate()'], columns: [], orderby: '' }],
    layout: { x: 2, y: 0, w: 2, h: 1 },
    priority: 'KPI'
  },
  {
    title: 'Request Volume',
    displayType: 'big_number',
    widgetType: 'spans',
    queries: [{ name: '', conditions: '', fields: ['count()'], aggregates: ['count()'], columns: [], orderby: '' }],
    layout: { x: 4, y: 0, w: 2, h: 1 },
    priority: 'KPI'
  },
  {
    title: 'Latency Trend',
    displayType: 'area',
    widgetType: 'spans',
    queries: [{ name: '', conditions: '', fields: ['p95(span.duration)', 'p50(span.duration)'], aggregates: ['p95(span.duration)', 'p50(span.duration)'], columns: [], orderby: '' }],
    layout: { x: 0, y: 1, w: 4, h: 2 },
    priority: 'chart'
  },
  {
    title: 'Errors Over Time',
    displayType: 'line',
    widgetType: 'spans',
    queries: [{ name: '', conditions: 'span.status:error', fields: ['count()'], aggregates: ['count()'], columns: [], orderby: '' }],
    layout: { x: 4, y: 1, w: 2, h: 2 },
    priority: 'chart'
  },
  {
    title: 'Recent Transactions',
    displayType: 'table',
    widgetType: 'spans',
    queries: [{ name: '', conditions: '', fields: ['span.op', 'span.description', 'span.duration', 'span.status'], aggregates: [], columns: ['span.op', 'span.description', 'span.duration', 'span.status'], orderby: '-span.duration' }],
    layout: { x: 0, y: 3, w: 6, h: 2 },
    priority: 'detail'
  }
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function computeOverlapScore(intentTokens: string[], span: SpanDefinition): number {
  const haystack = `${span.name} ${span.description ?? ''}`.toLowerCase();
  return intentTokens.filter(token => haystack.includes(token)).length;
}

type Metric = 'duration' | 'error_rate' | 'throughput' | 'attribute_breakdown';

function detectMetric(intentText: string): Metric {
  if (/latency|duration|slow|fast|p95|p99/i.test(intentText)) return 'duration';
  if (/error|failure|fail|broken|down/i.test(intentText)) return 'error_rate';
  if (/count|volume|throughput|how many|requests/i.test(intentText)) return 'throughput';
  if (/breakdown|by |filter|group/i.test(intentText)) return 'attribute_breakdown';
  return 'duration';
}

function metricToFieldAndAggregate(metric: Metric): { field: string; aggregate: string } {
  switch (metric) {
    case 'duration':
      return { field: 'p95(span.duration)', aggregate: 'p95(span.duration)' };
    case 'error_rate':
      return { field: 'failure_rate()', aggregate: 'failure_rate()' };
    case 'throughput':
      return { field: 'count()', aggregate: 'count()' };
    case 'attribute_breakdown':
      return { field: 'count()', aggregate: 'count()' };
  }
}

function resolveDisplayType(
  priority: 'KPI' | 'chart' | 'detail',
  metric: Metric
): 'big_number' | 'area' | 'line' | 'table' | 'bar' {
  if (priority === 'KPI') return 'big_number';
  if (priority === 'detail') return 'table';
  // chart
  if (metric === 'error_rate') return 'line';
  if (metric === 'attribute_breakdown') return 'bar';
  return 'area';
}

// ── Layout tracker ────────────────────────────────────────────────────────────

interface LayoutState {
  kpiCount: number;
  chartNextX: number;
  chartNextY: number;
  tableNextY: number;
}

function assignLayout(
  priority: 'KPI' | 'chart' | 'detail',
  state: LayoutState
): { x: number; y: number; w: number; h: number } {
  if (priority === 'KPI') {
    const x = (state.kpiCount % 3) * 2;
    state.kpiCount++;
    return { x, y: 0, w: 2, h: 1 };
  }

  if (priority === 'chart') {
    const w = state.chartNextX === 0 ? 4 : 2;
    const layout = { x: state.chartNextX, y: state.chartNextY, w, h: 2 };
    state.chartNextX += w;
    if (state.chartNextX >= 6) {
      state.chartNextX = 0;
      state.chartNextY += 2;
    }
    // Keep table row below charts
    state.tableNextY = Math.max(state.tableNextY, state.chartNextY + (state.chartNextX > 0 ? 2 : 0));
    return layout;
  }

  // detail / table
  const layout = { x: 0, y: state.tableNextY, w: 6, h: 2 };
  state.tableNextY += 2;
  return layout;
}

// ── Main resolution function ──────────────────────────────────────────────────

export function resolveWidgetIntents(
  intents: WidgetIntent[],
  plan: InstrumentationPlan
): ResolutionResult {
  const widgets: ResolvedWidget[] = [];
  const failures: WidgetFailure[] = [];

  const layoutState: LayoutState = {
    kpiCount: 0,
    chartNextX: 0,
    chartNextY: 1,
    tableNextY: 3,
  };

  for (const widgetIntent of intents) {
    try {
      const intentTokens = tokenize(widgetIntent.intent);

      // 1. Span matching
      let matchedSpan: SpanDefinition | undefined;
      if (plan.spans.length > 0) {
        let bestScore = 0;
        for (const span of plan.spans) {
          const score = computeOverlapScore(intentTokens, span);
          if (score > bestScore) {
            bestScore = score;
            matchedSpan = span;
          }
        }
        // Fallback: use first span if no overlap found
        if (!matchedSpan || bestScore === 0) {
          matchedSpan = plan.spans[0];
        }
      }

      // 2. Metric mapping
      const metric = detectMetric(widgetIntent.intent);
      const { field, aggregate } = metricToFieldAndAggregate(metric);

      // For attribute_breakdown: try to extract an attribute from matched span
      let breakdownColumn = 'span.description';
      if (metric === 'attribute_breakdown' && matchedSpan) {
        const attrKeys = Object.keys(matchedSpan.attributes);
        if (attrKeys.length > 0) {
          // Try to find an attribute whose key appears in the intent text
          const found = attrKeys.find(k => widgetIntent.intent.toLowerCase().includes(k.toLowerCase()));
          if (found) breakdownColumn = found;
        }
      }

      // 3. Display type
      const displayType = resolveDisplayType(widgetIntent.priority, metric);

      // 4. Conditions
      const conditions = matchedSpan
        ? `span.description:${matchedSpan.name}`
        : '';

      // 5. Build query
      let query: ResolvedWidget['queries'][0];
      if (displayType === 'big_number' || displayType === 'area' || displayType === 'line') {
        query = {
          name: '',
          conditions,
          fields: [field],
          aggregates: [aggregate],
          columns: [],
          orderby: '',
        };
      } else if (displayType === 'table') {
        query = {
          name: '',
          conditions,
          fields: ['span.op', 'span.description', 'span.duration', 'span.status'],
          aggregates: [],
          columns: ['span.op', 'span.description', 'span.duration', 'span.status'],
          orderby: '-span.duration',
        };
      } else {
        // bar (attribute_breakdown)
        query = {
          name: '',
          conditions,
          fields: [aggregate],
          aggregates: [aggregate],
          columns: [breakdownColumn],
          orderby: `-${aggregate}`,
        };
      }

      // 6. Layout
      const layout = assignLayout(widgetIntent.priority, layoutState);

      // Derive a human-readable title from the intent
      const title = widgetIntent.intent.length > 40
        ? widgetIntent.intent.slice(0, 37) + '...'
        : widgetIntent.intent;

      widgets.push({
        title,
        displayType,
        widgetType: 'spans',
        queries: [query],
        layout,
        priority: widgetIntent.priority,
      });
    } catch (err) {
      failures.push({
        intent: widgetIntent.intent,
        reason: 'resolution_error',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { widgets, failures };
}

// ── KPI Layout Enforcement ────────────────────────────────────────────────────

export function applyKPILayout(widgets: ResolvedWidget[]): ResolvedWidget[] {
  // Sort: KPI first, chart second, detail last
  const priorityOrder: Record<string, number> = { KPI: 0, chart: 1, detail: 2 };
  const sorted = [...widgets].sort(
    (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
  );

  const layoutState: LayoutState = {
    kpiCount: 0,
    chartNextX: 0,
    chartNextY: 1,
    tableNextY: 3,
  };

  return sorted.map(widget => ({
    ...widget,
    layout: assignLayout(widget.priority, layoutState),
  }));
}
