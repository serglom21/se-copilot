# SE Copilot — Training Rules

> **Last updated:** Wed, 18 Mar 2026 18:02:15 GMT  
> **Total rules:** 127

---

These rules are learned automatically during training runs. They are injected into
LLM prompts when generating reference apps so each run benefits from past failures.

## Custom Span Coverage

### Generate flows that explicitly trigger each custom span

Each custom span in the spec MUST be triggered by at least one user flow. Do not assume a span will be called during normal page load — create explicit flows that navigate to the page and interact with the UI to trigger the span. Spans that are commonly missed: checkout.validate_cart, checkout.process_payment, order.create. (also seen in: training-ecommerce) (also seen in: training-fintech)

| Field | Value |
|-------|-------|
| Applies to | `flows` |
| First seen | training-ecommerce |
| Created | Tue, 17 Mar 2026 18:22:27 GMT |
| Times reinforced | 2 |

## Span Duration Gaps

### Parent span duration must be accounted for by child spans

When a parent span (e.g. GET /cart) has a much longer duration than the sum of its children, add intermediate child spans to cover the gap. Common causes: database connection setup, external API wait times, serialization. Always wrap these in Sentry.startSpan(). (also seen in: training-ecommerce) (also seen in: training-fintech)

| Field | Value |
|-------|-------|
| Applies to | `generation`, `instrumentation` |
| First seen | training-ecommerce |
| Created | Tue, 17 Mar 2026 18:22:27 GMT |
| Times reinforced | 2 |

### Ensure FE trace has corresponding BE transaction

Add `sentry-trace` header propagation from frontend to backend for all requests

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:52:32 GMT |
| Times reinforced | 0 |

### Missing spans for critical checkout steps

Ensure that 'checkout.validate_cart', 'checkout.process_payment', and 'order.create' spans are added in the checkout flow. Use `with` statement to create these spans.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:18:20 GMT |
| Times reinforced | 0 |

### Missing checkout spans in transaction

Ensure that all necessary checkout spans (checkout.validate_cart, checkout.process_payment, order.create) are created and properly linked to the transaction.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 05:38:32 GMT |
| Times reinforced | 0 |

### FE trace with no corresponding BE transaction

Ensure that all FE traces are properly propagated to the BE by including the sentry-trace header in network requests.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:33:11 GMT |
| Times reinforced | 0 |

### Missing Order Create Span

In the ecommerce application, ensure that a span is created for the `order.create` operation by using a specific method or function name, such as `createOrder()` or `orderCreateHandler()`, and instrumenting it with a span, such as `span = tracer.startSpan('order.create')`

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:58:19 GMT |
| Times reinforced | 0 |

## Orphan Spans

### No direct api_call steps after page navigation

Never add api_call steps that fire after waitUntil:networkidle2. Instead, let page navigation trigger backend calls naturally within the active pageload transaction. Direct api_call steps after full page load cause orphan spans because the pageload transaction has already closed. (also seen in: training-ecommerce)

| Field | Value |
|-------|-------|
| Applies to | `flows` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 01:46:09 GMT |
| Times reinforced | 1 |

### Orphan spans detected in traces

Ensure all spans are properly attached to a transaction. Check for missing `sentry-trace` header propagation between frontend and backend.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:24:37 GMT |
| Times reinforced | 0 |

### Unparented Express Middleware Spans

When creating spans for Express middleware functions (e.g., 'query', 'expressInit', 'corsMiddleware', 'jsonParser'), ensure they are properly parented to the corresponding HTTP server span. This can be achieved by using the `sentry.Trace` context to create a child span, e.g., `const childSpan = sentry.Trace.getActiveSpan().startChild('middleware.express', { 'express.name': 'query' })`

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:56:23 GMT |
| Times reinforced | 0 |

### Missing order.create Span

Add a span for the 'order.create' operation, ensuring it is properly linked to its parent span, to prevent missing spans in the trace

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 18:00:14 GMT |
| Times reinforced | 0 |

## Span Timing Integrity

### Child spans must be created inside the parent Sentry.startSpan callback

Every child span must be started inside the parent span's callback closure, never after awaiting the parent. Correct pattern: Sentry.startSpan({ name: "parent" }, async () => { await Sentry.startSpan({ name: "child" }, ...) }). Creating spans outside their parent's callback causes child timestamps to fall outside parent time bounds. (also seen in: training-ecommerce) (also seen in: training-fintech)

