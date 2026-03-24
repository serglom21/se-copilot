# Trace Correctness Plan

> **Goal:** Every trace forwarded to Sentry is structurally correct and complete — no orphan spans,
> all spec spans present, all attributes populated, all data plotable in dashboards.
> Correctness is prioritized over speed.

---

## Core Architecture: Validate-Then-Forward Proxy

Instead of the generated app sending directly to Sentry, all telemetry is routed through
a local proxy first. Traces are validated, repaired, and only forwarded once they pass.

### Current flow (before this plan)
```
App (.env SENTRY_DSN=real-sentry-dsn) ──────────────────────────────→ Sentry
TraceIngestService (port 9999) ← used only for training scoring
```

### Target flow (after this plan)
```
App (.env SENTRY_DSN=http://localingest@127.0.0.1:9999/0)
  │
  ▼
TraceIngestService (port 9999)
  │  stores raw envelope bytes + parsed spans
  │  emits settle event when trace goes quiet (2s no new envelopes)
  │
  ▼
TraceValidator
  │  checks all 17 rules against spec
  │  classifies issues: auto-fixable vs requires-rerun
  │
  ├─ auto-fixable → TraceRepairer (mutates in-memory span data)
  │
  └─ requires-rerun → SurgicalRepairer
       │  reads specific file
       │  LLM generates targeted fix
       │  overwrites only that file
       │  restarts affected server (backend OR frontend, not both)
       │  re-runs only the flows that cover the affected spans
       │  re-validates
       │  escalates context on each attempt
       │
  ▼
DashboardConditionChecker
  │  verifies span data fields match widget query conditions
  │
  ▼
TraceForwarder
  │  forwards raw envelope bytes to real Sentry DSN
  │  merges in-memory repairs back into raw bytes before sending
  │
  ▼
Sentry ✓
```

---

## Phase 0: Pre-Run Setup Changes

### 0.1 — Force Sample Rate = 1.0 During Capture

**File:** `live-data-generator.ts` → `configureDsns()`

When writing the app's `.env`, always override the sample rate to `1.0` during the
local capture phase. This ensures every trace the app generates reaches the local proxy.
The real sampling decision happens at forward time — Sentry receives only what you
explicitly send.

```
NEXT_PUBLIC_SENTRY_DSN=http://localingest@127.0.0.1:9999/0
NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=1.0        ← forced
SENTRY_DSN=http://localingest@127.0.0.1:9999/0
SENTRY_TRACES_SAMPLE_RATE=1.0                    ← forced
```

The generated `sentry.client.config.ts` must read `tracesSampleRate` from this env var,
not hardcode it. Verify this during generation.

### 0.2 — Annotate Flows With Span Coverage

**File:** `user-flows.json` schema change

When the LLM generates user flows, each flow must declare which spec spans it covers.
This enables targeted re-runs during repair without re-running all flows.

```typescript
interface UserFlow {
  name: string;
  description: string;
  steps: FlowStep[];
  coversSpans: string[];      // NEW — e.g. ["checkout.validate_cart", "order.create"]
  dependsOn?: string[];       // NEW — flows that must run first (preconditions)
}
```

The LLM flow generation prompt must be updated to populate `coversSpans` and `dependsOn`.
Example: the checkout flow declares `dependsOn: ["add-to-cart"]` so the repair loop
knows to run the add-to-cart flow first if checkout spans are missing.

### 0.3 — Clear Ingest State Before Each Run

Before starting flows, call `traceIngestService.clear()` to wipe any traces from
previous runs. This prevents stale data from polluting validation.

---

## Phase 1: TraceIngestService Changes

**File:** `apps/desktop/electron/services/trace-ingest.ts`

### 1.1 — Store Raw Envelope Bytes

The current service parses envelopes and discards the raw bytes. To forward traces
to Sentry with full fidelity (including web vitals, measurements, breadcrumbs, and
SDK-internal fields), the raw bytes must be preserved.

```typescript
interface StoredEnvelope {
  raw: Buffer;                // original bytes — used for forwarding
  traceId: string;            // extracted for lookup
  receivedAt: number;
}

private rawEnvelopes = new Map<string, StoredEnvelope[]>(); // traceId → envelopes
```

**Forward path:** Use raw bytes. If a repair mutated a span, merge the mutation into
the raw bytes before forwarding (re-serialize only the affected item in the envelope,
leave all other items — measurements, breadcrumbs, etc. — untouched).

