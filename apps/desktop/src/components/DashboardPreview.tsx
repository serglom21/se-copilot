import React from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface DashboardWidget {
  title: string;
  displayType: string;
  query: string;
  widgetType?: string;
  interval?: string;
  series?: { name: string; color: string }[];
}

interface DashboardPreviewProps {
  dashboardPath: string;
}

// Sentry-like colors matching the mockup
const CHART_COLORS = [
  '#6E3FC9', // Purple (primary)
  '#D84CDA', // Pink/Magenta
  '#F59E0B', // Yellow/Orange
  '#10B981', // Green
  '#3B82F6', // Blue
  '#8B5CF6', // Light Purple
];

export default function DashboardPreview({ dashboardPath }: DashboardPreviewProps) {
  const [dashboard, setDashboard] = React.useState<{ title: string; widgets: DashboardWidget[] } | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    loadDashboard();
  }, [dashboardPath]);

  const loadDashboard = async () => {
    try {
      const content = await window.electronAPI.readFile(dashboardPath);
      const data = JSON.parse(content);
      setDashboard(data);
    } catch (error) {
      console.error('Failed to load dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  const generateTimeSeriesData = (widget: DashboardWidget) => {
    // Generate 15 data points over the last 45 minutes (matching mockup timeline)
    const now = new Date();
    const data = [];

    for (let i = 14; i >= 0; i--) {
      const time = new Date(now.getTime() - i * 3 * 60 * 1000); // 3 minute intervals
      const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

      const dataPoint: any = { time: timeStr };

      // Parse series from query or use default
      const series = extractSeriesFromQuery(widget.query);

      series.forEach((seriesName, idx) => {
        // Generate realistic data based on widget type
        if (widget.title.toLowerCase().includes('error')) {
          // Errors: mostly flat at 0, occasional small values
          if (i < 3) {
            dataPoint[seriesName] = Math.random() * 1.2;
          } else {
            dataPoint[seriesName] = Math.random() * 0.3;
          }
        } else if (widget.title.toLowerCase().includes('performance') || widget.title.toLowerCase().includes('duration')) {
          // Performance metrics: gradual increase towards the end
          const progress = (14 - i) / 14;
          const spike = i < 3 ? Math.pow(progress, 3) * 200 : 0;
          dataPoint[seriesName] = Math.max(0, spike + Math.random() * 50);
        } else if (widget.title.toLowerCase().includes('volume') || widget.title.toLowerCase().includes('count')) {
          // Volume/count data: spike at the end
          const progress = (14 - i) / 14;
          const spike = i < 3 ? Math.pow(progress, 4) * 15 : 0;
          dataPoint[seriesName] = Math.max(0, spike + Math.random() * 2);
        } else {
          // Default: gradual increase with spike at end
          const progress = (14 - i) / 14;
          const spike = i < 4 ? Math.pow(progress, 3) * 100 : 0;
          dataPoint[seriesName] = Math.max(0, spike + Math.random() * 10);
        }
      });

      data.push(dataPoint);
    }

    return data;
  };

  const extractSeriesFromQuery = (query: string): string[] => {
    // Try to extract span/transaction names from the query
    // Parse patterns like: span.op:checkout, transaction:api/users, etc.

    const series: string[] = [];

    // Match span operations
    const spanMatches = query.matchAll(/span\.op:(\w+[\.\w]*)/g);
    for (const match of spanMatches) {
      series.push(match[1]);
    }

    // Match transaction names
    const transactionMatches = query.matchAll(/transaction:([^\s,)]+)/g);
    for (const match of transactionMatches) {
      const txName = match[1].replace(/['"]/g, ''); // Remove quotes
      series.push(txName);
    }

    // Match field names like count(), avg(duration), etc.
    const fieldMatches = query.matchAll(/(\w+)\([^)]*\)/g);
    for (const match of fieldMatches) {
      if (match[1] !== 'count' && !series.includes(match[1])) {
        series.push(match[0]); // Include the full function call
      }
    }

    // If no series found, create default based on widget title
    if (series.length === 0) {
      series.push('count()');
    }

    // Limit to 5 series for readability
    return series.slice(0, 5);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-gray-500">Loading dashboard preview...</div>
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

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">{dashboard.title}</h3>
        <p className="text-sm text-gray-600">Preview of your Sentry dashboard</p>
      </div>

      {/* Grid layout matching Sentry's 2-column dashboard */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4">
        {dashboard.widgets.map((widget, idx) => {
          const data = generateTimeSeriesData(widget);
          const series = extractSeriesFromQuery(widget.query);

          return (
            <div key={idx} className="bg-white border border-gray-200 rounded-lg p-4">
              {/* Widget title */}
              <div className="mb-3">
                <h4 className="text-sm font-semibold text-gray-900 truncate">{widget.title}</h4>
              </div>

              {/* Chart */}
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: '#6B7280' }}
                      tickLine={false}
                      axisLine={{ stroke: '#E5E7EB' }}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#6B7280' }}
                      tickLine={false}
                      axisLine={{ stroke: '#E5E7EB' }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1F2937',
                        border: 'none',
                        borderRadius: '6px',
                        fontSize: '12px',
                        color: '#F9FAFB',
                      }}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: '11px' }}
                      iconType="square"
                    />
                    {series.map((seriesName, seriesIdx) => (
                      <Area
                        key={seriesName}
                        type="monotone"
                        dataKey={seriesName}
                        stackId={widget.displayType === 'area' ? '1' : undefined}
                        stroke={CHART_COLORS[seriesIdx % CHART_COLORS.length]}
                        fill={CHART_COLORS[seriesIdx % CHART_COLORS.length]}
                        fillOpacity={0.7}
                        strokeWidth={2}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
        <strong>ℹ️ Preview Note</strong>
        <p className="mt-1">
          This is a preview with generated sample data. Once pushed to Sentry, the dashboard will display real
          performance data from your application.
        </p>
      </div>
    </div>
  );
}