| Field | Value |
|-------|-------|
| Applies to | `generation`, `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:39:50 GMT |
| Times reinforced | 2 |

### Validate child spans do not fall outside parent time bounds

Review and adjust the timing of child spans to ensure they are within the valid range of their parent span. Apply this rule across all 'instrumentation'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:03:20 GMT |
| Times reinforced | 0 |

### I/O spans must wrap the actual async operation

DB, HTTP, and cache spans must wrap the actual async call inside their callback so Sentry records real latency. Zero-duration I/O spans mean the span was created but the operation was not awaited inside it. Example: await Sentry.startSpan({ op: "db.query" }, async () => { return await db.query(...) })

| Field | Value |
|-------|-------|
| Applies to | `generation`, `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:24:28 GMT |
| Times reinforced | 0 |

### Capture accurate timestamps for I/O operations

Ensure all I/O spans have non-zero durations by capturing accurate start and end times

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:24:38 GMT |
| Times reinforced | 0 |

### Fix child spans falling outside parent time bounds

Ensure that all child spans are properly nested within their parent span. Example: Ensure that the start and end times of child spans fall within the start and end times of their parent span.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:18:28 GMT |
| Times reinforced | 0 |

### Child Spans Exceeding Parent Time Bounds

When creating child spans for asynchronous operations, such as the `GET http://localhost:3001/api/cart` request, ensure that the child span's end time does not exceed the parent span's end time. This can be achieved by using `span.end()` to end the child span when the asynchronous operation completes

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:56:23 GMT |
| Times reinforced | 0 |

### Child Span Timing

Ensure that child spans, such as those with `op=middleware.express`, are properly timed within their parent span by using `span.start()` and `span.finish()` methods to define the span boundaries, preventing child spans from falling outside parent time bounds

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:58:19 GMT |
| Times reinforced | 0 |

### Child Span Timing Issue

In the express.js middleware, ensure that child spans, such as 'query', 'expressInit', 'corsMiddleware', and 'jsonParser', are properly closed before their parent spans, to prevent timing issues

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 18:00:14 GMT |
| Times reinforced | 0 |

## Span Naming Conventions

### HTTP spans must use "METHOD /parameterized-route" format in description

All http.client and http.server span descriptions must follow the format "GET /api/users/:id" — the HTTP method followed by a parameterized route pattern. Never use the resolved URL with actual IDs. The Sentry Express integration captures this automatically via expressIntegration(); for manual http.client spans set the description explicitly. (also seen in: training-ecommerce) (also seen in: training-fintech)

| Field | Value |
|-------|-------|
| Applies to | `generation`, `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:39:50 GMT |
| Times reinforced | 2 |

### Register Express routes with full /api/ prefix to get correct transaction names

Express routes must be registered at the app level with the full path (app.get("/api/users", ...)) not via a sub-router mounted at "/api" with bare paths ("/users"). The Sentry Express integration captures the mounted path as the transaction name — using app.use("/api", router) with router.get("/users") results in "GET /" transaction names instead of "GET /api/users". (also seen in: training-ecommerce)

| Field | Value |
|-------|-------|
| Applies to | `generation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:39:50 GMT |
| Times reinforced | 1 |

### Span op values must follow Sentry semantic conventions

The "op" field of every span must use a Sentry semantic convention value: http.client, http.server, db, db.query, cache.get, cache.set, ui.render, function, task, rpc, graphql. Custom op values like "api-call", "database", or "render" break Sentry's built-in dashboards and performance views. (also seen in: training-ecommerce)

| Field | Value |
|-------|-------|
| Applies to | `generation`, `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:39:50 GMT |
| Times reinforced | 1 |

### Fix non-standard UI event op values

Rename 'browser.domContentLoadedEvent', 'browser.loadEvent', and 'browser.connect' to 'ui.domContentLoaded', 'ui.pageLoad', and 'ui.connection'

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:52:32 GMT |
| Times reinforced | 0 |

### Correctly name browser events using Sentry semantic conventions

Ensure all browser event spans use 'browser.' prefix followed by the specific event type. Example: change `op=ui.long-animation-frame` to `op=browser.long-animation-frame`. Apply this rule to 'generation' and 'flows'.

| Field | Value |
|-------|-------|
| Applies to | `generation`, `flows` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:03:20 GMT |
| Times reinforced | 0 |

### Use standard op values for browser events

Rename 'browser.domContentLoadedEvent', 'browser.loadEvent', and 'browser.connect' spans to use Sentry semantic conventions like 'ui.domContentLoaded', 'ui.load', and 'network.request'. (also seen in: training-ecommerce)

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:18:20 GMT |
| Times reinforced | 1 |

### Non-standard browser span names

Rename spans with non-standard op values (e.g., browser.domContentLoadedEvent, browser.loadEvent, browser.connect) to use Sentry semantic conventions.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 05:38:32 GMT |
| Times reinforced | 0 |

### Fix non-standard op values for backend spans

Ensure all backend spans use standard op values like 'http.request' instead of 'router.express'. Example: Rename op to 'http.request' and set attributes { 'http.method': req.method, 'http.url': req.originalUrl }. (also seen in: training-ecommerce)

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:18:27 GMT |
| Times reinforced | 1 |

### Non-standard op values used in spans

Replace non-standard op values like 'function.nextjs', 'middleware.express', and 'router.express' with standard Sentry semantic conventions such as 'http.request'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:24:37 GMT |
| Times reinforced | 0 |

### Correct backend span naming for Express routes

Rename all backend spans named 'METHOD /' to include the specific route, e.g., 'GET /api/users'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:55:52 GMT |
| Times reinforced | 0 |

### HTTP spans missing METHOD /route format

Ensure all HTTP spans have a description in the format 'METHOD /route'. Example: span.setSpanDescription('GET /api/users');

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:33:11 GMT |
| Times reinforced | 0 |

### Inconsistent HTTP Span Naming

For HTTP client spans, such as `GET http://localhost:3001/api/cart`, use a consistent naming format, e.g., `GET /api/cart`, by setting the `desc` attribute of the span to the HTTP method and path, e.g., `span.setDescription('GET /api/cart')`

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:56:23 GMT |
| Times reinforced | 0 |