**Why:** Re-serializing from `CapturedSpan` objects loses:
- `measurements` (LCP, FCP, TTFB, CLS, FID) — dashboard widgets depend on these
- `breadcrumbs`
- `request` context at transaction level
- `_metrics_summary`
- SDK-internal fields Sentry uses for indexing

### 1.2 — Settle Detection (Quiescence)

Validation must not run until all spans for a trace have arrived. FE and BE envelopes
are sent separately — the FE pageload closes first, BE spans arrive later. Validating
immediately produces false orphan detections.

```typescript
// Add to TraceIngestService:
async waitForQuiet(traceId: string, quietMs = 2000): Promise<CapturedTrace> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const reschedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.off('trace-updated', handler);
        resolve(this.traces.get(traceId)!);
      }, quietMs);
    };
    const handler = (trace: CapturedTrace) => {
      if (trace.trace_id === traceId) reschedule();
    };
    this.on('trace-updated', handler);
    reschedule(); // start timer immediately
  });
}

// Variant: wait for ALL active traces to go quiet
async waitForAllQuiet(quietMs = 2000): Promise<CapturedTrace[]> { ... }
```

**Usage in live-data-generator.ts:** After all flows execute, call
`waitForAllQuiet(2000)` before starting validation. This replaces the current
hardcoded `await this.delay(30000)`.

---

## Phase 2: TraceValidator

**New file:** `apps/desktop/electron/services/trace-validator.ts`

Pure function — no side effects, no I/O. Takes captured traces + spec, returns issues.

```typescript
export type IssueKind =
  | 'missing_spec_span'          // spec span not found in any trace
  | 'orphan_span'                // parent_span_id not in trace
  | 'disconnected_be_root'       // BE root has no FE parent (sentry-trace not propagated)
  | 'child_outside_parent_bounds'
  | 'zero_duration_io'           // db/http/cache span with 0ms duration
  | 'zero_duration_transaction'
  | 'nonstandard_op'             // op not in Sentry semantic allowlist
  | 'http_description_has_host'  // "GET http://localhost:3001/api/x" → strip host
  | 'http_description_unparameterized' // "GET /users/42" → "GET /users/:id"
  | 'http_description_root_only' // "GET /" — route too generic, can't auto-fix
  | 'missing_http_status_code'
  | 'missing_http_method'
  | 'missing_server_address'
  | 'missing_db_attributes'      // db.system, db.name, db.statement
  | 'no_pageload_transaction'    // FE SDK not initialized
  | 'no_be_transaction_for_fe'   // FE trace exists but no matching BE trace_id
  | 'parent_duration_gap'        // parent >> sum(children), warning only
  | 'widget_condition_mismatch'; // span data doesn't satisfy dashboard widget conditions

export interface TraceIssue {
  kind: IssueKind;
  traceId?: string;
  spanId?: string;
  spanName?: string;
  detail: string;
  fixable: boolean;    // true = auto-repair in-memory; false = requires re-run or code fix
  severity: 'fatal' | 'error' | 'warning';
  affectedFlows?: string[];  // flow names that cover this span (populated from UserFlow.coversSpans)
}
```

### All 17 Validation Checks

#### Check 1 — Missing Spec Spans
Every span in `spec.instrumentation.spans` must appear in at least one trace
as `span.description === specSpan.name`.

- **Severity:** fatal
- **Fixable:** no — requires re-run or code fix
- **Repair target:** `lib/instrumentation.ts` (if `layer: frontend`) or
  `src/routes/api.ts` (if `layer: backend`), plus `user-flows.json`

#### Check 2 — Orphan Spans
Every span with `parent_span_id !== null` must have that ID present in `allSpans`
of the same trace. Only evaluate after settle window — spans can arrive out of order.

- **Severity:** fatal
- **Fixable:** yes — re-parent to transaction root
- **Edge case:** buffer spans for the settle window before declaring them orphans

#### Check 3 — Disconnected BE Root
A trace contains a FE root (`op: pageload` or `op: navigation`) AND a BE root
(`op: http.server`, `parent_span_id: null`) in the same `trace_id`.
The BE root should have the FE span as parent.

- **Severity:** fatal
- **Fixable:** partial — can re-parent the BE root to the FE root span if they share
  `trace_id`. Flag as a warning that code is structurally wrong even after repair.
- **True fix:** `sentry-trace` header propagation in routes

#### Check 4 — Child Outside Parent Bounds
`child.start_timestamp < parent.start_timestamp` OR `child.timestamp > parent.timestamp`.

