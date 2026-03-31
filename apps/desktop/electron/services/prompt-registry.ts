// ---------------------------------------------------------------------------
// Prompt Registry — validates LLM prompts against registered capability tags
// before any LLM call. A missing required capability throws an explicit error
// rather than silently regressing quality.
// ---------------------------------------------------------------------------

export interface PromptRequirement {
  id: string;
  description: string;
  check: (prompt: string) => boolean;
}

export interface RegisteredPrompt {
  id: string;
  description: string;
  requirements: PromptRequirement[];
}

export interface PromptValidationResult {
  valid: boolean;
  missing: { id: string; description: string }[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const PROMPT_REGISTRY: RegisteredPrompt[] = [
  {
    id: 'generateWebPages',
    description: 'Next.js page generation with full UI and instrumentation markers',
    requirements: [
      {
        id: 'ui:client-directive',
        description: "Prompt must require 'use client' directive on every page",
        check: (p) => p.includes("'use client'") || p.includes('"use client"'),
      },
      {
        id: 'ui:state-management',
        description: 'Prompt must require useState and useEffect',
        check: (p) => p.includes('useState') && p.includes('useEffect'),
      },
      {
        id: 'ui:loading-state',
        description: 'Prompt must require a loading state',
        check: (p) => /loading\s*state|loading.*spinner|animate-spin|setLoading/i.test(p),
      },
      {
        id: 'ui:error-state',
        description: 'Prompt must require an error state',
        check: (p) => /error\s*state|setError|error.*message/i.test(p),
      },
      {
        id: 'ui:empty-state',
        description: 'Prompt must require an empty state',
        check: (p) => /empty\s*state|no.*items.*found|no.*results/i.test(p),
      },
      {
        id: 'ui:data-testid',
        description: 'Prompt must require data-testid on interactive elements',
        check: (p) => p.includes('data-testid'),
      },
      {
        id: 'ui:tailwind',
        description: 'Prompt must require Tailwind CSS styling',
        check: (p) => /tailwind/i.test(p),
      },
      {
        id: 'ui:realistic-data',
        description: 'Prompt must require realistic vertical-specific data',
        check: (p) => /realistic|vertical.specific|domain.specific|hardcode.*sample/i.test(p),
      },
      {
        id: 'ui:api-calls',
        description: 'Prompt must require API calls with try/catch',
        check: (p) => p.includes('try') && p.includes('catch') && p.includes('fetch'),
      },
      {
        id: 'instrumentation:no-sdk',
        description: 'Prompt must forbid direct @sentry/* imports',
        check: (p) => /do not import.*@sentry|NOT import.*@sentry|no.*@sentry/i.test(p),
      },
      {
        id: 'instrumentation:marker-format',
        description: 'Prompt must specify // INSTRUMENT: marker format',
        check: (p) => p.includes('// INSTRUMENT:'),
      },
      {
        id: 'instrumentation:exact-span-names',
        description: 'Prompt must require exact span names in markers',
        check: (p) => /exact.*span.*name|exact_span_name|EXACT span/i.test(p),
      },
      {
        id: 'example:rich-ui',
        description: 'Prompt must include a rich, realistic UI code example',
        check: (p) =>
          p.includes('useState') &&
          p.includes('data-testid') &&
          p.includes('// INSTRUMENT:') &&
          p.length > 3000,
      },
      {
        id: 'pages:contract-enforced',
        description: 'Prompt must include the API contract and instruct exact URL usage',
        check: (p) => /API CONTRACT|api.contract|use.*exact.*URL|paths given here verbatim/i.test(p),
      },
      {
        id: 'pages:no-url-derivation',
        description: 'Prompt must instruct the LLM not to derive URLs from span names',
        check: (p) => /do not derive|use the path.*given|paths given here verbatim/i.test(p),
      },
      {
        id: 'pages:localhost-port',
        description: 'Prompt must specify the backend port (localhost:3001)',
        check: (p) => p.includes('localhost:3001'),
      },
      {
        id: 'pages:se-copilot-run-id',
        description: 'Prompt must require se_copilot_run_id in POST/PUT/DELETE request bodies',
        check: (p) => p.includes('se_copilot_run_id'),
      },
      {
        id: 'pages:contract-checklist',
        description: 'Prompt must include the CONTRACT COMPLIANCE checklist with exact span names',
        check: (p) => /CONTRACT COMPLIANCE|BEFORE WRITING ANY CODE/.test(p),
      },
      {
        id: 'pages:no-invented-spans',
        description: 'Prompt must explicitly forbid inventing span names not in the contract',
        check: (p) => /invented|NOT in the list|remove it immediately|inventing spans/i.test(p),
      },
    ],
  },
  {
    id: 'generateExpressRoutes',
    description: 'Express route generation with instrumentation markers',
    requirements: [
      {
        id: 'routes:no-sdk',
        description: 'Prompt must forbid Sentry SDK imports in route code',
        check: (p) => /do not import.*@sentry|NOT.*sentry.*import|no.*sentry.*sdk/i.test(p),
      },
      {
        id: 'routes:marker-format',
        description: 'Prompt must specify // INSTRUMENT: marker format for routes',
        check: (p) => p.includes('// INSTRUMENT:'),
      },
      {
        id: 'routes:realistic-data',
        description: 'Prompt must require realistic domain data in route responses',
        check: (p) => /realistic|domain.*data|vertical.*data|sample.*data/i.test(p),
      },
      {
        id: 'routes:error-handling',
        description: 'Prompt must require proper error handling in routes',
        check: (p) => /error.*handling|try.*catch|500.*error|error.*response/i.test(p),
      },
      {
        id: 'routes:continue-trace',
        description: 'Prompt must reference distributed tracing or trace propagation',
        check: (p) =>
          /distributed.*trac|continueTrace|trace.*propagat|sentry-trace|baggage/i.test(p),
      },
      {
        id: 'routes:contract-enforced',
        description: 'Prompt must include the route contract and instruct exact path usage',
        check: (p) => /ROUTE CONTRACT|route.contract|path column|use the exact.*path/i.test(p),
      },
      {
        id: 'routes:no-path-derivation',
        description: 'Prompt must instruct the LLM not to derive paths from span names',
        check: (p) => /do not derive|use the path.*given|paths given here verbatim/i.test(p),
      },
      {
        id: 'routes:se-copilot-run-id',
        description: 'Prompt must require se_copilot_run_id in every route handler',
        check: (p) => p.includes('se_copilot_run_id'),
      },
      {
        id: 'routes:contract-checklist',
        description: 'Prompt must include the CONTRACT COMPLIANCE checklist with exact span names',
        check: (p) => /CONTRACT COMPLIANCE|BEFORE WRITING ANY CODE/.test(p),
      },
      {
        id: 'routes:no-invented-spans',
        description: 'Prompt must explicitly forbid inventing span names not in the contract',
        check: (p) => /invented|NOT in the list|remove it immediately|inventing spans/i.test(p),
      },
    ],
  },
  {
    id: 'generateInstrumentationPlan',
    description: 'Instrumentation plan generation that outputs spanIntent not op',
    requirements: [
      {
        id: 'plan:no-op-field',
        description: 'Prompt must NOT ask LLM to output an op field',
        check: (p) => !/output.*"op"|"op".*field.*required|include.*"op".*span/i.test(p),
      },
      {
        id: 'plan:span-intent',
        description: 'Prompt must require spanIntent field in output',
        check: (p) => /spanIntent|span_intent/i.test(p),
      },
      {
        id: 'plan:no-fixed-count',
        description: 'Prompt must not hardcode a fixed span count',
        check: (p) => !/exactly \d+ span|generate \d+ span|must have \d+ span/i.test(p),
      },
      {
        id: 'plan:reasoning-guidance',
        description: 'Prompt must provide guidance for span selection reasoning',
        check: (p) =>
          /reason|appropriate|based on|coverage|critical path|user journey/i.test(p),
      },
    ],
  },
  {
    id: 'generateDashboardWidgets',
    description: 'Dashboard widget generation using intent-only pipeline',
    requirements: [
      {
        id: 'dashboard:no-field-names',
        description: 'Prompt must not ask LLM to output Sentry field name strings',
        check: (p) =>
          !/output.*field.*name|"fields".*sentry|sentry.*field.*string/i.test(p),
      },
      {
        id: 'dashboard:intent-only',
        description: 'Prompt must ask LLM for plain-English intents, not widget configs',
        check: (p) =>
          /plain.English|intent|natural language|describe.*widget|what.*measure/i.test(p),
      },
      {
        id: 'dashboard:no-fixed-count',
        description: 'Prompt must not hardcode a widget count',
        check: (p) => !/exactly \d+ widget|generate \d+ widget|must have \d+ widget/i.test(p),
      },
      {
        id: 'dashboard:frozen-plan-context',
        description: 'Prompt must reference the instrumentation plan as context',
        check: (p) =>
          /plan\.json|instrumentation plan|span.*names.*plan|plan.*context/i.test(p),
      },
    ],
  },
  {
    id: 'generateUserFlows',
    description: 'User flow generation grounded in DOM manifest selectors',
    requirements: [
      {
        id: 'flows:journey-not-steps',
        description: 'Prompt must describe flows as user journeys, not test scripts',
        check: (p) => /user.*journey|realistic.*user|natural.*flow|as a.*user/i.test(p),
      },
      {
        id: 'flows:no-css-selectors',
        description: 'Prompt must not ask for CSS selectors (.class, #id)',
        check: (p) => !/CSS selector|querySelector|\.class.*selector|#id.*selector/i.test(p),
      },
      {
        id: 'flows:dom-manifest-context',
        description: 'Prompt must include DOM manifest or data-testid context',
        check: (p) => /dom.manifest|data-testid|testid.*selector|available.*selector/i.test(p),
      },
      {
        id: 'flows:realistic-data',
        description: 'Prompt must require realistic user behavior and data',
        check: (p) => /realistic|real.*user|actual.*user|typical.*user/i.test(p),
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validatePrompt(promptId: string, prompt: string): PromptValidationResult {
  const registered = PROMPT_REGISTRY.find((r) => r.id === promptId);
  if (!registered) {
    // Unknown prompt IDs are allowed — no requirements to enforce
    return { valid: true, missing: [] };
  }

  const missing = registered.requirements
    .filter((req) => !req.check(prompt))
    .map((req) => ({ id: req.id, description: req.description }));

  if (missing.length > 0) {
    const lines = missing.map((m) => `  • [${m.id}] ${m.description}`).join('\n');
    throw new Error(
      `[PromptRegistry] Prompt "${promptId}" is missing required capabilities:\n${lines}\n\n` +
        `This is a prompt integrity violation. Update the prompt in llm.ts to restore these requirements ` +
        `before calling the LLM. Do NOT suppress this error — it prevents silent quality regressions.`,
    );
  }

  return { valid: true, missing: [] };
}

// ---------------------------------------------------------------------------
// Vertical examples — rich, realistic page examples per industry vertical.
// Used in Section C of generateWebPages() to anchor LLM output quality.
// Each example demonstrates: 'use client', useState/useEffect, loading/error/
// empty states, data-testid attributes, Tailwind CSS, realistic domain data,
// API calls with try/catch, and // INSTRUMENT: markers alongside real code.
// ---------------------------------------------------------------------------

export function getVerticalExample(vertical: string): string {
  const v = (vertical ?? '').toLowerCase();

  if (v.includes('health') || v.includes('medical') || v.includes('clinic')) {
    return HEALTHCARE_EXAMPLE;
  }
  if (v.includes('ecommerce') || v.includes('e-commerce') || v.includes('retail') || v.includes('shop')) {
    return ECOMMERCE_EXAMPLE;
  }
  if (v.includes('logistic') || v.includes('shipping') || v.includes('freight') || v.includes('supply')) {
    return LOGISTICS_EXAMPLE;
  }
  if (v.includes('saas') || v.includes('b2b') || v.includes('platform') || v.includes('subscription')) {
    return SAAS_EXAMPLE;
  }
  // Default: fintech (also matches 'fintech', 'banking', 'payment', 'finance')
  return FINTECH_EXAMPLE;
}

// ---------------------------------------------------------------------------
// Fintech example — transaction list with send-money form
// ---------------------------------------------------------------------------

const FINTECH_EXAMPLE = `\`\`\`typescript
'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';

interface Transaction {
  id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'completed' | 'failed';
  merchant: string;
  category: string;
  createdAt: string;
}

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { loadTransactions(); }, []);

  const loadTransactions = async () => {
    setLoading(true);
    setError(null);
    try {
      // INSTRUMENT: payment.list_transactions — fetches paginated transaction history for the authenticated user
      const res = await fetch('http://localhost:3001/api/payment/list-transactions');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      setTransactions(data.transactions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load transactions');
    } finally {
      setLoading(false);
    }
  };

  const handleSendPayment = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      // INSTRUMENT: payment.process_payment — validates recipient account and initiates the payment transfer
      const res = await fetch('http://localhost:3001/api/payment/process-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: form.get('recipient'),
          amount: parseFloat(form.get('amount') as string),
          currency: 'USD',
        }),
      });
      if (!res.ok) throw new Error('Payment failed');
      await loadTransactions();
      (e.target as HTMLFormElement).reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div className="flex justify-center items-center min-h-screen bg-gray-50">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-500" />
    </div>
  );

  if (error) return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 flex items-center gap-3">
        <span>⚠️ {error}</span>
        <button onClick={loadTransactions} data-testid="retry-button"
          className="underline text-sm hover:text-red-900">
          Retry
        </button>
      </div>
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 bg-gray-50 min-h-screen">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-gray-900">💳 My Account</h1>
        <Link href="/history" data-testid="view-history-link"
          className="text-indigo-600 hover:text-indigo-800 text-sm font-medium">
          Full history →
        </Link>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Send Money</h2>
        <form onSubmit={handleSendPayment} className="flex gap-3 flex-wrap">
          <input name="recipient" placeholder="Recipient email or account ID" required
            data-testid="recipient-input"
            className="flex-1 min-w-48 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          <input name="amount" type="number" step="0.01" min="0.01" placeholder="Amount (USD)" required
            data-testid="amount-input"
            className="w-36 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          <button type="submit" disabled={submitting} data-testid="send-payment-button"
            className="bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition">
            {submitting ? 'Sending...' : 'Send'}
          </button>
        </form>
      </div>

      <h2 className="text-lg font-semibold text-gray-800 mb-3">Recent Transactions</h2>
      {transactions.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-100 shadow-sm">
          <p className="text-4xl mb-2">💸</p>
          <p className="text-gray-500">No transactions yet</p>
          <p className="text-gray-400 text-sm mt-1">Your recent activity will appear here</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
          {transactions.map(tx => (
            <div key={tx.id} className="flex items-center justify-between px-5 py-4 hover:bg-gray-50">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center text-xl">
                  {tx.category === 'food' ? '🍔' : tx.category === 'transport' ? '🚗' : '💰'}
                </div>
                <div>
                  <p className="font-medium text-gray-900">{tx.merchant}</p>
                  <p className="text-xs text-gray-400">{new Date(tx.createdAt).toLocaleDateString()}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium px-2 py-1 rounded-full bg-green-100 text-green-700">
                  {tx.status}
                </span>
                <span className="font-semibold text-gray-800">\${tx.amount.toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
\`\`\``;

// ---------------------------------------------------------------------------
// Healthcare example — patient appointment management
// ---------------------------------------------------------------------------

const HEALTHCARE_EXAMPLE = `\`\`\`typescript
'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';

interface Appointment {
  id: string;
  patientName: string;
  patientId: string;
  dateTime: string;
  type: 'check-up' | 'follow-up' | 'urgent' | 'specialist';
  status: 'scheduled' | 'completed' | 'cancelled' | 'no-show';
  provider: string;
  notes: string;
}

export default function AppointmentsPage() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('all');

  useEffect(() => { loadAppointments(); }, []);

  const loadAppointments = async () => {
    setLoading(true);
    setError(null);
    try {
      // INSTRUMENT: appointment.list_appointments — fetches upcoming and recent appointments for the current provider
      const res = await fetch('http://localhost:3001/api/appointment/list-appointments');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      setAppointments(data.appointments ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load appointments');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async (appointmentId: string) => {
    setCancelling(appointmentId);
    try {
      // INSTRUMENT: appointment.cancel_appointment — cancels a scheduled appointment and notifies the patient
      const res = await fetch('http://localhost:3001/api/appointment/cancel-appointment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointmentId, reason: 'Cancelled by provider' }),
      });
      if (!res.ok) throw new Error('Cancellation failed');
      await loadAppointments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancellation failed');
    } finally {
      setCancelling(null);
    }
  };

  const typeColor = (type: string) =>
    type === 'urgent' ? 'bg-red-100 text-red-700'
    : type === 'specialist' ? 'bg-purple-100 text-purple-700'
    : type === 'follow-up' ? 'bg-blue-100 text-blue-700'
    : 'bg-gray-100 text-gray-700';

  const filtered = filterType === 'all' ? appointments : appointments.filter(a => a.type === filterType);

  if (loading) return (
    <div className="flex justify-center items-center min-h-screen bg-gray-50">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-teal-500" />
    </div>
  );

  if (error) return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 flex items-center gap-3">
        <span>⚠️ {error}</span>
        <button onClick={loadAppointments} data-testid="retry-button" className="underline text-sm">Retry</button>
      </div>
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 bg-gray-50 min-h-screen">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-gray-900">🏥 Appointments</h1>
        <Link href="/appointments/new" data-testid="new-appointment-button"
          className="bg-teal-600 text-white px-4 py-2 rounded-lg hover:bg-teal-700 transition text-sm font-medium">
          + New Appointment
        </Link>
      </div>

      <div className="flex gap-2 mb-5">
        {['all', 'check-up', 'follow-up', 'urgent', 'specialist'].map(t => (
          <button key={t} onClick={() => setFilterType(t)}
            data-testid={'filter-' + t + '-tab'}
            className={'px-3 py-1 rounded-full text-sm font-medium transition ' +
              (filterType === t ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200')}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
          <p className="text-4xl mb-2">📅</p>
          <p className="text-gray-500 text-lg">No appointments found</p>
          <p className="text-gray-400 text-sm mt-1">Scheduled appointments will appear here</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(appt => (
            <div key={appt.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 flex items-start justify-between">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-full bg-teal-50 flex items-center justify-center text-2xl">
                  {appt.type === 'urgent' ? '🚨' : appt.type === 'specialist' ? '👨‍⚕️' : '📋'}
                </div>
                <div>
                  <p className="font-semibold text-gray-900">{appt.patientName}</p>
                  <p className="text-sm text-gray-500">Provider: {appt.provider}</p>
                  <p className="text-sm text-gray-400">{new Date(appt.dateTime).toLocaleString()}</p>
                  <span className={'inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium ' + typeColor(appt.type)}>
                    {appt.type}
                  </span>
                </div>
              </div>
              {appt.status === 'scheduled' && (
                <button onClick={() => handleCancel(appt.id)}
                  disabled={cancelling === appt.id}
                  data-testid={'cancel-' + appt.id + '-button'}
                  className="text-sm text-red-600 hover:text-red-800 border border-red-200 px-3 py-1 rounded-lg disabled:opacity-50">
                  {cancelling === appt.id ? 'Cancelling...' : 'Cancel'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
\`\`\``;

// ---------------------------------------------------------------------------
// Ecommerce example — order management dashboard
// ---------------------------------------------------------------------------

const ECOMMERCE_EXAMPLE = `\`\`\`typescript
'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';

interface Order {
  id: string;
  orderNumber: string;
  customer: string;
  email: string;
  total: number;
  itemCount: number;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'refunded';
  createdAt: string;
  shippingAddress: string;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [fulfilling, setFulfilling] = useState<string | null>(null);

  useEffect(() => { loadOrders(); }, []);

  const loadOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      // INSTRUMENT: order.list_orders — fetches all orders with optional status filter for the merchant dashboard
      const url = statusFilter !== 'all'
        ? 'http://localhost:3001/api/order/list-orders?status=' + statusFilter
        : 'http://localhost:3001/api/order/list-orders';
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      setOrders(data.orders ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  };

  const handleFulfill = async (orderId: string) => {
    setFulfilling(orderId);
    try {
      // INSTRUMENT: order.fulfill_order — marks an order as fulfilled, generates shipping label and notifies customer
      const res = await fetch('http://localhost:3001/api/order/fulfill-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      });
      if (!res.ok) throw new Error('Fulfillment failed');
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fulfillment failed');
    } finally {
      setFulfilling(null);
    }
  };

  const statusBadge = (status: string) =>
    status === 'delivered' ? 'bg-green-100 text-green-700'
    : status === 'shipped' ? 'bg-blue-100 text-blue-700'
    : status === 'processing' ? 'bg-yellow-100 text-yellow-700'
    : status === 'refunded' ? 'bg-gray-100 text-gray-500'
    : 'bg-orange-100 text-orange-700';

  if (loading) return (
    <div className="flex justify-center items-center min-h-screen bg-gray-50">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500" />
    </div>
  );

  if (error) return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 flex gap-3 items-center">
        <span>⚠️ {error}</span>
        <button onClick={loadOrders} data-testid="retry-button" className="underline text-sm">Retry</button>
      </div>
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 bg-gray-50 min-h-screen">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-gray-900">📦 Orders</h1>
        <Link href="/inventory" data-testid="manage-inventory-link"
          className="text-purple-600 hover:text-purple-800 text-sm font-medium">
          Manage Inventory →
        </Link>
      </div>

      <div className="flex gap-2 mb-5 flex-wrap">
        {['all', 'pending', 'processing', 'shipped', 'delivered', 'refunded'].map(s => (
          <button key={s} onClick={() => { setStatusFilter(s); loadOrders(); }}
            data-testid={'filter-' + s + '-button'}
            className={'px-3 py-1 rounded-full text-sm font-medium transition ' +
              (statusFilter === s ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200')}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {orders.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
          <p className="text-5xl mb-3">🛍️</p>
          <p className="text-gray-500 text-lg">No orders found</p>
          <p className="text-gray-400 text-sm mt-1">Orders matching your filter will appear here</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="px-5 py-3 text-left text-gray-500 font-medium">Order</th>
                <th className="px-5 py-3 text-left text-gray-500 font-medium">Customer</th>
                <th className="px-5 py-3 text-left text-gray-500 font-medium">Items</th>
                <th className="px-5 py-3 text-left text-gray-500 font-medium">Total</th>
                <th className="px-5 py-3 text-left text-gray-500 font-medium">Status</th>
                <th className="px-5 py-3 text-left text-gray-500 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {orders.map(order => (
                <tr key={order.id} className="hover:bg-gray-50">
                  <td className="px-5 py-4">
                    <p className="font-medium text-gray-900">{order.orderNumber}</p>
                    <p className="text-xs text-gray-400">{new Date(order.createdAt).toLocaleDateString()}</p>
                  </td>
                  <td className="px-5 py-4">
                    <p className="text-gray-900">{order.customer}</p>
                    <p className="text-xs text-gray-400">{order.email}</p>
                  </td>
                  <td className="px-5 py-4 text-gray-600">{order.itemCount} items</td>
                  <td className="px-5 py-4 font-semibold text-gray-900">\${order.total.toFixed(2)}</td>
                  <td className="px-5 py-4">
                    <span className={'text-xs px-2 py-1 rounded-full font-medium ' + statusBadge(order.status)}>
                      {order.status}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    {order.status === 'processing' && (
                      <button onClick={() => handleFulfill(order.id)}
                        disabled={fulfilling === order.id}
                        data-testid={'fulfill-' + order.id + '-button'}
                        className="bg-purple-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-purple-700 disabled:opacity-50 transition">
                        {fulfilling === order.id ? 'Fulfilling...' : 'Fulfill'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
\`\`\``;

// ---------------------------------------------------------------------------
// Logistics example — shipment tracking dashboard
// ---------------------------------------------------------------------------

const LOGISTICS_EXAMPLE = `\`\`\`typescript
'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';

interface Shipment {
  id: string;
  trackingNumber: string;
  origin: string;
  destination: string;
  carrier: string;
  weight: number;
  status: 'created' | 'picked_up' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception';
  estimatedDelivery: string;
  lastUpdate: string;
  lastLocation: string;
}

export default function ShipmentsPage() {
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trackingInput, setTrackingInput] = useState('');
  const [searching, setSearching] = useState(false);

  useEffect(() => { loadShipments(); }, []);

  const loadShipments = async () => {
    setLoading(true);
    setError(null);
    try {
      // INSTRUMENT: shipment.list_shipments — fetches active shipments for the current account with latest status
      const res = await fetch('http://localhost:3001/api/shipment/list-shipments');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      setShipments(data.shipments ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load shipments');
    } finally {
      setLoading(false);
    }
  };

  const handleTrack = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trackingInput.trim()) return;
    setSearching(true);
    setError(null);
    try {
      // INSTRUMENT: shipment.track_shipment — looks up real-time carrier tracking events for a given tracking number
      const res = await fetch('http://localhost:3001/api/shipment/track-shipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingNumber: trackingInput.trim() }),
      });
      if (!res.ok) throw new Error('Tracking lookup failed');
      const data = await res.json();
      if (data.shipment) {
        setShipments(prev => [data.shipment, ...prev.filter(s => s.trackingNumber !== data.shipment.trackingNumber)]);
      }
      setTrackingInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tracking failed');
    } finally {
      setSearching(false);
    }
  };

  const statusColor = (status: string) =>
    status === 'delivered' ? 'bg-green-100 text-green-700'
    : status === 'exception' ? 'bg-red-100 text-red-700'
    : status === 'out_for_delivery' ? 'bg-blue-100 text-blue-700'
    : 'bg-yellow-100 text-yellow-700';

  const statusEmoji = (status: string) =>
    status === 'delivered' ? '✅'
    : status === 'exception' ? '🚨'
    : status === 'out_for_delivery' ? '🚚'
    : status === 'in_transit' ? '✈️'
    : '📦';

  if (loading) return (
    <div className="flex justify-center items-center min-h-screen bg-gray-50">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-500" />
    </div>
  );

  if (error) return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 flex gap-3 items-center">
        <span>⚠️ {error}</span>
        <button onClick={loadShipments} data-testid="retry-button" className="underline text-sm">Retry</button>
      </div>
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 bg-gray-50 min-h-screen">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-gray-900">🚚 Shipment Tracker</h1>
        <Link href="/shipments/new" data-testid="create-shipment-link"
          className="bg-orange-500 text-white px-4 py-2 rounded-lg hover:bg-orange-600 transition text-sm font-medium">
          + New Shipment
        </Link>
      </div>

      <form onSubmit={handleTrack} className="flex gap-3 mb-6">
        <input value={trackingInput} onChange={e => setTrackingInput(e.target.value)}
          placeholder="Enter tracking number (e.g. 1Z999AA10123456784)"
          data-testid="tracking-number-input"
          className="flex-1 border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 bg-white" />
        <button type="submit" disabled={searching} data-testid="track-shipment-button"
          className="bg-orange-500 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-orange-600 disabled:opacity-50 transition">
          {searching ? 'Tracking...' : 'Track'}
        </button>
      </form>

      {shipments.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
          <p className="text-5xl mb-3">📭</p>
          <p className="text-gray-500 text-lg">No active shipments</p>
          <p className="text-gray-400 text-sm mt-1">Track a package above or create a new shipment</p>
        </div>
      ) : (
        <div className="space-y-3">
          {shipments.map(s => (
            <div key={s.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{statusEmoji(s.status)}</span>
                  <div>
                    <p className="font-semibold text-gray-900 font-mono">{s.trackingNumber}</p>
                    <p className="text-sm text-gray-500">{s.carrier} · {s.weight}kg</p>
                  </div>
                </div>
                <span className={'text-xs px-2 py-1 rounded-full font-medium ' + statusColor(s.status)}>
                  {s.status.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="mt-3 flex items-center gap-2 text-sm text-gray-600">
                <span className="font-medium">{s.origin}</span>
                <span className="text-gray-300">→</span>
                <span className="font-medium">{s.destination}</span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-gray-400">
                <span>📍 {s.lastLocation}</span>
                <span>ETA: {new Date(s.estimatedDelivery).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
\`\`\``;

// ---------------------------------------------------------------------------
// SaaS example — subscription and usage dashboard
// ---------------------------------------------------------------------------

const SAAS_EXAMPLE = `\`\`\`typescript
'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';

interface Subscription {
  id: string;
  planName: string;
  status: 'active' | 'trialing' | 'past_due' | 'cancelled';
  seats: number;
  usedSeats: number;
  monthlyPrice: number;
  billingCycleEnd: string;
  features: string[];
}

interface UsageMetric {
  name: string;
  used: number;
  limit: number;
  unit: string;
}

export default function BillingPage() {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [usage, setUsage] = useState<UsageMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  useEffect(() => { loadBillingData(); }, []);

  const loadBillingData = async () => {
    setLoading(true);
    setError(null);
    try {
      // INSTRUMENT: billing.get_subscription — fetches current subscription plan, seat usage, and billing cycle details
      const subRes = await fetch('http://localhost:3001/api/billing/get-subscription');
      if (!subRes.ok) throw new Error('HTTP ' + subRes.status);
      const subData = await subRes.json();
      setSubscription(subData.subscription);

      // INSTRUMENT: billing.get_usage_metrics — retrieves current period API calls, storage, and seat utilization metrics
      const usageRes = await fetch('http://localhost:3001/api/billing/get-usage-metrics');
      if (!usageRes.ok) throw new Error('HTTP ' + usageRes.status);
      const usageData = await usageRes.json();
      setUsage(usageData.metrics ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load billing data');
    } finally {
      setLoading(false);
    }
  };

  const handleUpgrade = async () => {
    setUpgrading(true);
    setError(null);
    try {
      // INSTRUMENT: billing.upgrade_plan — initiates a plan upgrade, applies proration and updates billing immediately
      const res = await fetch('http://localhost:3001/api/billing/upgrade-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPlan: 'enterprise' }),
      });
      if (!res.ok) throw new Error('Upgrade failed');
      await loadBillingData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upgrade failed');
    } finally {
      setUpgrading(false);
    }
  };

  const statusBadge = (status: string) =>
    status === 'active' ? 'bg-green-100 text-green-700'
    : status === 'trialing' ? 'bg-blue-100 text-blue-700'
    : status === 'past_due' ? 'bg-red-100 text-red-700'
    : 'bg-gray-100 text-gray-500';

  const usagePct = (used: number, limit: number) =>
    limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  if (loading) return (
    <div className="flex justify-center items-center min-h-screen bg-gray-50">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
    </div>
  );

  if (error) return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 flex gap-3 items-center">
        <span>⚠️ {error}</span>
        <button onClick={loadBillingData} data-testid="retry-button" className="underline text-sm">Retry</button>
      </div>
    </div>
  );

  if (!subscription) return (
    <div className="max-w-4xl mx-auto px-4 py-16 text-center">
      <p className="text-5xl mb-3">📋</p>
      <p className="text-gray-500 text-lg">No active subscription</p>
      <Link href="/plans" data-testid="view-plans-link"
        className="inline-block mt-4 bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 transition text-sm font-medium">
        View Plans
      </Link>
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 bg-gray-50 min-h-screen">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-gray-900">💼 Billing & Usage</h1>
        <Link href="/invoices" data-testid="view-invoices-link"
          className="text-blue-600 hover:text-blue-800 text-sm font-medium">
          View Invoices →
        </Link>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-xl font-bold text-gray-900">{subscription.planName}</h2>
              <span className={'text-xs px-2 py-1 rounded-full font-medium ' + statusBadge(subscription.status)}>
                {subscription.status}
              </span>
            </div>
            <p className="text-gray-500 text-sm">
              {subscription.usedSeats} of {subscription.seats} seats used ·
              Renews {new Date(subscription.billingCycleEnd).toLocaleDateString()}
            </p>
            <p className="text-2xl font-bold text-gray-900 mt-2">\${subscription.monthlyPrice}<span className="text-base font-normal text-gray-400">/mo</span></p>
          </div>
          <button onClick={handleUpgrade} disabled={upgrading || subscription.planName === 'Enterprise'}
            data-testid="upgrade-plan-button"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition">
            {upgrading ? 'Upgrading...' : 'Upgrade Plan'}
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {subscription.features.map(f => (
            <span key={f} className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-full">✓ {f}</span>
          ))}
        </div>
      </div>

      <h2 className="text-lg font-semibold text-gray-800 mb-3">Usage This Period</h2>
      {usage.length === 0 ? (
        <div className="text-center py-10 bg-white rounded-xl border border-gray-100">
          <p className="text-gray-400 text-sm">No usage data available</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
          {usage.map(metric => (
            <div key={metric.name} className="px-5 py-4">
              <div className="flex items-center justify-between mb-2">
                <p className="font-medium text-gray-800">{metric.name}</p>
                <p className="text-sm text-gray-500">{metric.used.toLocaleString()} / {metric.limit.toLocaleString()} {metric.unit}</p>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-2">
                <div className={'h-2 rounded-full transition-all ' +
                  (usagePct(metric.used, metric.limit) > 80 ? 'bg-red-500' : 'bg-blue-500')}
                  style={{ width: usagePct(metric.used, metric.limit) + '%' }} />
              </div>
              <p className="text-xs text-gray-400 mt-1">{usagePct(metric.used, metric.limit)}% used</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
\`\`\``;