### Missing HTTP Method

In the `http.server` and `http.client` spans, ensure the description includes the HTTP method (e.g., 'GET', 'POST') followed by the route (e.g., '/api/users') by using the format 'METHOD /route' in the span description, such as `span.setDescription('GET /api/checkout/validate-cart')`

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:58:19 GMT |
| Times reinforced | 0 |

### Incorrect HTTP Span Naming

In the http.server spans, such as 'GET /', update the description to include the 'METHOD /route' format, e.g., 'GET /api/users'

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 18:00:14 GMT |
| Times reinforced | 0 |

## Attribute Completeness

### Every HTTP span must include http.status_code

Both http.client and http.server spans must set http.status_code so traces can be filtered by 2xx/4xx/5xx in Sentry. For Express: span.setAttributes({ "http.status_code": res.statusCode, "http.method": req.method, "http.route": req.route?.path }). For fetch() on the frontend: span.setAttributes({ "http.status_code": response.status }). The Sentry SDK may add this automatically if you use the httpIntegration(). (also seen in: training-ecommerce) (also seen in: training-fintech)

| Field | Value |
|-------|-------|
| Applies to | `generation`, `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:39:50 GMT |
| Times reinforced | 2 |

### DB spans must include db.system, db.name, and db.statement

Every database span must set: db.system (e.g. "postgresql", "mysql", "sqlite", "mongodb"), db.name (database name), and either db.statement (sanitized SQL) or db.operation (e.g. "SELECT", "INSERT"). Without these, Sentry's Queries view cannot identify which database or query is slow. (also seen in: training-ecommerce)

| Field | Value |
|-------|-------|
| Applies to | `generation`, `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:45:47 GMT |
| Times reinforced | 1 |

### Add missing HTTP status code

Ensure `http.status_code` is set with `span.setAttributes({ 'http.status_code': res.statusCode })` in all HTTP span handlers

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:52:32 GMT |
| Times reinforced | 0 |

### Add missing HTTP status codes to HTTP spans

Ensure all HTTP spans include the `http.status_code` attribute by adding `span.setAttributes({ 'http.status_code': res.statusCode });`. Apply this rule to 'flows' and 'instrumentation'.