- **Severity:** error
- **Fixable:** yes — clamp to parent bounds. If clamping produces negative duration, set to 0.

#### Check 5 — Zero-Duration I/O Span
Span with op in `{db, db.query, http.client, http.server, cache.get, cache.set, cache.put}`
has `timestamp - start_timestamp < 0.001s`.

- **Severity:** error
- **Fixable:** partial — set synthetic duration of 10ms. Mark with `data.synthetic_duration: true`.

#### Check 6 — Zero-Duration Transaction
`transaction.timestamp - transaction.start_timestamp < 0.001s`.

- **Severity:** error
- **Fixable:** yes — set `timestamp = start_timestamp + max(sum_of_child_durations, 0.1)`

#### Check 7 — Non-Standard Op Value
`span.op` is not in the Sentry semantic convention allowlist.

**Allowlist:**
```
pageload, navigation, http.client, http.server,
db, db.query, db.sql.query,
cache.get, cache.set, cache.put, cache.flush,
ui.render, ui.action, ui.domContentLoaded, ui.pageLoad, ui.load,
browser.paint, browser.resource,
network.http.request,
function, task, rpc, graphql,
serialize, deserialize,
websocket.client, websocket.server
```

**Remap table:**
| Bad value | Correct value |
|---|---|
| `browser.domContentLoadedEvent` | `ui.domContentLoaded` |
| `browser.loadEvent` | `ui.pageLoad` |
| `browser.connect` | `network.http.request` |
| `router.express` | `http.server` |
| `middleware.express` | `http.server` |
| `function.nextjs` | `http.server` |
| `request_handler.express` | `http.server` |
| `resource.link` | `browser.resource` |
| `resource.script` | `browser.resource` |
| `paint` | `browser.paint` |
| `api-call` | `http.client` |
| `database` | `db.query` |
| `render` | `ui.render` |

- **Severity:** error
- **Fixable:** yes — remap via table. Unknown values: flag as warning, leave as-is.

#### Check 8 — HTTP Description Has Host
`span.op` is `http.client` or `http.server` and description matches
`/^(GET|POST|PUT|DELETE|PATCH)\s+https?:\/\//`.

Example: `GET http://localhost:3001/api/users` → `GET /api/users`

- **Severity:** error
- **Fixable:** yes — strip `https?://[^/]+` from description

#### Check 9 — HTTP Description Unparameterized
Description contains numeric path segments: `/\/([\d]{2,})(\/|$)/`.

Example: `GET /api/users/42` → `GET /api/users/:id`

- **Severity:** error
- **Fixable:** yes — replace `\d{2,}` path segments with `:id`. Replace UUIDs with `:uuid`.

#### Check 10 — HTTP Description Root Only
`span.op: http.server` and description is `GET /` or `POST /` or bare `/`.
The Express sub-router mounting problem — the route is too generic to be useful.

- **Severity:** error
- **Fixable:** no — can't determine real route from data alone
- **Repair target:** `backend/src/routes/api.ts` — fix route registration

#### Check 11 — Missing http.status_code
`span.op` is `http.client` or `http.server` and `span.data?.['http.status_code']`
is absent or undefined.

- **Severity:** error
- **Fixable:** yes — infer from `span.status`: `ok` → 200, `not_found` → 404,
  `internal_error` → 500. Default: 200.

#### Check 12 — Missing http.method
`span.op` is `http.client` or `http.server` and `span.data?.['http.method']` is absent.

- **Severity:** error
- **Fixable:** yes — extract first word from description if format is `METHOD /path`.

#### Check 13 — Missing server.address / http.host
`span.op: http.server` and `span.data?.['server.address']` or
`span.data?.['http.host']` is absent.

- **Severity:** warning
- **Fixable:** yes — default to `localhost`.

#### Check 14 — Missing DB Attributes
`span.op` is `db` or `db.query` and any of `db.system`, `db.name`,
`db.statement` / `db.operation` is absent.

- **Severity:** error
- **Fixable:** yes — infer `db.system` from `spec.stack.backend` (postgres for express/next,
  sqlite for lightweight stacks); default `db.name: app_db`;
  default `db.operation: QUERY`.

#### Check 15 — No Pageload/Navigation Transaction
For non-backend-only projects: no trace contains a span with
`op === 'pageload'` or `op === 'navigation'`.

- **Severity:** fatal
- **Fixable:** no — FE SDK not initialized or deferred
- **Repair target:** `frontend/sentry.client.config.ts` + `frontend/instrumentation.ts`

