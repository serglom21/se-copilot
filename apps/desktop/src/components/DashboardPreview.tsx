import React from 'react';
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

interface DashboardWidget {
  title: string;
  description?: string;
  displayType: string;
  widgetType?: string;
  interval?: string;
  limit?: number;
  queries?: Array<{
    aggregates: string[];
    columns: string[];
    conditions: string;
    fields: string[];
    orderby: string;
    name: string;
  }>;
  // legacy single-query format
  query?: string;
}

interface DashboardPreviewProps {
  dashboardPath: string;
}

const CHART_COLORS = [
  '#6E3FC9',
  '#D84CDA',
  '#F59E0B',
  '#10B981',
  '#3B82F6',
  '#8B5CF6',
];

export default function DashboardPreview({ dashboardPath }: DashboardPreviewProps) {
  const [dashboard, setDashboard] = React.useState<{ title: string; widgets: DashboardWidget[] } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    loadDashboard();
  }, [dashboardPath]);

  const loadDashboard = async () => {
    try {
      const content = await window.electronAPI.readFile(dashboardPath);
      const data = JSON.parse(content);
      setDashboard(data);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  // Extract the primary aggregate label from a widget (e.g. "p95(span.duration)")
  const getPrimaryAggregate = (widget: DashboardWidget): string => {
    const q = widget.queries?.[0];
    if (q?.aggregates?.length) return q.aggregates[0];
    return widget.query || 'count()';
  };

  // Derive series names for chart widgets from the aggregates list
  const getSeriesNames = (widget: DashboardWidget): string[] => {
    const q = widget.queries?.[0];
    if (q?.aggregates?.length) return q.aggregates.slice(0, 4);
    const query = widget.query || '';
    const matches = [...query.matchAll(/(\w+\([^)]*\))/g)].map(m => m[1]);
    return matches.length > 0 ? matches.slice(0, 4) : ['count()'];
  };

  const generateTimeSeriesData = (widget: DashboardWidget) => {
    const now = new Date();
    return Array.from({ length: 15 }, (_, i) => {
      const t = new Date(now.getTime() - (14 - i) * 3 * 60 * 1000);
      const timeStr = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      const dataPoint: any = { time: timeStr };
      const isLatency = widget.title.toLowerCase().includes('latency') || widget.title.toLowerCase().includes('p95');
      const isError = widget.title.toLowerCase().includes('error');
      const progress = i / 14;

      getSeriesNames(widget).forEach(name => {
        if (isError) {
          dataPoint[name] = i > 11 ? Math.random() * 3 : Math.random() * 0.4;
        } else if (isLatency) {
          dataPoint[name] = 80 + Math.random() * 40 + (i > 11 ? progress * 60 : 0);
        } else {
          dataPoint[name] = 5 + Math.random() * 8 + (i > 11 ? progress * 12 : 0);
        }
      });

      return dataPoint;
    });
  };

  const generateTableData = (widget: DashboardWidget) => {
    const q = widget.queries?.[0];
    const fields = q?.fields ?? ['span.description', 'span.op', 'p95(span.duration)', 'count(span.duration)'];
    const rows = [
      { 'span.description': 'POST /api/signup/form-submission', 'span.op': 'operation', 'p95(span.duration)': '412ms', 'count(span.duration)': 847 },
      { 'span.description': 'POST /api/signup/validate-email', 'span.op': 'operation', 'p95(span.duration)': '289ms', 'count(span.duration)': 1203 },
      { 'span.description': 'GET /api/signup/form',           'span.op': 'signup',    'p95(span.duration)': '198ms', 'count(span.duration)': 2041 },
      { 'span.description': 'POST /api/signup/create-user',   'span.op': 'operation', 'p95(span.duration)': '534ms', 'count(span.duration)': 612 },
      { 'span.description': 'input.focus',                    'span.op': 'input',     'p95(span.duration)': '12ms',  'count(span.duration)': 4387 },
    ];
    return { fields, rows: rows.slice(0, widget.limit ?? 5) };
  };

  const generateBigNumber = (widget: DashboardWidget): string => {
    const agg = getPrimaryAggregate(widget);
    if (agg.startsWith('p95') || agg.startsWith('p99') || agg.startsWith('avg')) return '243ms';
    if (agg.startsWith('failure_rate') || agg.startsWith('error_rate')) return '0.8%';
    if (widget.widgetType === 'error-events') return '12';
    return '1,847';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-gray-500">Loading dashboard preview...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
        <strong>❌ Error loading dashboard</strong>
        <p className="mt-1">{error}</p>
        <p className="mt-2 text-xs text-red-600">Path: {dashboardPath}</p>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
        <strong>⚠️ Dashboard not found</strong>
        <p className="mt-1">Generate the dashboard JSON first to see a preview.</p>
      </div>
    );
  }

  const renderWidget = (widget: DashboardWidget, idx: number) => {
    const displayType = widget.displayType || 'area';

    // ── Big Number ─────────────────────────────────────────────────────────
    if (displayType === 'big_number') {
      const value = generateBigNumber(widget);
      const agg = getPrimaryAggregate(widget);
      return (
        <div key={idx} className="bg-white border border-gray-200 rounded-lg p-5 flex flex-col justify-between">
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide truncate">{widget.title}</h4>
            {widget.description && (
              <p className="text-xs text-gray-400 mt-0.5 truncate">{widget.description}</p>
            )}
          </div>
          <div>
            <div className="text-4xl font-bold text-gray-900 mt-3">{value}</div>
            <div className="text-xs text-gray-400 mt-1">{agg}</div>
          </div>
        </div>
      );
    }

    // ── Table ──────────────────────────────────────────────────────────────
    if (displayType === 'table') {
      const { fields, rows } = generateTableData(widget);
      return (
        <div key={idx} className="bg-white border border-gray-200 rounded-lg p-4 col-span-full">
          <div className="mb-3">
            <h4 className="text-sm font-semibold text-gray-900">{widget.title}</h4>
            {widget.description && (
              <p className="text-xs text-gray-500 mt-0.5">{widget.description}</p>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100">
                  {fields.map(f => (
                    <th key={f} className="text-left py-2 pr-4 text-gray-500 font-medium whitespace-nowrap">{f}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rIdx) => (
                  <tr key={rIdx} className="border-b border-gray-50 hover:bg-gray-50">
                    {fields.map(f => (
                      <td key={f} className="py-2 pr-4 text-gray-800 whitespace-nowrap font-mono">{String(row[f] ?? '—')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    // ── Line / Area charts ─────────────────────────────────────────────────
    const data = generateTimeSeriesData(widget);
    const series = getSeriesNames(widget);
    const ChartComponent = displayType === 'line' ? LineChart : AreaChart;

    return (
      <div key={idx} className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="mb-3">
          <h4 className="text-sm font-semibold text-gray-900 truncate">{widget.title}</h4>
          {widget.description && (
            <p className="text-xs text-gray-400 mt-0.5 truncate">{widget.description}</p>
          )}
        </div>
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <ChartComponent data={data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#9CA3AF' }} tickLine={false} axisLine={{ stroke: '#E5E7EB' }} />
              <YAxis tick={{ fontSize: 9, fill: '#9CA3AF' }} tickLine={false} axisLine={{ stroke: '#E5E7EB' }} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1F2937', border: 'none', borderRadius: '6px', fontSize: '11px', color: '#F9FAFB' }}
              />
              <Legend wrapperStyle={{ fontSize: '10px' }} iconType="square" />
              {series.map((name, sIdx) =>
                displayType === 'line' ? (
                  <Line
                    key={name} type="monotone" dataKey={name}
                    stroke={CHART_COLORS[sIdx % CHART_COLORS.length]}
                    strokeWidth={2} dot={false}
                  />
                ) : (
                  <Area
                    key={name} type="monotone" dataKey={name}
                    stackId="1"
                    stroke={CHART_COLORS[sIdx % CHART_COLORS.length]}
                    fill={CHART_COLORS[sIdx % CHART_COLORS.length]}
                    fillOpacity={0.5} strokeWidth={2}
                  />
                )
              )}
            </ChartComponent>
          </ResponsiveContainer>
        </div>
      </div>
    );
  };

  const bigNumbers = dashboard.widgets.filter(w => w.displayType === 'big_number');
  const tables = dashboard.widgets.filter(w => w.displayType === 'table');
  const charts = dashboard.widgets.filter(w => w.displayType !== 'big_number' && w.displayType !== 'table');

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">{dashboard.title}</h3>
        <p className="text-sm text-gray-500">Preview of your Sentry dashboard</p>
      </div>

      {/* KPI row */}
      {bigNumbers.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          {bigNumbers.map((w, i) => renderWidget(w, i))}
        </div>
      )}

      {/* Chart widgets */}
      {charts.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {charts.map((w, i) => renderWidget(w, bigNumbers.length + i))}
        </div>
      )}

      {/* Table widgets (full width) */}
      {tables.length > 0 && (
        <div className="grid grid-cols-1 gap-4">
          {tables.map((w, i) => renderWidget(w, bigNumbers.length + charts.length + i))}
        </div>
      )}

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
        <strong>ℹ️ Preview Note</strong>
        <p className="mt-1">
          This is a preview with sample data. Once pushed to Sentry, all widgets will display live data from your application.
        </p>
      </div>
    </div>
  );
}