| Field | Value |
|-------|-------|
| Applies to | `flows`, `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:03:20 GMT |
| Times reinforced | 0 |

### Add missing HTTP status codes

In all HTTP spans, add the `http.status_code` attribute using `span.setAttributes({ 'http.status_code': res.statusCode });`.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:18:20 GMT |
| Times reinforced | 0 |

### Add http.status_code to HTTP spans

Ensure all HTTP spans include the attribute 'http.status_code' set via span.setAttributes({ 'http.status_code': res.statusCode })

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:24:38 GMT |
| Times reinforced | 0 |

### Missing HTTP status codes in spans

Ensure that all HTTP spans include the 'http.status_code' attribute by adding span.setAttributes({ 'http.status_code': res.statusCode });

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 05:38:32 GMT |
| Times reinforced | 0 |

### Missing HTTP status codes

Add the 'http.status_code' attribute to all HTTP spans using span.set_attribute('http.status_code', res.statusCode)

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 06:14:49 GMT |
| Times reinforced | 0 |

### Missing http.status_code in HTTP spans

Add `http.status_code` attribute to all HTTP span(s) using `span.setAttributes({ 'http.status_code': res.statusCode });`. (also seen in: training-ecommerce)

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 07:19:39 GMT |
| Times reinforced | 1 |

### Add missing http.status_code attribute to HTTP spans

For all HTTP spans, add the 'http.status_code' attribute using span.setAttributes({ 'http.status_code': res.statusCode }). Example: Add span.setAttributes({ 'http.status_code': res.statusCode }); after res.send(). (also seen in: training-ecommerce)

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:18:27 GMT |
| Times reinforced | 1 |

### Missing http.status_code attribute in HTTP spans

Ensure all HTTP spans include the `http.status_code` attribute by adding `span.setAttributes({ 'http.status_code': res.statusCode });` after each HTTP request.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:24:37 GMT |
| Times reinforced | 0 |

### HTTP spans missing http.status_code attribute

Add `span.setAttributes({ 'http.status_code': res.statusCode });` after each HTTP request to set the status code. Apply this rule to all HTTP request handling functions. (also seen in: training-ecommerce)

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:02:37 GMT |
| Times reinforced | 1 |

### Missing HTTP Status Code Attribute

Add the http.status_code attribute to all HTTP spans using span.setAttributes({ 'http.status_code': res.statusCode });

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:12:00 GMT |
| Times reinforced | 0 |

### Missing HTTP Status Code

In the `http.client` spans, add the `http.status_code` attribute by using `span.setAttributes({ 'http.status_code': res.statusCode })` to include the HTTP status code in the span data, such as in the `product.list_fetch` span

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:58:19 GMT |
| Times reinforced | 0 |

### Missing http.status_code

In the http.client spans, such as 'product.list_fetch' and 'GET http://localhost:3001/api/product/list-fetch', add the 'http.status_code' attribute using span.setAttributes({ 'http.status_code': res.statusCode })

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 18:00:14 GMT |
| Times reinforced | 0 |

## Transaction Structure

### Backend must honor frontend sampling decision via sentry-trace header

The backend must NOT make an independent sampling decision. It must read the sentry-trace and baggage headers from the incoming request and use Sentry.continueTrace() to propagate the frontend's sampling decision. If tracesSampleRate is set on the backend independently, it may conflict with the frontend rate and produce partial traces. (also seen in: training-ecommerce) (also seen in: training-fintech)

| Field | Value |
|-------|-------|
| Applies to | `generation`, `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:39:50 GMT |
| Times reinforced | 2 |

### Fix orphan spans and ensure transaction completeness

Identify and attach orphan spans to the correct parent transactions by adding `sentry-trace` header propagation

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:52:32 GMT |
| Times reinforced | 0 |

### Ensure FE traces have corresponding BE transactions

Check for missing `sentry-trace` header propagation in frontend to backend requests. Apply this rule to 'dashboard'. (also seen in: training-ecommerce)

| Field | Value |
|-------|-------|
| Applies to | `dashboard` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:03:20 GMT |
| Times reinforced | 1 |

### Ensure FE and BE transactions match

Verify that all frontend traces have corresponding backend traces. Check for missing `sentry-trace` header propagation between the two.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:18:20 GMT |
| Times reinforced | 0 |

### Propagate sentry-trace header for FE-BE correlation

Ensure all frontend requests include the 'sentry-trace' header to correlate with backend transactions

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:24:38 GMT |
| Times reinforced | 0 |

### Missing backend transaction for frontend trace

Verify that all frontend traces have a corresponding backend transaction by checking for the presence of the sentry-trace header and ensuring proper sampling.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 05:38:32 GMT |
| Times reinforced | 0 |

### Every page must produce a pageload or navigation transaction

The Sentry Browser SDK must be initialized before React hydrates so it can capture the pageload transaction. Initialize Sentry in _app.tsx or layout.tsx with browserTracingIntegration() enabled. Hard page loads produce "pageload" op; client-side navigations produce "navigation" op. If neither appears, the SDK init is missing or deferred. (also seen in: training-ecommerce)