#### Check 16 — No BE Transaction for FE Trace
A trace has a FE root but no BE transaction on the same `trace_id`.
The FE requests went out but the BE never received/honored the `sentry-trace` header.

- **Severity:** fatal
- **Fixable:** no — header propagation broken in code
- **Repair target:** `backend/src/routes/api.ts` — add/fix `Sentry.continueTrace()`

#### Check 17 — Parent Duration Gap (Warning)
`parent.duration > (sum of direct child durations) * 2` AND gap `> 100ms`.
Unaccounted time in the trace waterfall.

- **Severity:** warning
- **Fixable:** no — can't manufacture spans that weren't emitted
- **Action:** log with gap size; surfaced to LLM as context in next repair attempt

---

## Phase 3: TraceRepairer

**New file:** `apps/desktop/electron/services/trace-repairer.ts`

Pure function — takes issues + traces, returns mutated traces. Only handles
`fixable: true` issues. Operates on the parsed `CapturedTrace` objects.
Mutations are later merged back into raw envelopes before forwarding.

```typescript
export function repairTraces(
  traces: CapturedTrace[],
  issues: TraceIssue[]
): CapturedTrace[]
```

Repair strategies per check:

| Check | Repair |
|---|---|
| 2 — orphan span | Re-parent to transaction root (`op: pageload` or `op: http.server` with `parent_span_id: null`) |
| 3 — disconnected BE root | Re-parent BE root's `parent_span_id` to FE root `span_id` if both are in same trace |
| 4 — child outside bounds | `start = max(child.start, parent.start)`, `end = min(child.end, parent.end)` |
| 5 — zero-duration I/O | `span.timestamp = span.start_timestamp + 0.01`, set `data.synthetic_duration = true` |
| 6 — zero-duration tx | `tx.timestamp = tx.start_timestamp + max(childrenDuration, 0.1)` |
| 7 — nonstandard op | Remap via lookup table |
| 8 — http host in description | Strip `https?://[^/]+` regex |
| 9 — unparameterized route | Replace `\d{2,}` and UUID segments with `:id` / `:uuid` |
| 11 — missing status_code | Infer from `span.status`, default 200 |
| 12 — missing http.method | Extract from description first word |
| 13 — missing server.address | Default `localhost` |
| 14 — missing db attributes | Infer from spec stack |

**Important:** Track which spans were mutated (`data.repaired: true`) so they
can be identified in the raw envelope merge step.

---

## Phase 4: SurgicalRepairer

**New file:** `apps/desktop/electron/services/surgical-repairer.ts`

Handles `fixable: false` issues that require code changes or flow re-runs.

### Issue → File Target Map

| Issue | File to patch | What changes |
|---|---|---|
| Missing spec span (`layer: frontend`) | `frontend/lib/instrumentation.ts` | Add `Sentry.startSpan()` for the missing span |
| Missing spec span (`layer: backend`) | `backend/src/routes/api.ts` | Add span to the relevant route handler |
| Missing spec span (flow not triggering it) | `user-flows.json` | Add/modify steps to navigate and trigger the action |
| `GET /` route naming | `backend/src/routes/api.ts` | Fix route registration to use full paths |
| No pageload transaction | `frontend/sentry.client.config.ts` | Fix `Sentry.init()` with `browserTracingIntegration()` |
| No FE→BE link | `backend/src/routes/api.ts` | Add/fix `Sentry.continueTrace()` in route handlers |

### Repair Procedure

```
For each non-fixable issue:

  1. Identify target file from issue type + spec.layer
  2. Read current file contents
  3. Send to LLM with focused prompt:
     - Current file contents
     - The specific issue
     - The spec span definition
     - Instruction: "fix only this issue, do not change anything else"
  4. Overwrite the file
  5. If server restart needed: restart backend OR frontend (not both)
  6. Re-run only flows in issue.affectedFlows (from UserFlow.coversSpans mapping)
     - Run dependsOn flows first (precondition sequencing)
  7. Wait for settle (waitForAllQuiet)
  8. Re-validate
```

### Escalation Strategy

The LLM is non-deterministic. Each attempt gets more context:

| Attempt | Context given to LLM | Scope |
|---|---|---|
| 1 | Issue description + target function | Patch specific function |
| 2 | Previous attempt's output + why it failed + full file | Replace full file |
| 3 | All previous attempts + instrumentation.ts + routes/api.ts | Replace both files |
| 4 (last resort) | Mark span as known gap, continue, log clearly | Skip this span |