| Field | Value |
|-------|-------|
| Applies to | `generation`, `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 06:29:09 GMT |
| Times reinforced | 1 |

### Ensure transactions are properly completed

Verify that all transactions have a non-zero duration by checking if end_timestamp ≈ start_timestamp and adjust accordingly.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:55:52 GMT |
| Times reinforced | 0 |

### Unfinished transaction with end_timestamp ≈ start_timestamp

Ensure that all transactions are properly ended. Check for any logic where a transaction might be prematurely closed or not started.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:33:11 GMT |
| Times reinforced | 0 |

## missing_spans|transaction_completeness|custom_spans

### Add missing spans to checkout flow

Ensure that the following spans are added: checkout.validate_cart, checkout.process_payment, order.create. Use Sentry semantic conventions for naming.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:40:02 GMT |
| Times reinforced | 0 |

## incomplete_attributes|attribute_completeness|http_spans

### Add missing status_code attribute to HTTP spans

For all HTTP spans, ensure the following attribute is set: span.setAttributes({ 'http.status_code': res.statusCode });

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:40:02 GMT |
| Times reinforced | 0 |

### Add missing server address and host attributes to HTTP spans

For all HTTP spans, ensure the following attributes are set: span.setAttributes({ 'server.address': req.connection.remoteAddress, 'http.host': req.headers.host });

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:40:02 GMT |
| Times reinforced | 0 |

## incorrect_span_naming|span_naming|fe_spans

### Use standard op values for browser spans

Rename spans with non-standard op values to use Sentry semantic conventions: Rename 'browser.domContentLoadedEvent' to 'ui.domContentLoaded', 'browser.loadEvent' to 'ui.pageLoad', and 'browser.connect' to 'network.request'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:40:02 GMT |
| Times reinforced | 0 |

## orphan_spans|fe_be_connection|custom_spans|widget_data|span_gaps|span_timing|span_naming|attribute_completeness|transaction_completeness|general

### Orphan spans detected in UI traces

Ensure all spans are child of a transaction. Check for missing `sentry-trace` header propagation in frontend requests.

| Field | Value |
|-------|-------|
| Applies to | `generation`, `flows` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:46:01 GMT |
| Times reinforced | 0 |

### Non-standard operation values in browser spans

Rename browser spans to use standard op values like `browser.domContentLoadedEvent` → `ui.domContentLoaded`, etc.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:46:01 GMT |
| Times reinforced | 0 |

### HTTP spans missing METHOD /route format in description

Update HTTP span descriptions to follow the format 'METHOD /route', e.g., 'GET /api/users'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:46:01 GMT |
| Times reinforced | 0 |

### Backend spans named 'METHOD /'

Ensure backend spans use the correct route format, e.g., 'GET /api/users' instead of just '/'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 03:46:01 GMT |
| Times reinforced | 0 |

### Missing product.list_fetch Span in FE Traces

Ensure that the `product.list_fetch` span is created before any UI interaction related to product lists. Add a custom span for this operation in your frontend code.

| Field | Value |
|-------|-------|
| Applies to | `generation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:10:42 GMT |
| Times reinforced | 0 |

### Missing cart.add_item Span in FE Traces

Add a custom span named `cart.add_item` before any operations that modify the shopping cart. This should be done in your frontend code where items are added to the cart.

| Field | Value |
|-------|-------|
| Applies to | `generation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:10:42 GMT |
| Times reinforced | 0 |

### Missing checkout.validate_cart Span in FE Traces

Insert a custom span named `checkout.validate_cart` before the payment process begins. This should be done in your frontend code where cart validation occurs.

| Field | Value |
|-------|-------|
| Applies to | `generation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:10:42 GMT |
| Times reinforced | 0 |

### Missing checkout.process_payment Span in FE Traces

Add a custom span named `checkout.process_payment` when the payment process is initiated. This should be done in your frontend code where payment processing occurs.