### Flow Precondition Sequencing

Before re-running a flow to cover a missing span:

```typescript
function resolveFlowOrder(targetFlow: UserFlow, allFlows: UserFlow[]): UserFlow[] {
  // topological sort: run dependsOn flows first
  const ordered: UserFlow[] = [];
  const visited = new Set<string>();

  function visit(flow: UserFlow) {
    if (visited.has(flow.name)) return;
    visited.add(flow.name);
    for (const dep of flow.dependsOn ?? []) {
      const depFlow = allFlows.find(f => f.name === dep);
      if (depFlow) visit(depFlow);
    }
    ordered.push(flow);
  }

  visit(targetFlow);
  return ordered;
}
```

---

## Phase 5: Dashboard Condition Checker

**New file:** `apps/desktop/electron/services/dashboard-condition-checker.ts`

Final gate before forwarding. Verifies that span data satisfies the conditions
of the dashboard widgets that reference each spec span.

This is distinct from structural validation — a span can be structurally correct
but still fail to appear in a dashboard widget if its field values don't match
the widget's query conditions.

```typescript
export interface WidgetConditionIssue {
  widgetTitle: string;
  condition: string;       // e.g. "span.op:db.query AND db.system:postgresql"
  spanName: string;
  mismatchedField: string; // e.g. "db.system"
  expected: string;        // e.g. "postgresql"
  actual: string;          // e.g. "mysql"
}

export function checkDashboardConditions(
  traces: CapturedTrace[],
  dashboardSpec: DashboardSpec,  // from sentry-dashboard.json
  spec: EngagementSpec
): WidgetConditionIssue[]
```

**How it works:**
1. Load `sentry-dashboard.json` (already generated alongside the app)
2. For each widget, parse the `conditions` field into field-value pairs
3. For each spec span referenced by that widget, find matching spans in traces
4. Check that the span's `data` fields satisfy all conditions
5. Return mismatches

**Fixable mismatches:**
- Wrong `db.system` value → patch `db.system` in the repairer to match what the dashboard expects
- Wrong op value → already caught by Check 7, but widget conditions may reference op

**Non-fixable mismatches:**
- Widget references a field that the SDK doesn't capture
  → flag and note that the dashboard widget needs to be updated

---

## Phase 6: TraceForwarder

**New file:** `apps/desktop/electron/services/trace-forwarder.ts`

Sends validated, repaired traces to real Sentry. Uses raw envelope bytes for
maximum fidelity. Merges in-memory repairs back into the raw bytes where needed.

### DSN Parsing

```typescript
function parseDsn(dsn: string): { envelopeUrl: string; authHeader: string } {
  const url = new URL(dsn);
  const publicKey = url.username;
  const host = url.host;
  const projectId = url.pathname.replace('/', '');
  return {
    envelopeUrl: `https://${host}/api/${projectId}/envelope/`,
    authHeader: `Sentry sentry_version=7, sentry_key=${publicKey}`
  };
}
```

### Forwarding Strategy

For each trace:
1. Determine which DSN to use per transaction (based on `tx.sdk` field — JS SDK → frontend DSN, Python/Node server SDK → backend DSN)
2. For transactions with no repairs: forward raw bytes as-is
3. For transactions with repairs: reconstruct only the mutated envelope items, leave all other items (measurements, breadcrumbs, etc.) from the raw bytes

### FE vs BE DSN Routing

```typescript
function selectDsn(tx: CapturedTransaction, config: LiveDataGenConfig): string {
  const sdk = tx.sdk ?? '';
  if (sdk.includes('python') || sdk.includes('node') && tx.op === 'http.server') {
    return config.backendDsn;
  }
  return config.frontendDsn;
}
```

---

## Phase 7: Integration in live-data-generator.ts

The main orchestration — replaces the current Step 7+8 with the full pipeline.

```
Step 1: Configure DSNs → local proxy + tracesSampleRate: 1.0
Step 2: Install dependencies (unchanged)
Step 3: Start backend (unchanged)
Step 4: Start frontend (unchanged)
Step 5: Wait for servers (unchanged)
Step 6: Launch browser (unchanged)

Step 7: Execute flows (DSN now points to local proxy)
  - clear traceIngestService before starting
  - execute all flows
  - wait for settle: waitForAllQuiet(2000)

Step 8: Validate + Repair Loop
  attempt = 0, MAX_ATTEMPTS = 4

  while attempt < MAX_ATTEMPTS:
    attempt++
    issues = validateTraces(traces, spec)

    if issues.length == 0: break ✓

    // Auto-repair fixable issues in-memory
    fixable = issues.filter(i => i.fixable)
    if fixable.length > 0:
      traces = repairTraces(traces, fixable)

    // Surgical repair for non-fixable issues
    nonFixable = issues.filter(i => !i.fixable && i.severity !== 'warning')
    if nonFixable.length > 0 && attempt < MAX_ATTEMPTS:
      for each issue in nonFixable:
        surgicalRepair(issue, attempt)   // patches file, restarts server
        rerunFlows(issue.affectedFlows)  // respects dependsOn ordering

      waitForAllQuiet(2000)
      traces = traceIngestService.getTraces()

Step 9: Dashboard Condition Check
  conditionIssues = checkDashboardConditions(traces, dashboard, spec)
  if conditionIssues.length > 0:
    repairTraces(traces, conditionIssues)  // fix field values to match widget conditions

Step 10: Forward to Sentry
  forwardTracesToSentry(traces, rawEnvelopes, config.frontendDsn, config.backendDsn)

Step 11: Verify (existing checkSpanCoverage)
  wait 15s for Sentry ingestion  // reduced from 30s since we know all spans are valid
  result = checkSpanCoverage(spec, runStartTime)
  if result.missing.length > 0: log clearly as known gap
```

---

## Validation Scope Rules

To prevent infinite loops during re-validation, the validator uses these scoping rules:

| Check type | Pass condition |
|---|---|
| Spec span coverage | Each spec span appears in **at least one** trace (not all traces) |
| Structural issues (orphans, timing, attributes) | **Zero** violations across all traces |
| FE→BE connection | **At least one** trace per navigation transaction has a matching BE transaction |
| Pageload/navigation | **At least one** trace contains a pageload or navigation span |
| Dashboard conditions | Each widget's referenced span appears with matching field values in **at least one** trace |

---

## Files to Create

| File | Purpose |
|---|---|
| `electron/services/trace-validator.ts` | Pure validation — all 17 checks |
| `electron/services/trace-repairer.ts` | In-memory mutations for fixable issues |
| `electron/services/surgical-repairer.ts` | File-level LLM patches + targeted re-runs |
| `electron/services/dashboard-condition-checker.ts` | Widget condition alignment |
| `electron/services/trace-forwarder.ts` | DSN parsing + raw envelope forwarding |

## Files to Modify

| File | Change |
|---|---|
| `electron/services/trace-ingest.ts` | Add raw envelope storage + `waitForQuiet()` |
| `electron/services/live-data-generator.ts` | Local DSN in `configureDsns()`, replace Step 7+8 with full pipeline |
| `electron/services/generator.ts` | Read `tracesSampleRate` from env var; populate `coversSpans` in flow generation |

---

## Trade-offs Accepted

| Trade-off | Decision |
|---|---|
| Speed vs correctness | Correctness wins. Repair loops add 30–90s per failing span per attempt. Accepted. |
| Auto-repair may change what actually happened | Acceptable — this is synthetic demo data, not production. Repairs are logged with `data.repaired: true`. |
| Raw envelope storage uses more memory | Each envelope is typically 2–20KB. 50 traces × 5 envelopes = ~500KB max. Acceptable. |
| Re-serializing repaired spans may lose micro-precision | Only mutated envelope items are re-serialized. All other items forwarded from raw bytes. |
| Settle window adds latency | 2s per trace × parallel traces = low overhead. Settle window replaces the current hardcoded 30s wait entirely. |
| Max 4 repair attempts per issue | After attempt 4, the span is logged as a known gap and skipped. True 100% requires human review of the generated app code. |

---

## Known Limitations

- **Python SDK local DSN:** The local DSN `http://localingest@127.0.0.1:9999/0` works
  with the JS SDK (proven by training flow). Python `sentry-sdk` DSN compatibility
  needs verification for Flask/FastAPI projects.

- **Spans that require specific user state:** Some spans only fire when preconditions
  are met (e.g. cart must have items before checkout spans fire). Handled by
  `UserFlow.dependsOn`, but only if the LLM correctly annotates the dependency
  at flow generation time.

- **True 100% guarantee:** After 4 repair attempts, remaining missing spans are
  logged as known gaps. Achieving 100% on every single run for every possible
  app type requires the LLM to consistently generate correct instrumentation —
  the plan brings this as close to 100% as the pipeline can enforce.