| Field | Value |
|-------|-------|
| Applies to | `generation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:10:42 GMT |
| Times reinforced | 0 |

### Missing checkout spans in traces

Ensure that all checkout-related spans (checkout.validate_cart, checkout.process_payment, order.create) are properly created and linked within the transaction. Use `Sentry.startTransaction` to start a transaction for the entire checkout flow and use `span.startChild` to create child spans for each step.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:43:08 GMT |
| Times reinforced | 0 |

### Non-standard op values for resource spans

Rename spans with non-standard op values (resource.link, resource.script, paint) to use Sentry semantic conventions. For example, rename 'resource.link' to 'http.request' and add the correct HTTP method and route.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:43:08 GMT |
| Times reinforced | 0 |

### Missing HTTP status code in spans

Ensure that all HTTP spans include the 'http.status_code' attribute. Use `span.setAttributes({ 'http.status_code': res.statusCode })` to set the status code after handling an HTTP request.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:43:08 GMT |
| Times reinforced | 0 |

### Incorrect transaction naming for backend spans

Ensure that backend spans are named with the correct HTTP method and route. For example, rename 'METHOD /' to 'GET /api/users' if handling a GET request to '/api/users'. Use `span.op = `${req.method} ${req.originalUrl}`` to set the correct operation name.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:43:08 GMT |
| Times reinforced | 0 |

### Add missing backend span names

Ensure all backend spans are named using the Sentry semantic conventions, e.g., 'http.request' for HTTP requests.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:02:30 GMT |
| Times reinforced | 0 |

### Set HTTP status code for all HTTP spans

Add 'http.status_code' attribute to all HTTP spans using span.setAttributes({ 'http.status_code': res.statusCode });

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:02:30 GMT |
| Times reinforced | 0 |

### Propagate sentry-trace header for FE to BE traces

Ensure the 'sentry-trace' header is propagated from frontend to backend requests to maintain trace continuity.

| Field | Value |
|-------|-------|
| Applies to | `flows` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:02:30 GMT |
| Times reinforced | 0 |

### Fix non-standard op values for browser spans

Rename 'resource.link', 'resource.script', and 'paint' spans to use standard Sentry op values like 'browser.request'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:02:30 GMT |
| Times reinforced | 0 |

## span_naming|attribute_completeness

### Non-standard op values for browser spans

Ensure all browser span operations use standard Sentry semantic conventions. Replace 'browser.domContentLoadedEvent', 'browser.loadEvent', and 'browser.connect' with 'ui.domContentLoaded', 'ui.load', and 'network.request'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:51:18 GMT |
| Times reinforced | 0 |

### HTTP span descriptions should include method and route

Update HTTP span descriptions to follow the format 'METHOD /route'. For example, change 'browser.request' to 'GET /checkout/confirm'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:51:18 GMT |
| Times reinforced | 0 |

### Missing HTTP spans with METHOD /route format

Ensure all HTTP spans have descriptions in the format 'METHOD /route'. Example: span.set_description('GET /api/users')

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 06:14:49 GMT |
| Times reinforced | 0 |

### Incorrectly named backend spans

Rename all spans named 'METHOD /' to include the specific route. Example: span.set_operation('GET /api/products')

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 06:14:49 GMT |
| Times reinforced | 0 |

### Missing HTTP status code on HTTP spans

Ensure all HTTP spans include the 'http.status_code' attribute. Add it via span.setAttributes({ 'http.status_code': res.statusCode });

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 06:29:19 GMT |
| Times reinforced | 0 |

### Missing server address and host on HTTP spans

Add the 'server.address' and 'http.host' attributes to all HTTP spans. Example: span.setAttributes({ 'server.address': req.connection.remoteAddress, 'http.host': req.headers.host });

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 06:29:19 GMT |
| Times reinforced | 0 |

### Incorrect op value for middleware and request handler spans

Rename middleware and request handler spans to use Sentry semantic conventions. Example: Use 'middleware.express' or 'request_handler.express' instead of 'unknown'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 06:29:19 GMT |
| Times reinforced | 0 |

### Non-standard op values in browser spans

Rename non-standard op values to match Sentry semantic conventions. For example, change `browser.domContentLoadedEvent` to `ui.domContentLoadedEvent`.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 07:19:39 GMT |
| Times reinforced | 0 |

### Missing product.list_fetch span

Add a span with op='product.list_fetch' in the code where the product list is fetched.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 09:21:36 GMT |
| Times reinforced | 0 |

### Missing cart.add_item span

Add a span with op='cart.add_item' in the code when an item is added to the cart.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 09:21:36 GMT |
| Times reinforced | 0 |

### Missing checkout.validate_cart span

Add a span with op='checkout.validate_cart' in the code where the cart is validated during checkout.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 09:21:36 GMT |
| Times reinforced | 0 |

### Missing checkout.process_payment span

Add a span with op='checkout.process_payment' in the code where the payment is processed during checkout.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 09:21:36 GMT |
| Times reinforced | 0 |

### HTTP Spans Missing Proper Format and Status Code

Ensure all HTTP spans have a description in the format 'METHOD /route' and include 'http.status_code'. Example: span.setAttributes({ 'http.status_code': res.statusCode });

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:16:20 GMT |
| Times reinforced | 0 |

### Non-Standard Browser Span Op Values

Replace non-standard op values with Sentry semantic conventions. Example: Change 'browser.domContentLoadedEvent' to 'ui.domContentLoaded'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:16:20 GMT |
| Times reinforced | 0 |

### HTTP spans missing METHOD /route format in description

Ensure all HTTP spans have descriptions formatted as 'METHOD /route'. For example, change `op=browser.request desc="http://localhost:3000/orders"` to `op=browser.request desc="GET /orders"`. Apply this rule to the entire application.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:02:37 GMT |
| Times reinforced | 0 |

### Missing HTTP Method and Route in Span Description

Ensure all HTTP spans have a description in the format 'METHOD /route'. For example, use 'GET /api/users' instead of just '/api/users'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:12:00 GMT |
| Times reinforced | 0 |

### Incorrect Span Names for Express Routes

Rename backend spans with names like 'METHOD /' to include the actual route, e.g., 'GET /api/users'. Ensure all span names follow Sentry's semantic conventions.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:12:00 GMT |
| Times reinforced | 0 |

## span_gaps|attribute_completeness

### Missing HTTP status codes in spans

Add http.status_code attribute to all HTTP spans. Use span.setAttributes({ 'http.status_code': res.statusCode }); after setting the response.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:51:18 GMT |
| Times reinforced | 0 |

## span_gaps|transaction_completeness

### Missing critical transaction spans

Ensure that all critical transaction spans are properly created and linked. Add missing spans for 'checkout.validate_cart', 'checkout.process_payment', and 'order.create'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 04:51:18 GMT |
| Times reinforced | 0 |

### Missing backend transactions for frontend traces

Ensure that all frontend traces have corresponding backend transactions. Check for missing 'sentry-trace' headers.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 06:14:49 GMT |
| Times reinforced | 0 |

### Missing checkout spans in FE traces

Ensure all checkout-related spans (validate_cart, process_payment, order.create) are created and properly linked to the transaction. Use `Sentry.startTransaction` for transactions and `Sentry.startSpan` for individual spans.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 07:19:39 GMT |
| Times reinforced | 0 |

### Missing backend transaction for FE trace

Ensure that the backend transaction is created and properly linked to the frontend transaction. Check for missing `sentry-trace` header propagation.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 07:19:39 GMT |
| Times reinforced | 0 |

## transaction_completeness|span_gaps

### Missing pageload or navigation transaction

Ensure the frontend Sentry SDK is initialized correctly. Add the following code at the entry point of your application: Sentry.init({ dsn: 'your-dsn-here' });

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 06:29:19 GMT |
| Times reinforced | 0 |

## span_gaps|custom_spans

### Missing checkout spans in FE trace

Ensure 'checkout.validate_cart', 'checkout.process_payment', and 'order.create' spans are added in the frontend code. Use Sentry's custom span API to create these spans at appropriate places.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 10:22:38 GMT |
| Times reinforced | 0 |

## span_naming|custom_spans

### Non-standard op values for middleware and request handlers

Rename 'middleware.express' and 'request_handler.express' to use Sentry's standard op values such as 'http.middleware' and 'http.request'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 10:22:38 GMT |
| Times reinforced | 0 |

### Missing Custom Spans for Core E-commerce Operations

Add custom spans for essential e-commerce operations like 'checkout.validate_cart', 'checkout.process_payment', and 'order.create'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:16:20 GMT |
| Times reinforced | 0 |

## attribute_completeness|span_gaps

### Missing http.status_code attribute in HTTP spans

Add the 'http.status_code' attribute to all HTTP spans using `span.setAttributes({ 'http.status_code': res.statusCode })`.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 10:22:38 GMT |
| Times reinforced | 0 |

## transaction_completeness|fe_be_connection

### Missing BE transaction for FE trace

Ensure that the frontend trace has a corresponding backend transaction by propagating the `sentry-trace` header correctly in all network requests.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 10:22:38 GMT |
| Times reinforced | 0 |

### Missing backend transactions for frontend traces

Ensure that all frontend traces have corresponding backend transactions by propagating the `sentry-trace` header. Check that middleware or interceptors are correctly adding this header to requests.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:55:47 GMT |
| Times reinforced | 0 |

### FE traces missing corresponding BE transaction

Ensure that each FE trace has a corresponding BE transaction by propagating the `sentry-trace` header. Check middleware or interceptors responsible for sending requests and ensure they include the `sentry-trace` header in the request.

| Field | Value |
|-------|-------|
| Applies to | `flows` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:02:37 GMT |
| Times reinforced | 0 |

## span_naming|attribute_completeness|general

### Use Standard Op Values for Browser Spans

Replace non-standard op values like `browser.domContentLoadedEvent`, `browser.loadEvent`, and `browser.connect` with standard Sentry semantic conventions such as `ui.domContentLoaded`, `ui.load`, and `network.http.request`. Update the span names accordingly in your frontend code.

| Field | Value |
|-------|-------|
| Applies to | `generation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:10:42 GMT |
| Times reinforced | 0 |

## attribute_completeness|general

### Set HTTP Status Code for HTTP Spans

Ensure that all HTTP spans include the `http.status_code` attribute by adding `span.setAttributes({ 'http.status_code': res.statusCode });` after each HTTP request in your backend code.

| Field | Value |
|-------|-------|
| Applies to | `generation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:10:42 GMT |
| Times reinforced | 0 |

### Add Server Address and Host Attributes to HTTP Spans

For all HTTP server spans, add the `server.address` and `http.host` attributes by setting them with appropriate values in your backend code.

| Field | Value |
|-------|-------|
| Applies to | `generation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:10:42 GMT |
| Times reinforced | 0 |

### Missing http.status_code in HTTP spans

Add the 'http.status_code' attribute to all HTTP spans using `span.set_attribute('http.status_code', res.statusCode)`. Ensure this is done for both frontend and backend spans.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:48:57 GMT |
| Times reinforced | 0 |

## fe_be_connection|transaction_completeness|general

### Ensure FE Transactions Have Corresponding BE Transactions

Check that each frontend transaction has a corresponding backend transaction by ensuring the `sentry-trace` header is properly propagated from the frontend to the backend. This can be done by configuring your frontend and backend SDKs to automatically propagate trace headers.

| Field | Value |
|-------|-------|
| Applies to | `flow` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:10:42 GMT |
| Times reinforced | 0 |

## span_timing|general

### Validate Child Span Timing

Ensure that all child spans fall within the time bounds of their parent span by reviewing your code for any operations that might cause timing issues. Adjust the timing logic as necessary to maintain accurate span durations.

| Field | Value |
|-------|-------|
| Applies to | `code_review` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:10:42 GMT |
| Times reinforced | 0 |

## span_naming|transaction_completeness

### Missing FE Transactions for BE Spans

Verify that all frontend transactions have corresponding backend transactions. Ensure sentry-trace header is correctly propagated.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:16:20 GMT |
| Times reinforced | 0 |

## span_gaps|transaction_completeness|general

### Missing checkout spans in traces

Ensure all checkout-related spans (checkout.validate_cart, checkout.process_payment, order.create) are properly created and linked within the transaction. Use `with sentry.start_span(op='checkout.validate_cart')` etc.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:48:57 GMT |
| Times reinforced | 0 |

## span_naming|general

### Non-standard op values in spans

Replace non-standard op values like 'resource.link', 'resource.script', and 'paint' with standard Sentry semantic conventions. For example, use `op='http.request'` for HTTP requests.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:48:57 GMT |
| Times reinforced | 0 |

## fe_be_connection|general

### Mismatch between FE and BE traces

Ensure that all frontend transactions have corresponding backend transactions by propagating the `sentry-trace` header correctly. Check for any sampling mismatches.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:48:57 GMT |
| Times reinforced | 0 |

## span_gaps|fe_be_connection

### Missing backend spans for critical transactions

Ensure all backend routes are correctly named using the Sentry semantic convention format, e.g., 'METHOD /route'. For example, rename '/orders' to 'GET /orders'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:55:47 GMT |
| Times reinforced | 0 |

### FE trace missing corresponding BE transaction due to sampling mismatch

Verify that the sampling rates for FE and BE traces are consistent. Adjust sampling rates if necessary to ensure proper correlation.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:39:35 GMT |
| Times reinforced | 0 |

## attribute_completeness|fe_be_connection

### HTTP span attributes missing critical information

Add the missing attributes to all HTTP spans: `span.setAttributes({ 'http.status_code': res.statusCode });`. For example, in a response handler, add this line after setting the status code.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:55:47 GMT |
| Times reinforced | 0 |

## span_naming|fe_be_connection

### Non-standard op values for resource spans

Rename non-standard op values to use Sentry semantic conventions. For example, change 'resource.link' to 'http.request', and 'resource.script' to 'http.request'.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 15:55:47 GMT |
| Times reinforced | 0 |

## missing_spans

### Missing order.create span in traces

Add a custom span named 'order.create' at the beginning of the order creation process to ensure it is captured by Sentry.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 16:24:37 GMT |
| Times reinforced | 0 |

## span_timing|span_gaps

### Child span falling outside parent time bounds

Review the code where child spans are created and ensure they do not exceed their parent's time bounds. Adjust timing logic if necessary, especially in asynchronous operations.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:02:37 GMT |
| Times reinforced | 0 |

## span_timing|orphan_spans

### Child Span Outside Parent Time Bounds

Ensure that all child spans are within the time bounds of their parent spans. Review and adjust the timing logic in your instrumentation to prevent orphan spans.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:12:00 GMT |
| Times reinforced | 0 |

## orphan_spans|fe_be_connection

### FE trace missing corresponding BE transaction

Ensure that every FE transaction has a corresponding BE transaction by propagating the `sentry-trace` header in all outgoing requests.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:39:35 GMT |
| Times reinforced | 0 |

## attribute_completeness|db_spans

### Missing db.statement / db.operation attribute on DB spans

Add the `db.statement` and `db.operation` attributes to all database spans. For example, if using SQLAlchemy, ensure that your query is logged within a span.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:39:35 GMT |
| Times reinforced | 0 |

## span_naming|fe_spans

### FE spans not properly named

Ensure that all FE spans are named correctly using the `op` attribute. For example, use `browser.domContentLoadedEvent` for DOMContentLoaded events.

| Field | Value |
|-------|-------|
| Applies to | `instrumentation` |
| First seen | training-ecommerce |
| Created | Wed, 18 Mar 2026 17:39:35 GMT |
| Times reinforced | 0 |
