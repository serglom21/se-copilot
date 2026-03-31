import { StorageService } from './storage';
import { EngagementSpec, SpanDefinition } from '../../src/types/spec';
import { RulesBankService } from './rules-bank';
import { validatePrompt, getVerticalExample } from './prompt-registry';
import { RouteContract, formatContractForPrompt } from './route-contract';
import {
  TraceTopologyContract,
  ContractSpan,
  ContractTransaction,
  validateTopologyContract,
  formatValidationErrorsForArchitect,
  saveTopologyContract,
  hashBrief,
} from './trace-topology-contract';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface InstrumentationDeclaration {
  agentRole: 'frontend' | 'backend';
  spanCoverage: Array<{
    spanName: string;
    file: string;
    wrapperLocation: string;
    instrumentationPattern: 'startSpan' | 'continueTrace' | 'marker';
    distributedLink?: {
      direction: 'outbound' | 'inbound';
      pairedSpan: string;
      fetchUrl?: string;
    };
  }>;
  unaccountedSpans: string[];   // must be empty before code generation proceeds
  inventedSpans: string[];      // must be empty before code generation proceeds
}

/**
 * Robustly extract the first complete JSON object from a model response.
 * Handles: markdown fences, leading/trailing prose, partial fences.
 * Throws if no valid JSON object is found.
 */
function extractJsonObject(raw: string): any {
  // Strip markdown fences if present
  let text = raw.replace(/^```(?:json)?\s*/m, '').replace(/```[\s\S]*$/m, '').trim();

  // Find the first '{' and walk forward matching braces to get the full object
  const start = text.indexOf('{');
  if (start === -1) throw new SyntaxError('No JSON object found in LLM response');

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  // Fallback: try parsing everything from start (handles truncated responses)
  return JSON.parse(text.slice(start));
}

export class LLMService {
  private storage: StorageService;
  private rulesBank: RulesBankService | null = null;
  streamProgressCallback: ((tokens: number, label: string) => void) | null = null;

  // Serial queue for local model requests — MLX only handles one request at a time.
  // Without this, concurrent calls (e.g. page generation + span suggestion) pile up
  // on the same socket, the second request sees no data, and the inactivity timeout fires.
  private localQueue: Promise<unknown> = Promise.resolve();
  private localQueueDepth = 0;

  constructor(storage: StorageService, rulesBank?: RulesBankService) {
    this.storage = storage;
    this.rulesBank = rulesBank || null;
  }

  setRulesBank(rulesBank: RulesBankService) {
    this.rulesBank = rulesBank;
  }

  async chat(projectId: string, userMessage: string): Promise<{ 
    role: 'assistant'; 
    content: string; 
    timestamp: string;
    extractedSpans?: SpanDefinition[];
  }> {
    const project = this.storage.getProject(projectId);
    const settings = this.storage.getSettings();

    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      throw new Error('LLM settings not configured. Please configure API key and base URL in settings.');
    }

    // Build conversation history
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: this.buildSystemPrompt(project)
      },
      ...project.chatHistory.map(msg => ({
        role: msg.role,
        content: msg.content
      })),
      {
        role: 'user',
        content: userMessage
      }
    ];

    const response = await this.callLLM(messages, settings.llm);
    const timestamp = new Date().toISOString();

    // Extract spans from the response (user confirms via chips — not auto-added)
    const existingSpanNames = new Set(project.instrumentation.spans.map(s => s.name));
    const allExtracted = this.extractSpansFromText(response);
    const extractedSpans = allExtracted.filter(s => !existingSpanNames.has(s.name));

    // Save chat history
    const updatedHistory = [
      ...project.chatHistory,
      { role: 'user' as const, content: userMessage, timestamp },
      { role: 'assistant' as const, content: response, timestamp }
    ];

    this.storage.updateProject(projectId, {
      chatHistory: updatedHistory
    });

    return { role: 'assistant', content: response, timestamp, extractedSpans };
  }

  private extractSpansFromText(text: string): SpanDefinition[] {
    const spans: SpanDefinition[] = [];
    
    // Pattern 1: Backtick-wrapped span names (e.g. `signup.form_interaction`)
    const codeBlockPattern = /`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)`/g;
    const matches = text.matchAll(codeBlockPattern);
    
    for (const match of matches) {
      const spanName = match[1];
      
      // Skip if it doesn't look like a span (needs at least one dot)
      if (!spanName.includes('.')) continue;
      
      // Extract operation (first part before first dot)
      const [op] = spanName.split('.');
      const layer = this.guessLayer(spanName, text);
      
      // Extract description from nearby text
      const description = this.extractDescription(spanName, text);
      
      // Extract attributes from nearby text
      const attributes = this.extractAttributes(spanName, text);
      
      spans.push({
        name: spanName,
        op: op,
        layer: layer,
        description: description || `Tracks ${spanName} operation`,
        attributes: attributes,
        pii: { keys: this.detectPIIKeys(attributes) }
      });
    }
    
    // Pattern 2: Explicit span definitions in text
    const explicitPattern = /span.*?[:`]\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)/gi;
    const explicitMatches = text.matchAll(explicitPattern);

    for (const match of explicitMatches) {
      const spanName = match[1].toLowerCase();
      if (!spanName.includes('.')) continue;
      if (spans.find(s => s.name === spanName)) continue;

      const [op] = spanName.split('.');
      const layer = this.guessLayer(spanName, text);

      spans.push({
        name: spanName,
        op: op,
        layer: layer,
        description: this.extractDescription(spanName, text) || `Tracks ${spanName} operation`,
        attributes: this.extractAttributes(spanName, text),
        pii: { keys: [] }
      });
    }

    // Pattern 3: Plain dot-notation names in numbered/bulleted list lines
    // Matches: "1. signup.form_interaction", "1. `signup.form_interaction`", "- signup.field_validation"
    const listPattern = /^[\s]*(?:\d+\.|[-*])\s+`?([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)`?/gm;
    const listMatches = text.matchAll(listPattern);

    for (const match of listMatches) {
      const spanName = match[1].toLowerCase();
      if (!spanName.includes('.')) continue;
      if (spans.find(s => s.name === spanName)) continue;

      const [op] = spanName.split('.');
      const layer = this.guessLayer(spanName, text);

      spans.push({
        name: spanName,
        op: op,
        layer: layer,
        description: this.extractDescription(spanName, text) || `Tracks ${spanName} operation`,
        attributes: this.extractAttributes(spanName, text),
        pii: { keys: [] }
      });
    }

    return spans;
  }

  private guessLayer(spanName: string, context: string): 'frontend' | 'backend' {
    const lowerContext = context.toLowerCase();
    const lowerSpanName = spanName.toLowerCase();
    
    // Check context around the span name
    const spanIndex = lowerContext.indexOf(lowerSpanName);
    const contextWindow = lowerContext.substring(
      Math.max(0, spanIndex - 100),
      Math.min(lowerContext.length, spanIndex + 100)
    );
    
    // Frontend indicators
    if (
      contextWindow.includes('frontend') ||
      contextWindow.includes('client') ||
      contextWindow.includes('browser') ||
      contextWindow.includes('user action') ||
      contextWindow.includes('click') ||
      contextWindow.includes('submit')
    ) {
      return 'frontend';
    }
    
    // Backend indicators
    if (
      contextWindow.includes('backend') ||
      contextWindow.includes('server') ||
      contextWindow.includes('api') ||
      contextWindow.includes('database') ||
      contextWindow.includes('payment') ||
      contextWindow.includes('process') ||
      spanName.includes('validate') ||
      spanName.includes('process') ||
      spanName.includes('fetch')
    ) {
      return 'backend';
    }
    
    // Default based on common span operations
    const op = spanName.split('.')[0];
    if (['db', 'http', 'payment', 'auth', 'email'].includes(op)) {
      return 'backend';
    }
    
    return 'backend'; // Default to backend
  }

  private extractDescription(spanName: string, text: string): string {
    const spanIndex = text.indexOf(spanName);
    if (spanIndex === -1) return '';
    
    // Look for description after the span name (next 300 characters)
    const afterSpan = text.substring(spanIndex, spanIndex + 300);
    
    // Pattern 1: Description after colon (most common format)
    // Example: `span.name`: Description here.
    const colonMatch = afterSpan.match(/`[^`]+`\s*:\s*([^.\n*]+)(?:\.|$|\n)/);
    if (colonMatch) {
      return colonMatch[1].trim();
    }
    
    // Pattern 2: Description in parentheses
    const parenMatch = afterSpan.match(/\(([^)]+)\)/);
    if (parenMatch) {
      return parenMatch[1];
    }
    
    // Pattern 3: Description after dash or hyphen
    const descMatch = afterSpan.match(/[:–-]\s*([^.\n*]+)/);
    if (descMatch) {
      return descMatch[1].trim();
    }
    
    return '';
  }

  private extractAttributes(spanName: string, text: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    const spanIndex = text.indexOf(spanName);
    if (spanIndex === -1) return attributes;
    
    // Look for attributes in the context (next 400 characters)
    const context = text.substring(spanIndex, spanIndex + 400);
    
    // Pattern 1: Look for explicit "Attributes:" section
    const attributesMatch = context.match(/Attributes?:\s*([^\n]+)/i);
    if (attributesMatch) {
      const attributesText = attributesMatch[1];
      // Extract all backtick-wrapped attribute names
      const attrMatches = attributesText.matchAll(/`([a-z_]+)`/g);
      for (const match of attrMatches) {
        const attrName = match[1];
        if (!attrName.includes('.')) {
          attributes[attrName] = `Tracks ${attrName.replace(/_/g, ' ')}`;
        }
      }
    }
    
    // Pattern 2: Look for bullet points with backtick attributes
    const bulletPattern = /[*•-]\s*Attributes?:\s*`([^`]+)`/gi;
    const bulletMatches = context.matchAll(bulletPattern);
    for (const match of bulletMatches) {
      const attrList = match[1];
      const attrs = attrList.split(/[,\s]+/);
      for (const attr of attrs) {
        const cleaned = attr.trim();
        if (cleaned && !cleaned.includes('.')) {
          attributes[cleaned] = `Tracks ${cleaned.replace(/_/g, ' ')}`;
        }
      }
    }
    
    // Pattern 3: Common attribute patterns in backticks
    const attributePatterns = [
      /`([a-z_]+)`/g,  // Backtick attributes
      /\*\*([a-z_]+)\*\*/g,  // Bold attributes
    ];
    
    for (const pattern of attributePatterns) {
      const matches = context.matchAll(pattern);
      for (const match of matches) {
        const attrName = match[1];
        // Skip if it looks like a span name or already added
        if (attrName.includes('.') || attrName === spanName || attributes[attrName]) continue;
        
        // Common attribute names
        if (
          attrName.includes('id') ||
          attrName.includes('name') ||
          attrName.includes('price') ||
          attrName.includes('quantity') ||
          attrName.includes('value') ||
          attrName.includes('amount') ||
          attrName.includes('count') ||
          attrName.includes('method') ||
          attrName.includes('status') ||
          attrName.includes('type') ||
          attrName.includes('user') ||
          attrName.includes('error') ||
          attrName.includes('address') ||
          attrName.includes('street') ||
          attrName.includes('city') ||
          attrName.includes('state') ||
          attrName.includes('zip') ||
          attrName.includes('rate') ||
          attrName.includes('shipping') ||
          attrName.includes('order') ||
          attrName.includes('cart') ||
          attrName.includes('product')
        ) {
          attributes[attrName] = `Tracks ${attrName.replace(/_/g, ' ')}`;
        }
      }
    }
    
    return attributes;
  }

  private detectPIIKeys(attributes: Record<string, string>): string[] {
    const piiKeywords = [
      'email', 'phone', 'address', 'ssn', 'card', 'password', 'token', 'ip',
      'street', 'city', 'zip', 'postal', 'credit', 'cvv', 'billing',
      'shipping_address', 'billing_address', 'name', 'firstname', 'lastname'
    ];
    const piiKeys: string[] = [];
    
    for (const key of Object.keys(attributes)) {
      const lowerKey = key.toLowerCase();
      if (piiKeywords.some(keyword => lowerKey.includes(keyword))) {
        piiKeys.push(key);
      }
    }
    
    return piiKeys;
  }

  async generateInstrumentationPlan(project: EngagementSpec): Promise<{
    transactions: string[];
    spans: SpanDefinition[];
  }> {
    const settings = this.storage.getSettings();

    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      throw new Error('LLM settings not configured');
    }

    let stackDescription: string;

    if (project.stack.type === 'backend-only') {
      const framework = project.stack.backend === 'flask' ? 'Flask' : 'FastAPI';
      stackDescription = `- Backend: ${framework} (Python)`;
    } else if (project.stack.type === 'mobile') {
      stackDescription = `- Frontend: React Native (Expo)\n- Backend: Express`;
    } else {
      stackDescription = `- Frontend: Next.js\n- Backend: Express`;
    }

    // Analyze website if provided
    let websiteContext = '';
    if (project.project.customerWebsite) {
      console.log(`Analyzing customer website: ${project.project.customerWebsite}`);
      const websiteAnalysis = await this.analyzeCustomerWebsite(project.project.customerWebsite);

      websiteContext = `
Customer Website: ${project.project.customerWebsite}

WEBSITE ANALYSIS:
${websiteAnalysis}

IMPORTANT INSTRUCTIONS:
- Use the website analysis above to inform your recommendations
- Suggest performance metrics that would be relevant for this specific type of business
- Consider the user journeys and critical paths identified in the analysis
- NEVER include company names, brand names, or specific product names in generated code
- Keep all code examples abstract and generic (e.g., "product", "item", "user")
- Use generic terminology that applies to any business in this vertical
- Focus on the TYPES of operations (e.g., "checkout flow", "search", "filtering") not brand-specific features
`;
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are a senior Sentry Solutions Engineer with deep expertise in performance monitoring and observability.

Your task: Analyze the project requirements and design domain-specific, production-ready instrumentation.

APPLICATION CONTEXT:
- Stack: ${stackDescription}
- Vertical: ${project.project.vertical}
${websiteContext}

ANALYSIS APPROACH:

Step 1: Understand the Domain
- What type of application is this? (e.g., data processing, package management, web app, API, ML pipeline)
- What are the core operations this application performs?
- What operations are likely to be slow or variable in performance?
- What failures would impact users most?

Step 2: Identify Critical Operations
Ask yourself:
- What operations take >10ms and have variable performance?
- What operations can fail or timeout?
- What operations are on the critical path for users?
- What operations have dependencies (network, disk, CPU, memory)?

Step 3: Design Spans
For each critical operation, create a span with:
- Descriptive name: {category}.{action} (e.g., "conda.env.solve", "db.query", "ml.train_model")
- 3-5 contextual attributes that help diagnose performance issues
- Focus on domain-specific operations, NOT generic web app patterns

SPAN DESIGN PRINCIPLES:

✓ Track operations that:
  - Have variable execution time
  - Depend on external resources (network, disk, CPU)
  - Are performance-critical for the user experience
  - Can fail or need retry logic

✗ Avoid:
  - Trivial operations (<1ms)
  - Generic web patterns unless this IS a web app
  - Operations already tracked by Sentry automatically

ATTRIBUTE DESIGN:

Attributes should answer:
- WHY is this slow? (e.g., data_size, complexity, retry_count)
- WHAT is being processed? (e.g., package_count, file_format, algorithm_type)
- WHERE are we spending time? (e.g., network_time_ms, cpu_time_ms, cache_hit)
- WHO/WHAT context? (e.g., platform, version, feature_flags)

IMPORTANT:
- Analyze the project requirements FIRST
- Design spans specific to THIS application's domain
- Don't default to e-commerce/SaaS patterns unless that's what this is
- Use domain-appropriate naming (e.g., "conda.env.solve" for package management, "ml.train" for ML, "query.execute" for databases)

JSON STRUCTURE:
{
  "transactions": ["list of key transactions/endpoints"],
  "spans": [
    {
      "name": "checkout.validate_cart",
      "op": "checkout",
      "layer": "backend",
      "description": "Clear description of what this measures",
      "attributes": {
        "attribute_name": "What this attribute captures"
      },
      "pii": {
        "keys": ["list of PII attribute keys"]
      }
    }
  ]
}

CRITICAL: The "op" field MUST be the first segment of the span name (the category prefix before the first dot).
Examples: name "checkout.validate_cart" → op "checkout", name "product.search" → op "product", name "payment.process" → op "payment".
NEVER use "operation", "operation_type", "custom", or any generic placeholder as the op value.

Return ONLY valid JSON.`
      },
      {
        role: 'user',
        content: `Analyze this project and design domain-specific instrumentation:

PROJECT:
- Name: ${project.project.name}
- Industry: ${project.project.vertical}
- Stack: ${project.stack.type}
- Requirements: ${project.project.notes || 'Build a comprehensive demo application'}

INSTRUCTIONS:

1. READ THE REQUIREMENTS CAREFULLY
   - What does this application actually do?
   - What technology/domain is this? (web app? data science? package management? API? ML?)

2. IDENTIFY DOMAIN-SPECIFIC OPERATIONS
   - What are the core operations for THIS specific use case?
   - What operations would be slow or critical in THIS domain?
   - Examples:
     * Package manager: dependency solving, downloads, extraction, verification
     * Data science: data loading, preprocessing, model training, inference
     * Web API: request parsing, validation, database queries, response serialization
     * ML platform: feature engineering, model training, evaluation, deployment

3. DESIGN SPANS FOR THIS DOMAIN
   - Use domain-appropriate naming
   - Include 3-5 contextual attributes per span
   - Focus on operations specific to this use case

CRITICAL SCOPING RULE:
Generate spans ONLY for operations that are directly described by the project name and requirements.
- If the project is named "Signup" → instrument the signup/registration flow only. Do NOT add checkout, payment, or cart spans.
- If the project is named "Checkout" → instrument the checkout flow only. Do NOT add signup or auth spans.
- The project name is the primary signal for scope. The industry vertical tells you the domain context, NOT the full feature set to instrument.
- When requirements are sparse, default to a narrow interpretation of the project name rather than expanding to the full vertical.

SPAN QUALITY RULES:
- Generate EXACTLY 4-6 spans. No more. Quality over quantity.
- DO NOT generate micro-UI-event spans. The following are explicitly forbidden: focus, blur, keydown, keyup, click, scroll, hover, mouseover, input, render, mount, unmount, animation, and any other browser/DOM event.
- Each span must represent a meaningful BUSINESS or NETWORK operation: submitting a form, validating credentials, creating an account, processing a payment, sending an email, querying a database.
- All span names must be UNIQUE. No duplicate names.
- Prefer backend operations for clear FE→BE tracing: submit, validate, create, process, send, save, fetch, query.`
      }
    ];

    const response = await this.callLLM(messages, settings.llm);
    
    // Parse JSON response - strip markdown code blocks and extra text
    try {
      let jsonText = response.trim();
      
      // Method 1: Check if response is wrapped in code blocks
      if (jsonText.startsWith('```')) {
        // Extract content between first ``` and last ```
        const match = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (match) {
          jsonText = match[1].trim();
        } else {
          // Fallback: just remove the markers
          jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```[\s\S]*$/, '').trim();
        }
      }
      
      // Method 2: Try to extract JSON object/array if there's extra text
      // Look for the first { or [ and try to find its matching closing brace
      if (!jsonText.startsWith('{') && !jsonText.startsWith('[')) {
        const jsonStart = Math.min(
          jsonText.indexOf('{') >= 0 ? jsonText.indexOf('{') : Infinity,
          jsonText.indexOf('[') >= 0 ? jsonText.indexOf('[') : Infinity
        );
        if (jsonStart !== Infinity && jsonStart >= 0) {
          jsonText = jsonText.substring(jsonStart);
        }
      }
      
      // Method 3: If there's text after the JSON, try to remove it
      // Find the last } or ] and cut everything after
      let lastBrace = -1;
      let braceCount = 0;
      let inString = false;
      let escapeNext = false;
      
      for (let i = 0; i < jsonText.length; i++) {
        const char = jsonText[i];
        
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        
        if (char === '"' && !escapeNext) {
          inString = !inString;
          continue;
        }
        
        if (!inString) {
          if (char === '{' || char === '[') {
            braceCount++;
          } else if (char === '}' || char === ']') {
            braceCount--;
            if (braceCount === 0) {
              lastBrace = i;
              break;
            }
          }
        }
      }
      
      if (lastBrace > 0) {
        jsonText = jsonText.substring(0, lastBrace + 1);
      }
      
      const parsed = JSON.parse(jsonText);
      const GENERIC_OPS_INIT = new Set(['operation', 'operation_type', 'custom', 'span', 'generic', '']);
      const normalizedSpans = (parsed.spans || []).map((s: any) => {
        const name = String(s.name || '');
        const rawOp = String(s.op || '');
        const op = GENERIC_OPS_INIT.has(rawOp.toLowerCase()) ? (name.split('.')[0] || rawOp) : rawOp;
        return { ...s, op };
      });
      const plan = {
        transactions: parsed.transactions || [],
        spans: normalizedSpans
      };

      // Freeze the plan to plan.json — single source of truth for all downstream phases
      if (project.outputPath) {
        try {
          const planPath = path.join(project.outputPath, 'plan.json');
          await fs.promises.writeFile(planPath, JSON.stringify(plan, null, 2));
          console.log(`[generateInstrumentationPlan] Plan frozen to: ${planPath}`);
        } catch (e: any) {
          console.warn('[generateInstrumentationPlan] Could not write plan.json:', e?.message);
        }
      }

      return plan;
    } catch (error) {
      console.error('Failed to parse LLM response:', error);
      console.error('Response was:', response.substring(0, 500)); // Log first 500 chars
      throw new Error('LLM returned invalid JSON. Please try again.');
    }
  }

  // ---------------------------------------------------------------------------
  // Architect Agent: generate a validated TraceTopologyContract
  // ---------------------------------------------------------------------------

  /**
   * Produces a TraceTopologyContract from the engagement spec.
   * Runs ContractValidator after each attempt — re-reasons up to 2 times if invalid.
   * Throws if the contract cannot be validated after max attempts.
   */
  async generateTraceTopologyContract(
    project: EngagementSpec,
    outputPath?: string
  ): Promise<TraceTopologyContract> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) throw new Error('LLM settings not configured');

    const stackDescription = project.stack.type === 'backend-only'
      ? `Backend-only: ${project.stack.backend === 'flask' ? 'Flask' : 'FastAPI'} (Python)`
      : project.stack.type === 'mobile'
        ? 'React Native (Expo) frontend + Express backend'
        : 'Next.js frontend + Express backend';

    const systemPrompt = `You are the Architect agent for Pawprint — a senior Sentry Solutions Engineer.

Your task: Produce a complete, validated Trace Topology Contract for this project.
The contract defines the EXACT shape of distributed traces this app will produce.
Every downstream agent (frontend generator, backend generator, flow orchestrator, QA) is grounded in this contract.
Do not guess — reason carefully from the project spec.

STACK: ${stackDescription}
VERTICAL: ${project.project.vertical}

CONTRACT SCHEMA:
{
  "spans": [
    {
      "name": "signup.validate_user_input",   // {namespace}.{action} format
      "op": "function",                        // first segment of name, or semantic op
      "layer": "frontend" | "backend",
      "parentSpan": "pageload" | "navigation" | "http.server" | "{other-span-name}",
      "distributedTo": "{backend-span-name}", // ONLY on frontend spans that trigger a backend call via fetch()
      "route": "/api/signup/validate",         // REQUIRED for backend spans
      "httpMethod": "GET" | "POST" | "PUT" | "DELETE" | "PATCH", // REQUIRED for backend spans
      "requiredAttributes": ["user.id", "input.field_count"],
      "description": "Validates user input before account creation"
    }
  ],
  "transactions": [
    {
      "name": "GET /",                         // page route or API route
      "op": "pageload" | "navigation" | "http.server",
      "layer": "frontend" | "backend",
      "rootSpans": ["signup.validate_user_input"]  // direct children of this transaction
    }
  ]
}

RULES:
- Generate 4-6 spans. Quality over quantity.
- Every frontend span must have parentSpan set to "pageload", "navigation", or another frontend span.
- Every backend span must have a route and httpMethod.
- If a frontend span calls a backend API, set distributedTo to the backend span name.
  The backend span's route must match what the frontend fetch() will call.
  distributedTo MUST use the exact span name as it appears in the "name" field — dot-separated
  (e.g. "backend.validate_user_input"), NEVER underscore-separated. Underscores in distributedTo will fail validation.
- No two spans may share the same name.
- No two backend spans may share the same method+route.
- No span may list itself as parentSpan.
- The parent chain for every span must eventually reach a transaction root (pageload/navigation/http.server).
- Include at least one frontend transaction and one backend transaction for full-stack apps.
- op must be the first segment of the span name (e.g. "signup" for "signup.validate_user_input")
  UNLESS it maps to a Sentry semantic op (db.query, http.client, cache.get, etc.)
- Forbidden ops: "operation", "custom", "generic", "span", empty string.
- Focus on THIS project's domain — do not add generic e-commerce/SaaS spans unless that's what this is.
- Generate spans ONLY for operations described by the project name and notes.

Return ONLY valid JSON matching the schema above.`;

    const userPrompt = `Generate the Trace Topology Contract for this project:

Project: ${project.project.name}
Vertical: ${project.project.vertical}
Stack: ${project.stack.type}
Notes: ${project.project.notes || 'Build a comprehensive demo application'}

Reason through:
1. What are the 4-6 most critical operations for this specific domain?
2. Which operations happen on the frontend vs backend?
3. Which frontend operations trigger backend calls (distributed trace boundaries)?
4. What HTTP routes will the backend expose?
5. What parent-child relationships make sense for the trace tree?

Return ONLY the JSON contract.`;

    const MAX_ATTEMPTS = 3;
    let lastErrors = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: attempt === 1 ? userPrompt : `${userPrompt}\n\nPRIOR ATTEMPT FAILED VALIDATION:\n${lastErrors}\n\nFix ALL issues listed above and return the corrected contract.` },
      ];

      const response = await this.callLLM(messages, settings.llm);
      let parsed: any;
      try {
        parsed = extractJsonObject(response);
      } catch {
        lastErrors = `JSON parse failed — response was not valid JSON.`;
        continue;
      }

      // Normalize ops (same logic as generateInstrumentationPlan)
      const GENERIC_OPS = new Set(['operation', 'operation_type', 'custom', 'span', 'generic', '']);
      const normalizedSpans: ContractSpan[] = (parsed.spans || []).map((s: any) => {
        const name = String(s.name || '');
        const rawOp = String(s.op || '');
        const op = GENERIC_OPS.has(rawOp.toLowerCase()) ? (name.split('.')[0] || rawOp) : rawOp;
        const layer: 'frontend' | 'backend' = s.layer === 'backend' ? 'backend' : 'frontend';
        let parentSpan = String(s.parentSpan || (layer === 'frontend' ? 'pageload' : 'http.server'));

        // Auto-fix: self-referential parentSpan is always invalid.
        // The LLM commonly names a span "pageload" and also sets parentSpan: "pageload".
        // Assign the layer-appropriate transaction root instead.
        if (parentSpan === name) {
          parentSpan = layer === 'frontend'
            ? (name === 'pageload' ? 'navigation' : 'pageload')
            : 'http.server';
          console.warn(`[Pawprint] Auto-fixed self-parent for span "${name}" → parentSpan="${parentSpan}"`);
        }

        return {
          name,
          op,
          layer,
          parentSpan,
          distributedTo: s.distributedTo || undefined,
          route: s.route || undefined,
          httpMethod: s.httpMethod || undefined,
          requiredAttributes: Array.isArray(s.requiredAttributes) ? s.requiredAttributes : [],
          description: String(s.description || ''),
        } satisfies ContractSpan;
      });

      const normalizedTransactions: ContractTransaction[] = (parsed.transactions || []).map((t: any) => ({
        name: String(t.name || ''),
        op: t.op === 'navigation' ? 'navigation' : t.op === 'http.server' ? 'http.server' : 'pageload',
        layer: t.layer === 'backend' ? 'backend' : 'frontend',
        rootSpans: Array.isArray(t.rootSpans) ? t.rootSpans : [],
      } satisfies ContractTransaction));

      const contract: TraceTopologyContract = {
        projectId: project.id,
        generatedAt: new Date().toISOString(),
        frozen: false,
        spans: normalizedSpans,
        transactions: normalizedTransactions,
        briefHash: hashBrief({
          vertical: project.project.vertical,
          notes: project.project.notes,
          stackType: project.stack.type,
        }),
      };

      const validation = validateTopologyContract(contract);
      if (validation.valid) {
        contract.frozen = true;
        if (outputPath) saveTopologyContract(contract, outputPath);
        console.log(`[Pawprint] ✅ Trace Topology Contract validated (attempt ${attempt}/${MAX_ATTEMPTS})`);
        if (validation.warnings.length > 0) {
          console.warn(`[Pawprint] ⚠ ${validation.warnings.length} contract warnings:`,
            validation.warnings.map(w => w.detail).join('; '));
        }
        return contract;
      }

      lastErrors = formatValidationErrorsForArchitect(validation);
      console.warn(`[Pawprint] Contract attempt ${attempt} failed validation:`, lastErrors);
    }

    throw new Error(`Trace Topology Contract failed validation after ${MAX_ATTEMPTS} attempts.\n${lastErrors}`);
  }

  // ---------------------------------------------------------------------------
  // Architect Agent: generate InstrumentationDeclaration (pre-code structured plan)
  // ---------------------------------------------------------------------------

  /**
   * Before generating code, each agent (frontend/backend) produces a structured
   * InstrumentationDeclaration. This is validated against the contract before
   * any code is written — catching "LLM writes code that doesn't match its plan" early.
   */
  async generateInstrumentationDeclaration(
    role: 'frontend' | 'backend',
    contract: TraceTopologyContract,
    pageFilenames: string[] = [],
    backendFilename = 'src/routes/api.ts'
  ): Promise<InstrumentationDeclaration> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) throw new Error('LLM settings not configured');

    const relevantSpans = contract.spans.filter(s => s.layer === role);
    const { formatContractForPrompt } = await import('./trace-topology-contract');

    const systemPrompt = `You are the ${role === 'frontend' ? 'Frontend Generator' : 'Backend Engineer'} agent for Pawprint.

Before writing any code, you must produce a structured InstrumentationDeclaration that maps every
${role} span from the contract to exactly where it will appear in the generated code.

This declaration is validated before code generation starts. If any span is unaccounted for,
or if you declare a span not in the contract, the declaration is rejected.

${formatContractForPrompt(contract)}

RELEVANT SPANS FOR YOUR ROLE (${role}):
${relevantSpans.map(s => `  - ${s.name} (op: ${s.op}, parent: ${s.parentSpan}${s.distributedTo ? `, distributedTo: ${s.distributedTo}` : ''}${s.route ? `, route: ${s.httpMethod} ${s.route}` : ''})`).join('\n')}

AVAILABLE FILES:
${role === 'frontend'
  ? (pageFilenames.length > 0 ? pageFilenames.map(f => `  - ${f}`).join('\n') : '  - app/page.tsx (home)\n  - app/[page]/page.tsx (additional pages)')
  : `  - ${backendFilename}`}

Return ONLY valid JSON:
{
  "agentRole": "${role}",
  "spanCoverage": [
    {
      "spanName": "signup.validate_user_input",
      "file": "app/signup/page.tsx",
      "wrapperLocation": "inside handleSubmit callback, before fetch()",
      "instrumentationPattern": "startSpan",
      "distributedLink": {
        "direction": "outbound",
        "pairedSpan": "signup.create_user_account",
        "fetchUrl": "/api/signup/create-account"
      }
    }
  ],
  "unaccountedSpans": [],   // must be empty to proceed
  "inventedSpans": []       // must be empty to proceed
}`;

    const userPrompt = `Map every ${role} span from the contract to its exact location in the generated code.
For each span, specify:
- which file it goes in
- where exactly in that file (which function, which callback)
- the instrumentation pattern (startSpan for frontend custom spans, continueTrace for backend distributed trace entry, marker for auto-instrumented)
- for distributedTo spans: which direction (outbound = FE calling BE, inbound = BE receiving) and the exact fetch URL

Every span in the contract for the ${role} layer must appear in spanCoverage.
Do not add spans that are not in the contract.`;

    const response = await this.callLLM([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], settings.llm);

    const parsed = extractJsonObject(response);
    return {
      agentRole: role,
      spanCoverage: parsed.spanCoverage || [],
      unaccountedSpans: parsed.unaccountedSpans || [],
      inventedSpans: parsed.inventedSpans || [],
    };
  }

  async generateCustomFeatures(
    project: EngagementSpec,
    componentType: 'screen' | 'api-endpoint' | 'component'
  ): Promise<{ code: string; description: string }[]> {
    const settings = this.storage.getSettings();

    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      throw new Error('LLM settings not configured');
    }

    const stackDescription = project.stack.type === 'mobile' 
      ? `React Native mobile app with Expo (${project.stack.mobile_framework})`
      : `Next.js frontend`;

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are an expert full-stack developer generating code for a ${project.project.vertical} application.

Stack: ${stackDescription} + Express backend
Project notes: ${project.project.notes || 'None'}

Generate 2-3 key ${componentType} implementations based on the project notes. Return as JSON array:
[
  {
    "code": "// Full implementation code here",
    "description": "Brief description of what this implements"
  }
]

For React Native screens:
- Use functional components with hooks
- Include Sentry instrumentation (startTransaction, custom spans)
- Use React Navigation
- Include basic styling with StyleSheet

For Next.js pages:
- Use Next.js App Router conventions
- Include Sentry instrumentation
- Use Tailwind CSS classes

For API endpoints:
- Express route handlers
- Include Sentry spans for key operations
- Handle errors properly

Return ONLY valid JSON.`
      },
      {
        role: 'user',
        content: `Generate ${componentType} code for: ${project.project.notes || project.project.name}`
      }
    ];

    const response = await this.callLLM(messages, settings.llm);
    
    try {
      const parsed = extractJsonObject(response);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('Failed to parse custom features response:', error);
      return [];
    }
  }

  private buildSystemPrompt(project: EngagementSpec): string {
    let stackDescription: string;

    if (project.stack.type === 'backend-only') {
      const framework = project.stack.backend === 'flask' ? 'Flask' : 'FastAPI';
      stackDescription = `${framework} (Python) backend API`;
    } else if (project.stack.type === 'mobile') {
      stackDescription = `React Native (${project.stack.mobile_framework}) + Express backend`;
    } else {
      stackDescription = `Next.js frontend + Express backend`;
    }

    const websiteNote = project.project.customerWebsite
      ? `\nCustomer Website: ${project.project.customerWebsite}\n(Analyze this to understand their specific business model and critical operations)`
      : '';

    const currentSpans = project.instrumentation.spans.length > 0
      ? '\n\nCURRENT INSTRUMENTATION:\n' + project.instrumentation.spans.map(s =>
          `- \`${s.name}\` (${s.layer}): ${s.description}\n  Attributes: ${Object.keys(s.attributes).join(', ') || 'none'}`
        ).join('\n')
      : '\nNo spans defined yet.';

    return `You are a senior Sentry Solutions Engineer helping design domain-specific instrumentation.

PROJECT:
- Name: ${project.project.name}
- Vertical: ${project.project.vertical}
- Stack: ${stackDescription}
- Requirements: ${project.project.notes || 'Building a demo application'}${websiteNote}
${currentSpans}

YOUR ROLE:
Analyze the project and suggest instrumentation that's SPECIFIC to this application's domain.

KEY PRINCIPLES:

1. UNDERSTAND THE DOMAIN FIRST
   - What type of application is this? (package management? ML? web app? data processing?)
   - What operations are core to THIS use case?
   - Don't assume it's e-commerce unless requirements clearly indicate that

2. SUGGEST DOMAIN-APPROPRIATE SPANS
   Examples by domain:
   - Package Management: \`conda.env.solve\`, \`pkg.fetch\`, \`pkg.extract\`, \`verify.signature\`
   - Data Science: \`data.load\`, \`preprocess.clean\`, \`model.train\`, \`model.predict\`
   - ML Pipeline: \`feature.engineer\`, \`model.evaluate\`, \`inference.batch\`, \`deploy.model\`
   - API Backend: \`request.parse\`, \`db.query\`, \`cache.lookup\`, \`response.serialize\`
   - Web App: \`page.render\`, \`form.validate\`, \`search.execute\`, \`auth.verify\`

3. INCLUDE CONTEXTUAL ATTRIBUTES
   - "Why is this slow?" → data_size, complexity, item_count
   - "What's being processed?" → format, platform, algorithm_type
   - "Where's the time spent?" → cache_hit, network_time_ms, retry_count

4. USE DOMAIN-SPECIFIC NAMING
   - Match the terminology of the application's domain
   - Use technical terms relevant to the use case
   - Don't force generic web/e-commerce patterns

SPAN FORMAT:
Use backticks when suggesting spans: \`category.operation\`
Example: "Consider adding \`conda.env.solve\` to track dependency resolution performance"

Include attributes:
Example: "Attributes: \`spec_size\` (int), \`solver_type\` (string), \`platform\` (string)"

${project.project.customerWebsite || project.project.notes ? `
CONTEXT ANALYSIS:
The project requirements provide context about what this application does.
Use this to suggest spans relevant to the actual use case, not generic patterns.
` : ''}

Focus on practical, domain-specific instrumentation that helps identify real performance issues.`;
  }

  /**
   * Generate complete Next.js pages based on project requirements
   */
  async generateWebPages(project: EngagementSpec, routeContract?: RouteContract, declaration?: InstrumentationDeclaration): Promise<{
    pages: Array<{
      name: string;
      filename: string;
      code: string;
      description: string;
    }>;
  }> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      throw new Error('LLM settings not configured');
    }

    // Include ALL spans — frontend pages call backend spans too (distributed tracing)
    const allSpansList = project.instrumentation.spans;
    const instrumentationDetails = allSpansList
      .map(span => `- Function: trace_${span.name.replace(/\./g, '_')}\n  Span: ${span.name} (${span.op}): ${span.description}\n  Attributes: ${Object.keys(span.attributes).join(', ') || 'none'}`)
      .join('\n');

    // Build a dynamic code example from the project's actual first span (any layer)
    const firstSpan = allSpansList[0];
    const exampleSpanFn = firstSpan
      ? `trace_${firstSpan.name.replace(/\./g, '_')}`
      : 'trace_main_operation';
    const exampleAttrKey = firstSpan && Object.keys(firstSpan.attributes).length > 0
      ? Object.keys(firstSpan.attributes)[0]
      : 'item_count';

    // Build the API contract table — use the frozen route contract when available (preferred),
    // otherwise fall back to inline derivation so the method still works standalone.
    let apiContractTable: string;
    if (routeContract && routeContract.routes.length > 0) {
      apiContractTable = routeContract.routes
        .map(r => `- ${r.method} http://localhost:3001${r.path}  (span: ${r.spanName})`)
        .join('\n');
    } else {
      const deriveApiEndpoint = (spanName: string): string => {
        const parts = spanName.split('.');
        if (parts.length === 1) return `/${parts[0].replace(/_/g, '-')}`;
        const namespace = parts[0];
        const action = parts.slice(1).join('/').replace(/_/g, '-');
        return `/${namespace}/${action}`;
      };
      const FE_READ_KEYWORDS = ['fetch', 'load', 'get', 'list', 'read', 'query', 'search', 'filter', 'view', 'show', 'detail'];
      const feSpanMethod = (spanName: string): string =>
        FE_READ_KEYWORDS.some(k => spanName.toLowerCase().includes(k)) ? 'GET' : 'POST';
      apiContractTable = allSpansList
        .map(s => `- ${feSpanMethod(s.name)} http://localhost:3001/api${deriveApiEndpoint(s.name)}  (span: ${s.name})`)
        .join('\n');
    }
    const generationRules = this.rulesBank?.getRulesForPrompt('generation') || '';
    const instrumentationRules = this.rulesBank?.getRulesForPrompt('instrumentation') || '';
    const allFrontendRules = [generationRules, instrumentationRules].filter(Boolean).join('\n');

    const verticalExample = getVerticalExample(project.project.vertical);

    // Derive required page filenames from span namespaces.
    // e.g. signup.validate_user_input → signup/page.tsx
    //      pageload (no dot)          → page.tsx  (root)
    const feSpansByNamespace = new Map<string, string[]>();
    for (const span of allSpansList.filter(s => s.layer === 'frontend')) {
      const dotIdx = span.name.indexOf('.');
      const ns = dotIdx === -1 ? 'root' : span.name.slice(0, dotIdx);
      if (!feSpansByNamespace.has(ns)) feSpansByNamespace.set(ns, []);
      feSpansByNamespace.get(ns)!.push(span.name);
    }
    const requiredPagesLines = [...feSpansByNamespace.entries()].map(([ns, spans]) => {
      const filename = ns === 'root' ? 'page.tsx' : `${ns}/page.tsx`;
      return `  - ${filename}  ← must contain markers for: ${spans.join(', ')}`;
    }).join('\n');
    const requiredPagesSection = feSpansByNamespace.size > 0
      ? `**REQUIRED PAGES — generate EXACTLY these filenames (derived from your span contract):**\n${requiredPagesLines}\n\nDo NOT generate pages for any other routes. The page filename determines the URL route.`
      : '';

    // Fix 1: Contract compliance checklist — tells the LLM exactly which spans it owns
    const frontendContractSpans = allSpansList.filter(s => s.layer === 'frontend');
    const backendContractSpans  = allSpansList.filter(s => s.layer === 'backend');
    const feSpanList = frontendContractSpans.length > 0
      ? frontendContractSpans.map(s => `  ✓ // INSTRUMENT: ${s.name}`).join('\n')
      : '  (none — generate pages without instrumentation markers)';
    const beSpanListFE = backendContractSpans.length > 0
      ? backendContractSpans.map(s => `  ✗ ${s.name}`).join('\n')
      : '  (none)';
    const feContractChecklist = `## ⚠ CONTRACT COMPLIANCE — READ BEFORE WRITING ANY CODE

The Trace Topology Contract is frozen. You are the FRONTEND agent.
Place exactly ONE \`// INSTRUMENT: <name>\` marker per frontend span listed below.

FRONTEND SPANS — your responsibility (${frontendContractSpans.length} total):
${feSpanList}

BACKEND SPANS — the backend handles these. Do NOT write markers or routes for them:
${beSpanListFE}

SELF-CHECK before returning JSON:
  1. Count your \`// INSTRUMENT:\` lines. Expected = ${frontendContractSpans.length}.
  2. Every name above must appear exactly once.
  3. Any name NOT in the list above is invented — remove it immediately.`;

    // Fix 2: Grounding declaration — LLM's own pre-generation span→file plan
    const declarationGrounding = declaration && declaration.spanCoverage.length > 0
      ? `## GROUNDING DECLARATION — FOLLOW THIS FILE+SPAN MAPPING

You declared the following span placements before code generation. Honour this plan exactly:
${declaration.spanCoverage.map(c => `  • ${c.spanName} → ${c.file} (location: ${c.wrapperLocation})`).join('\n')}`
      : '';

    const prompt = `You are an expert Next.js developer. Generate a complete, production-ready web application.
${allFrontendRules}

**PROJECT DETAILS:**
- Name: ${project.project.name}
- Vertical: ${project.project.vertical}
- Customer Requirements: ${project.project.notes || 'Build a functional demo application'}

**API CONTRACT — every fetch() call must use exactly these URLs and HTTP methods.**
Do not derive paths from span names. Use the paths given here verbatim.

${apiContractTable || '- No spans defined — derive endpoints from project requirements'}

Rules for using this contract:
- Use the EXACT URL listed — no variations, no reinterpretation of the span name
- Use the EXACT HTTP method listed
- For POST/PUT/DELETE: send all span attribute keys as JSON body fields, plus \`se_copilot_run_id: process.env.NEXT_PUBLIC_COPILOT_RUN_ID || 'demo'\`
- For GET: append any span attribute keys as URL query parameters if needed

---

## SECTION A — UI REQUIREMENTS (ALL must be present in every page)

1. **'use client' directive**: Every page's absolute first line must be \`'use client';\` — no exceptions.
2. **State management**: Use \`useState\` and \`useEffect\` for data loading and UI state.
3. **Loading state**: Show a spinner while data loads. Example: \`const [loading, setLoading] = useState(true);\` with \`if (loading) return <spinner />\`.
4. **Error state**: Catch all fetch errors and show an error message UI with a retry button. Example: \`const [error, setError] = useState<string | null>(null);\` with \`if (error) return <error-ui />\`.
5. **Empty state**: When the data array is empty, show a meaningful empty state (icon + message). Do NOT show a blank page.
6. **data-testid attributes**: EVERY interactive element (button, input, form, anchor, select, textarea) MUST have a \`data-testid\` attribute in kebab-case. Examples: \`data-testid="submit-payment-button"\`, \`data-testid="recipient-input"\`, \`data-testid="filter-status-select"\`.
7. **Tailwind CSS**: Use full Tailwind class styling — colors, spacing, typography, responsive layout, hover and focus states, shadows, rounded corners.
8. **Realistic vertical-specific data**: Use hardcoded realistic sample data appropriate for the ${project.project.vertical} vertical. NOT generic items/products — use actual domain objects (e.g. transactions, patients, shipments, subscriptions, orders). The data must feel like a real demo for a ${project.project.vertical} company.
9. **API calls with full error handling**: Every fetch must be inside try/catch/finally. Always update loading and error state correctly.
10. **Interactive elements**: Forms, buttons, filters — the page must DO something when the user interacts with it. Include at least one form or action button per page.
11. **Visual richness**: Cards with shadows, colored status badges, tables with headers, emojis as icons, hover effects.
12. **Page navigation**: Use \`next/link\` for links between pages. NEVER import from \`next/router\` — always use \`next/navigation\`.

---

## SECTION B — INSTRUMENTATION MARKERS (alongside Section A, NOT instead of it)

The full UI from Section A MUST be present. The markers below are ADDED alongside real code — they do NOT replace logic.

1. Do NOT import from \`@sentry/*\` — these imports are injected automatically after generation.
2. Do NOT import \`trace_*\` functions from \`@/lib/instrumentation\` — injected after generation.
3. Do NOT call \`Sentry.startSpan()\`, \`withSentry()\`, or any Sentry SDK function directly.
4. For EVERY span in the instrumentation plan below, place exactly ONE marker comment on the line IMMEDIATELY before the \`try {\` block that wraps that operation:
   \`// INSTRUMENT: <exact_span_name> — <one sentence describing what this code block does>\`
   The marker MUST precede a \`try {\` — NEVER place it before a lone \`const\` or \`await\` statement.
   Reason: the injector wraps whatever block follows the marker. If that block is just \`const res = await fetch(...)\`,
   the \`res\` variable is trapped inside the wrapper and causes a TypeScript "Cannot find name" error on the next line.
   CORRECT: marker → try { const res = await fetch(...); if (!res.ok) ... } catch { ... }
   WRONG:   marker → const res = await fetch(...);  ← res is then out of scope outside the callback
5. Use the EXACT span name — do not abbreviate, paraphrase, or change dots to hyphens.
6. Business logic and UI must still be fully present — markers sit alongside real fetch/compute code, not replace it.

**INSTRUMENTATION PLAN — spans to place markers for:**
${instrumentationDetails}

CORRECT marker placement — before a try block so the entire fetch + error-check stays in scope:
\`\`\`
// INSTRUMENT: checkout.process_payment — validates card and charges the customer
try {
  const res = await fetch('/api/checkout/process-payment', { method: 'POST', body: JSON.stringify(payload) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  setResult(data);
} catch (err) {
  setError(String(err));
} finally {
  setLoading(false);
}
\`\`\`

WRONG placement — before a lone \`const\` causes "Cannot find name" TypeScript error:
\`\`\`
// INSTRUMENT: checkout.process_payment — ...   ← WRONG: res is trapped inside the injector callback
const res = await fetch('/api/checkout/process-payment', ...);
if (!res.ok) throw new Error('HTTP ' + res.status);  // ← TypeScript error: res not in scope
\`\`\`

WRONG span name:   \`// INSTRUMENT: process_payment\` (abbreviated — missing namespace)
WRONG span name:   \`// INSTRUMENT: checkout.process-payment\` (hyphens instead of dots)

---

${feContractChecklist}

${declarationGrounding}

## SECTION C — RICH EXAMPLE (follow this exact level of quality)

The example below shows what a complete, production-quality page looks like for the ${project.project.vertical} vertical.
Adapt all domain data, labels, and interactions to match ${project.project.name} — do NOT copy this verbatim.

${verticalExample}

---

**TASK:** Generate Next.js pages (App Router) for ${project.project.name}.

${requiredPagesSection}

**FILE NAMING — App Router conventions:**
- Home/main page: filename = \`page.tsx\`
- Sub-pages: subdirectory format — e.g. \`signup/page.tsx\`, \`transactions/page.tsx\`, \`patients/page.tsx\`
- NEVER use the \`.page.tsx\` suffix pattern (e.g. \`signup.page.tsx\` is WRONG)

**ADDITIONAL RULES:**
- NEVER import Html, Head, Main, or NextScript from \`next/document\` — Pages Router only
- If you use \`useSearchParams()\`, wrap the component in a \`React.Suspense\` boundary
- Build for THIS project's domain — not a generic dashboard unless the project is explicitly a dashboard app
- The REQUIRED PAGES list above is authoritative — build exactly those pages, each focused on the domain operations in its span list

Return ONLY valid JSON (no markdown):
{
  "pages": [
    {
      "name": "HomePage",
      "filename": "page.tsx",
      "code": "<full TypeScript source — complete runnable page>",
      "description": "Main dashboard"
    }
  ]
}

CRITICAL: Every "code" value must be the complete, runnable Next.js page. No placeholders, no "// rest of code" comments, no "// page content here" stubs. Write the actual full code.`;

    const messages: ChatMessage[] = [
      { role: 'user', content: prompt }
    ];

    const response = await this.callLLMDirect(messages, { ...settings.llm, promptId: 'generateWebPages' });

    try {
      const jsonString = this.extractJsonFromResponse(response);

      // Log first 500 chars for debugging
      console.log('📄 Extracted JSON (first 500 chars):', jsonString.substring(0, 500));
      
      let result;
      try {
        result = JSON.parse(jsonString);
      } catch (parseError) {
        // Log more context on parse failure
        console.error('❌ JSON Parse Error at:', parseError);
        console.error('📄 Full extracted JSON:', jsonString.substring(0, 1000));
        throw parseError;
      }

      if (!result.pages || !Array.isArray(result.pages)) {
        throw new Error('Invalid response: missing pages array');
      }

      for (const page of result.pages) {
        if (!page.name || !page.filename || !page.code) {
          throw new Error(`Invalid page: ${JSON.stringify(page)}`);
        }
      }

      console.log(`✅ Generated ${result.pages.length} Next.js pages`);
      return result;
    } catch (error) {
      console.error('Failed to generate web pages:', error);
      throw new Error(`Failed to generate web pages: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Validate and fix a generated Next.js page by replacing any hallucinated
   * instrumentation function names or wrong API endpoints with the correct ones.
   */
  async validateAndFixPage(
    page: { name: string; filename: string; code: string; description: string },
    validFunctionNames: string[],
    validEndpoints: string[]
  ): Promise<{ name: string; filename: string; code: string; description: string }> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      return page;
    }

    const functionList = validFunctionNames.map(f => `- ${f}`).join('\n');
    const endpointList = validEndpoints.map(ep => `- http://localhost:3001/api${ep}`).join('\n');

    const prompt = `A Next.js page was generated but may have instrumentation problems. Fix it.

**VALID INSTRUMENTATION FUNCTIONS** (these are the ONLY valid exports from '@/lib/instrumentation'):
${functionList}

**VALID API ENDPOINTS** (these are the ONLY valid backend URLs):
${endpointList}

**PAGE CODE TO FIX:**
\`\`\`typescript
${page.code}
\`\`\`

**RULES:**
1. Replace any name imported from '@/lib/instrumentation' that is NOT in the valid list with the closest matching valid function name. Update all usages in the function body too.
2. If the page uses inline \`Sentry.startSpan({ op: '...', name: '...' }, ...)\` for an operation that matches one of the valid functions above, replace it with the proper helper (e.g. \`trace_form_submit(callback, attributes)\`) and add the import from '@/lib/instrumentation'. Match by op or name similarity.
3. Replace any fetch() URL to http://localhost:3001 that does NOT match a valid endpoint with the closest matching valid endpoint.
4. CRITICAL — trace function call signature: every call to a trace_* function MUST have an \`async () => {...}\` function as the FIRST argument. If you see a call like \`traceFunc(stringValue, ...)\` or \`traceFunc(variableName, 'label', ...)\` where the first arg is not a function, fix it to \`await traceFunc(async () => {}, { field_name: stringValue })\`.
5. Do NOT modify any other logic, state management, JSX, or styling.
6. Return ONLY the corrected TypeScript code — no explanation, no markdown fences.`;

    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

    const raw = await this.callLLM(messages, {
      baseUrl: settings.llm.baseUrl,
      apiKey: settings.llm.apiKey,
      model: settings.llm.model || 'gpt-4-turbo-preview',
    });

    // Strip markdown fences if LLM wrapped the response (including any trailing explanation)
    const cleaned = raw
      .replace(/^```(?:typescript|tsx|ts)?\n?/, '')
      .replace(/\n?```[\s\S]*$/, '')
      .trim();

    // Sanity check: ensure fixed code actually contains valid function names
    const importMatch = cleaned.match(/import \{([^}]+)\} from ['"]@\/lib\/instrumentation['"]/);
    if (importMatch) {
      const importedNames = importMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      const stillInvalid = importedNames.some(n => !validFunctionNames.includes(n));
      if (stillInvalid) {
        console.warn(`  ⚠️  LLM fix for ${page.filename} still has invalid imports, keeping original`);
        return page;
      }
    }

    return { ...page, code: cleaned };
  }

  /**
   * Generate complete mobile app screens based on project requirements
   */
  async generateMobileScreens(project: EngagementSpec): Promise<{
    screens: Array<{
      name: string;
      filename: string;
      code: string;
      description: string;
    }>;
  }> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      throw new Error('LLM settings not configured');
    }

    const framework = project.stack.mobile_framework || 'react-native';
    const instrumentationDetails = project.instrumentation.spans
      .map(span => `- ${span.name} (${span.op}): ${span.description}\n  Attributes: ${Object.keys(span.attributes).join(', ') || 'none'}`)
      .join('\n');

    const prompt = `You are an expert ${framework} developer. Generate a complete, production-ready mobile app based on these requirements:

**PROJECT DETAILS:**
- Name: ${project.project.name}
- Vertical: ${project.project.vertical}
- Customer Requirements: ${project.project.notes}

**SENTRY INSTRUMENTATION REQUIREMENTS (MUST IMPLEMENT):**
${instrumentationDetails}

**TASK:** Generate 3-5 interactive screens that implement the functionality described in the customer requirements.

**SCREEN REQUIREMENTS:**
1. Each screen must be fully functional with:
   - State management (useState, useEffect)
   - API calls using \`apiService\` imported from '../services/api'
   - Sentry instrumentation matching the spans above
   - Professional styling with React Native StyleSheet
   - Loading states, error handling, empty states
   - Interactive elements (TouchableOpacity, buttons, inputs)
2. Use emojis for images (🎧 💻 💰 📊 🏠 🛒 ⚡ etc.)
3. Implement the EXACT spans listed above with correct op types and attributes
4. Add custom attributes to spans using span.setData()
5. Use React Navigation (navigation prop is available)

**CODE STRUCTURE:**
\`\`\`typescript
import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import * as Sentry from '@sentry/react-native';
import { apiService } from '../services/api';

export default function ScreenName({ navigation }: any) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const transaction = Sentry.startTransaction({
      name: 'ScreenName.loadData',
      op: 'screen.load',
    });

    try {
      const result = await apiService.getData();
      setData(result);
      transaction.setData('data_count', result.length);
    } catch (error) {
      Sentry.captureException(error);
      Alert.alert('Error', 'Failed to load data');
    } finally {
      setLoading(false);
      transaction.finish();
    }
  };

  const handleAction = async (item: any) => {
    const span = Sentry.startInactiveSpan({
      name: 'user.action',
      op: 'ui.action',
    });
    span?.setData('item_id', item.id);
    // ... action logic
    span?.finish();
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6366f1" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Screen Title</Text>
      <FlatList
        data={data}
        keyExtractor={(item) => item.id.toString()}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => handleAction(item)}>
            <Text style={styles.emoji}>{item.image}</Text>
            <View style={styles.info}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.description}>{item.description}</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb', padding: 16 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 28, fontWeight: 'bold', marginBottom: 16, color: '#111827' },
  card: {
    flexDirection: 'row',
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  emoji: { fontSize: 48, marginRight: 16 },
  info: { flex: 1 },
  name: { fontSize: 18, fontWeight: '600', color: '#111827', marginBottom: 4 },
  description: { fontSize: 14, color: '#6b7280' },
});
\`\`\`

Return ONLY valid JSON in this exact format (no markdown):
{
  "screens": [
    {
      "name": "HomeScreen",
      "filename": "HomeScreen.tsx",
      "code": "import React...",
      "description": "Main home screen"
    }
  ]
}`;

    const messages: ChatMessage[] = [
      { role: 'user', content: prompt }
    ];

    const response = await this.callLLM(messages, settings.llm);
    
    try {
      const jsonString = this.extractJsonFromResponse(response);
      const result = JSON.parse(jsonString);
      
      if (!result.screens || !Array.isArray(result.screens)) {
        throw new Error('Invalid response: missing screens array');
      }

      for (const screen of result.screens) {
        if (!screen.name || !screen.filename || !screen.code) {
          throw new Error(`Invalid screen: ${JSON.stringify(screen)}`);
        }
      }

      console.log(`✅ Generated ${result.screens.length} mobile screens`);
      return result;
    } catch (error) {
      console.error('Failed to generate mobile screens:', error);
      throw new Error(`Failed to generate mobile screens: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate Express API routes with backend instrumentation
   */
  async generateExpressRoutes(project: EngagementSpec, routeContract?: RouteContract, declaration?: InstrumentationDeclaration): Promise<{ code: string }> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      throw new Error('LLM settings not configured');
    }

    const backendSpans = project.instrumentation.spans
      .filter(s => s.layer === 'backend')
      .map(span => `- ${span.name} (${span.op}): ${span.description}\n  Attributes: ${Object.keys(span.attributes).join(', ') || 'none'}`)
      .join('\n');

    // Derive import names and a meaningful endpoint example from the actual spans
    const backendSpanList = project.instrumentation.spans.filter(s => s.layer === 'backend');
    const frontendSpanListForRoutes = project.instrumentation.spans.filter(s => s.layer === 'frontend');
    const allSpanImports = project.instrumentation.spans
      .map(s => `trace_${s.name.replace(/\./g, '_')}`).join(', ');

    // Build the route contract table — use the frozen contract when available (preferred).
    // Falls back to inline derivation so the method still works standalone.
    let requiredRoutes: string;
    if (routeContract && routeContract.routes.length > 0) {
      requiredRoutes = routeContract.routes
        .map(r => `- ${r.method} ${r.path}  (span: ${r.spanName}, body keys: ${r.requestBodyKeys.join(', ')})`)
        .join('\n');
    } else {
      const deriveRouteEndpoint = (spanName: string): string => {
        const parts = spanName.split('.');
        if (parts.length === 1) return `/${parts[0].replace(/_/g, '-')}`;
        const namespace = parts[0];
        const action = parts.slice(1).join('/').replace(/_/g, '-');
        return `/${namespace}/${action}`;
      };
      const READ_KEYWORDS = ['fetch', 'load', 'get', 'list', 'read', 'query', 'search', 'filter', 'view', 'show', 'detail'];
      const spanMethod = (spanName: string): string =>
        READ_KEYWORDS.some(k => spanName.toLowerCase().includes(k)) ? 'GET' : 'POST';
      requiredRoutes = project.instrumentation.spans.map(s => {
        const route = deriveRouteEndpoint(s.name);
        return `- ${spanMethod(s.name)} /api${route}  (span: ${s.name})`;
      }).join('\n');
    }

    const allSpansForRoutes = project.instrumentation.spans;
    const firstAnySpan = allSpansForRoutes[0];
    const firstBackendSpan = backendSpanList[0];
    const firstContractRoute = routeContract?.routes[0];
    const exampleRoute = firstContractRoute
      ? firstContractRoute.path
      : firstAnySpan
      ? (() => { const p = firstAnySpan.name.split('.'); return `/api/${p[0]}/${(p.slice(1).join('/') || 'action').replace(/_/g, '-')}`; })()
      : '/api/process';
    const exampleTraceFn = firstAnySpan
      ? `trace_${firstAnySpan.name.replace(/\./g, '_')}`
      : 'trace_main_operation';
    const firstAttrKey = firstBackendSpan && Object.keys(firstBackendSpan.attributes).length > 0
      ? Object.keys(firstBackendSpan.attributes)[0]
      : null;
    // Quote keys that contain dots (e.g. 'http.method') — unquoted dot-keys are JS syntax errors
    const exampleAttr = firstAttrKey
      ? `'${firstAttrKey}': req.body?.${firstAttrKey.replace(/\./g, '_')} || ''`
      : 'request_id: req.id || ""';

    const frontendSpansSummary = frontendSpanListForRoutes
      .map(s => `- ${s.name} (${s.op}): ${s.description}`)
      .join('\n');

    const expressRules = this.rulesBank?.getRulesForPrompt('generation') || '';
    const expressInstrumentationRules = this.rulesBank?.getRulesForPrompt('instrumentation') || '';
    const allBackendRules = [expressRules, expressInstrumentationRules].filter(Boolean).join('\n');

    // Fix 1: Contract compliance checklist for backend
    const beContractSpans = project.instrumentation.spans.filter(s => s.layer === 'backend');
    const feContractSpans = project.instrumentation.spans.filter(s => s.layer === 'frontend');
    const beSpanList = beContractSpans.length > 0
      ? beContractSpans.map(s => {
          const route = routeContract?.routes.find(r => r.spanName === s.name);
          const routeHint = route ? ` → ${route.method} ${route.path}` : '';
          return `  ✓ // INSTRUMENT: ${s.name}${routeHint}`;
        }).join('\n')
      : '  (none)';
    const feSpanListBE = feContractSpans.length > 0
      ? feContractSpans.map(s => `  ✗ ${s.name}`).join('\n')
      : '  (none)';
    const beContractChecklist = `## ⚠ CONTRACT COMPLIANCE — READ BEFORE WRITING ANY CODE

The Trace Topology Contract is frozen. You are the BACKEND agent.
Create exactly ONE route + ONE \`// INSTRUMENT: <name>\` marker per backend span listed below.

BACKEND SPANS — your responsibility (${beContractSpans.length} total):
${beSpanList}

FRONTEND SPANS — the frontend handles these. Do NOT add routes or markers for them:
${feSpanListBE}

SELF-CHECK before returning code:
  1. Count your \`// INSTRUMENT:\` lines. Expected = ${beContractSpans.length}.
  2. Every name above must have its own unique route.
  3. Any name NOT in the list above is invented — remove it immediately.`;

    // Fix 2: Grounding declaration for backend
    const beDeclarationGrounding = declaration && declaration.spanCoverage.length > 0
      ? `## GROUNDING DECLARATION — FOLLOW THIS SPAN→ROUTE MAPPING

You declared the following span placements before code generation. Honour this plan exactly:
${declaration.spanCoverage.map(c => `  • ${c.spanName} → ${c.file} (location: ${c.wrapperLocation})`).join('\n')}`
      : '';

    const prompt = `Generate Express.js API routes for the following application with Sentry instrumentation.
${allBackendRules}
**PROJECT:** ${project.project.name}
**VERTICAL:** ${project.project.vertical}
**REQUIREMENTS:** ${project.project.notes || 'Build functional API endpoints that match the custom spans below'}

**SENTRY BACKEND INSTRUMENTATION (call these within route handlers):**
${backendSpans || '(none — instrument with generic spans)'}

**FRONTEND SPANS (each needs a matching API route — these MUST be implemented):**
${frontendSpansSummary || '(none)'}

**ROUTE CONTRACT — implement EVERY route in this list. Do not derive paths from span names.**
Use the exact method and path given here. Do not rename, reinterpret, or skip any route.

${requiredRoutes || '- Derive routes from the backend spans above'}

${beContractChecklist}

${beDeclarationGrounding}

**CRITICAL REQUIREMENTS:**
1. Implement EVERY route in the ROUTE CONTRACT above — the frontend calls these exact paths verbatim
2. The Express path must exactly match the "path" column — no variations
3. The HTTP method must exactly match the "method" column
4. Every handler must read \`se_copilot_run_id\` from \`req.body\` and include it in the response
5. Read all other body keys listed in the contract from \`req.body\` (or \`req.query\` for GET)
6. Do NOT import from '../utils/instrumentation' or use trace_* functions — injected after generation
7. Do NOT import Sentry or use Sentry.startSpan — instrumentation is added automatically
8. For every route, place exactly one marker comment at the point where the operation begins:
   // INSTRUMENT: <exact_span_name_from_plan> — <one sentence describing what this wraps>
9. Return realistic mock data that matches the domain of "${project.project.name}"
10. EVERY span gets its OWN unique route. NEVER register two spans on the same method+path.
    WRONG (collapsed): router.post('/operation', ...) × 3  ← only the first ever fires in Express
    CORRECT (unique):  router.get('/product/fetch-details', ...) and router.post('/payment/process-payment', ...)

**IMPORTANT:**
- DO NOT generate generic e-commerce routes (products/cart/checkout) unless this is explicitly an e-commerce project
- Route paths are EXACTLY as specified in REQUIRED ROUTES above — do not rename them or use op-based names
- CRITICAL: Span attribute keys with dots MUST be quoted strings. CORRECT: \`{ 'http.method': value }\`. WRONG: \`{ http.method: value }\` — this is a JavaScript SyntaxError
- CRITICAL: Place exactly one // INSTRUMENT: <span_name> marker in each route handler, at the point where the main operation runs
- CRITICAL: Keep the route structure simple — the instrumentation injector will wrap the marked code with the correct Sentry span

**CODE PATTERN (use INSTRUMENT markers, NOT Sentry SDK calls):**
\`\`\`javascript
const express = require('express');
const router = express.Router();

// Each span gets its OWN route — never collapse multiple spans onto the same path
router.${(firstAnySpan && spanMethod(firstAnySpan.name).toLowerCase()) || 'post'}('/api${exampleRoute}', async (req, res) => {
  try {
    // INSTRUMENT: ${firstAnySpan?.name || 'main_operation'} — handles the ${firstAnySpan?.name?.split('.')[1]?.replace(/_/g, ' ') || 'main operation'} request
    await new Promise(resolve => setTimeout(resolve, Math.random() * 300 + 100));
    res.json({ success: true, data: { /* realistic mock data for this domain */ } });
  } catch (error) {
    res.status(500).json({ error: 'Operation failed' });
  }
});

module.exports = router;
\`\`\`

Return ONLY the complete JavaScript code (no JSON wrapper, no markdown code blocks).`;

    const messages: ChatMessage[] = [
      { role: 'user', content: prompt }
    ];

    const response = await this.callLLM(messages, settings.llm);

    // Remove markdown code blocks if present (including any explanation text after the closing fence)
    let code = response.trim();
    if (code.startsWith('```')) {
      code = code.replace(/^```(?:javascript|js|typescript|ts)?\n?/, '');
      code = code.replace(/\n?```[\s\S]*$/, '');
      code = code.trim();
    }

    console.log('✅ Generated Express API routes with instrumentation');
    return { code };
  }

  /**
   * Generate API service file for mobile/web apps
   */
  async generateApiService(project: EngagementSpec): Promise<{ code: string }> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      throw new Error('LLM settings not configured');
    }

    const prompt = `Generate a TypeScript API service file for a ${project.stack.mobile_framework || 'react-native'} app.

**PROJECT:** ${project.project.name}
**REQUIREMENTS:** ${project.project.notes}

**TASK:** Create an API service with methods that support the app functionality.

**REQUIREMENTS:**
1. Use axios for HTTP requests
2. Include Sentry instrumentation on ALL API calls
3. **IMPORTANT:** Fallback to mock data when backend is unavailable (for Expo Snack)
4. Create methods based on the project requirements
5. Include 6-8 diverse mock items with emojis (🎧 💻 📱 🎮 📷 🎯 💰 📊 etc.)
6. Mock data should match the project's use case

**STRUCTURE:**
\`\`\`typescript
import axios from 'axios';
import * as Sentry from '@sentry/react-native';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';

// Mock data for demo (used when backend unavailable)
const MOCK_ITEMS = [
  { id: 1, name: 'Item 1', description: 'Description here', price: 99.99, image: '🎯' },
  { id: 2, name: 'Item 2', description: 'Description here', price: 149.99, image: '💻' },
  // ... 6-8 items total
];

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

export const apiService = {
  async getItems() {
    const span = Sentry.startInactiveSpan({
      name: 'api.fetch_items',
      op: 'http.client',
    });

    try {
      const response = await apiClient.get('/api/items');
      span?.setData('item_count', response.data.length);
      span?.setData('data_source', 'backend');
      return response.data;
    } catch (error) {
      console.log('Backend unavailable, using mock data');
      span?.setData('item_count', MOCK_ITEMS.length);
      span?.setData('data_source', 'mock');
      return MOCK_ITEMS; // Fallback to mock data
    } finally {
      span?.finish();
    }
  },
  
  // ... more methods with same pattern
};
\`\`\`

Return ONLY the TypeScript code (no JSON wrapper, no markdown code blocks).`;

    const messages: ChatMessage[] = [
      { role: 'user', content: prompt }
    ];

    const response = await this.callLLM(messages, settings.llm);
    
    // Remove markdown code blocks if present (including any explanation text after the closing fence)
    let code = response.trim();
    if (code.startsWith('```')) {
      code = code.replace(/^```(?:typescript|ts|javascript|js)?\n?/, '');
      code = code.replace(/\n?```[\s\S]*$/, '');
      code = code.trim();
    }

    console.log('✅ Generated API service');
    return { code };
  }

  /**
   * Read existing code and generate refinements based on user request
   */
  async refineGeneratedCode(
    project: EngagementSpec,
    filePath: string,
    existingCode: string,
    refinementRequest: string
  ): Promise<{ code: string; changes: string }> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      throw new Error('LLM settings not configured');
    }

    const framework = project.stack.type === 'mobile' 
      ? project.stack.mobile_framework 
      : project.stack.frontend;

    const prompt = `You are refining existing code for a ${framework} application.

**PROJECT:** ${project.project.name}
**FILE:** ${filePath}
**USER REQUEST:** ${refinementRequest}

**EXISTING CODE:**
\`\`\`typescript
${existingCode}
\`\`\`

**TASK:** Modify the code to implement the user's request while:
1. Preserving existing functionality that's not being changed
2. Maintaining code style and structure
3. Keeping all Sentry instrumentation intact (or add new spans for new features)
4. Following React Native/TypeScript best practices
5. Adding proper error handling for new features
6. Maintaining styling consistency with StyleSheet

**IMPORTANT:**
- Return the COMPLETE updated file code
- Do not use placeholders like "// rest of code"
- Include all imports, styles, and existing functions
- Add Sentry spans for any new user interactions or API calls
- Use proper JSON with double quotes, NOT backticks or template literals
- Escape special characters in strings (newlines as \\n, quotes as \\", etc.)

Return ONLY valid JSON (no markdown, no backticks):
{
  "code": "// Complete updated code here with ALL content",
  "changes": "Brief description of what was changed"
}

CRITICAL: The "code" field must be a JSON string with double quotes, not backticks!`;

    const messages: ChatMessage[] = [
      { role: 'user', content: prompt }
    ];

    const response = await this.callLLM(messages, settings.llm);
    
    try {
      const jsonString = this.extractJsonFromResponse(response);
      const result = JSON.parse(jsonString);
      
      if (!result.code || !result.changes) {
        throw new Error('Invalid refinement response: missing code or changes');
      }

      console.log(`✅ Refined ${filePath}: ${result.changes}`);
      return result;
    } catch (error) {
      console.error('Failed to refine code:', error);
      throw new Error(`Failed to refine code: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Analyze generated app and suggest improvements
   */
  async analyzeGeneratedApp(
    project: EngagementSpec,
    fileContents: Record<string, string>
  ): Promise<{
    suggestions: Array<{
      file: string;
      suggestion: string;
      priority: 'high' | 'medium' | 'low';
    }>;
  }> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      throw new Error('LLM settings not configured');
    }

    const fileList = Object.entries(fileContents)
      .map(([file, code]) => {
        const preview = code.length > 800 ? code.substring(0, 800) + '...' : code;
        return `**${file}** (${code.split('\n').length} lines)\n\`\`\`typescript\n${preview}\n\`\`\``;
      })
      .join('\n\n');

    const prompt = `Analyze this generated ${project.stack.type} app and suggest concrete improvements:

**PROJECT:** ${project.project.name}
**REQUIREMENTS:** ${project.project.notes}
**TECH STACK:** ${project.stack.type === 'mobile' ? 'React Native + Expo' : 'Next.js'}

**GENERATED FILES:**
${fileList}

**TASK:** Review the code and suggest 3-5 concrete, actionable improvements for:
1. Better user experience (loading states, animations, feedback)
2. Additional features that match the project requirements
3. Better error handling and edge cases
4. Enhanced Sentry instrumentation (more spans, better attributes)
5. Code quality improvements

**IMPORTANT:** Suggestions should be specific and implementable, not generic advice.

Return ONLY valid JSON (no markdown):
{
  "suggestions": [
    {
      "file": "screens/HomeScreen.tsx",
      "suggestion": "Add pull-to-refresh functionality to reload products",
      "priority": "medium"
    }
  ]
}`;

    const messages: ChatMessage[] = [
      { role: 'user', content: prompt }
    ];

    const response = await this.callLLM(messages, settings.llm);
    
    try {
      const jsonString = this.extractJsonFromResponse(response);
      const result = JSON.parse(jsonString);
      
      if (!result.suggestions || !Array.isArray(result.suggestions)) {
        console.warn('No suggestions returned from LLM');
        return { suggestions: [] };
      }

      console.log(`✅ Generated ${result.suggestions.length} improvement suggestions`);
      return result;
    } catch (error) {
      console.error('Failed to analyze app:', error);
      return { suggestions: [] };
    }
  }

  /**
   * Extract JSON from LLM response that might be wrapped in markdown or have extra text
   */
  private extractJsonFromResponse(responseText: string): string {
    let cleanedResponse = responseText.trim();
    
    // Remove markdown code blocks
    if (cleanedResponse.startsWith('```json')) {
      cleanedResponse = cleanedResponse.substring(7);
    } else if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.substring(3);
    }
    if (cleanedResponse.endsWith('```')) {
      cleanedResponse = cleanedResponse.slice(0, -3);
    }
    cleanedResponse = cleanedResponse.trim();

    // IMPORTANT: Fix LLM using backticks instead of double quotes for JSON values
    // This is a common mistake where LLM returns JavaScript template literals
    // Pattern: "key": `value` should become "key": "value"
    // Use regex with dotall flag (s) to match across newlines
    cleanedResponse = cleanedResponse.replace(/:\s*`([\s\S]*?)`/g, (match, content) => {
      // Comprehensive JSON string escape function
      const escaped = this.escapeJsonString(content);
      return `: "${escaped}"`;
    });

    // Find the actual JSON start and end
    const firstBrace = cleanedResponse.indexOf('{');
    const firstBracket = cleanedResponse.indexOf('[');
    let jsonStartIndex = -1;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      jsonStartIndex = firstBrace;
    } else if (firstBracket !== -1) {
      jsonStartIndex = firstBracket;
    }

    if (jsonStartIndex === -1) {
      throw new Error('No JSON object or array found in LLM response.');
    }

    let openBraces = 0;
    let openBrackets = 0;
    let jsonEndIndex = -1;
    let inString = false;
    let escapeNext = false;

    for (let i = jsonStartIndex; i < cleanedResponse.length; i++) {
      const char = cleanedResponse[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }
      
      if (!inString) {
        if (char === '{') openBraces++;
        else if (char === '}') openBraces--;
        else if (char === '[') openBrackets++;
        else if (char === ']') openBrackets--;

        if (openBraces === 0 && openBrackets === 0 && (char === '}' || char === ']')) {
          jsonEndIndex = i;
          break;
        }
      }
    }

    if (jsonEndIndex === -1) {
      throw new Error('Incomplete JSON object or array in LLM response.');
    }

    let jsonStr = cleanedResponse.substring(jsonStartIndex, jsonEndIndex + 1);
    
    // Fix common JSON issues (comments, trailing commas, control characters)
    jsonStr = this.fixCommonJsonIssues(jsonStr);

    return jsonStr;
  }

  /**
   * Escape special characters for JSON string values
   */
  private escapeJsonString(str: string): string {
    return str.replace(/[\u0000-\u001F\u007F-\u009F"\\]/g, (char) => {
      switch (char) {
        case '"': return '\\"';
        case '\\': return '\\\\';
        case '\b': return '\\b';
        case '\f': return '\\f';
        case '\n': return '\\n';
        case '\r': return '\\r';
        case '\t': return '\\t';
        default:
          // For other control characters, use unicode escape
          return '\\u' + ('0000' + char.charCodeAt(0).toString(16)).slice(-4);
      }
    });
  }

  /**
   * Fix control characters inside JSON string values that the LLM forgot to escape
   */
  private fixControlCharactersInJsonStrings(jsonStr: string): string {
    const result: string[] = [];
    let inString = false;
    let escapeNext = false;
    
    for (let i = 0; i < jsonStr.length; i++) {
      const char = jsonStr[i];
      const charCode = char.charCodeAt(0);
      
      if (escapeNext) {
        result.push(char);
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        result.push(char);
        escapeNext = true;
        continue;
      }
      
      if (char === '"') {
        result.push(char);
        inString = !inString;
        continue;
      }
      
      // If we're inside a string and encounter an unescaped control character, escape it
      if (inString && charCode < 32) {
        switch (char) {
          case '\n': result.push('\\n'); break;
          case '\r': result.push('\\r'); break;
          case '\t': result.push('\\t'); break;
          case '\b': result.push('\\b'); break;
          case '\f': result.push('\\f'); break;
          default:
            result.push('\\u' + ('0000' + charCode.toString(16)).slice(-4));
        }
        continue;
      }
      
      result.push(char);
    }
    
    return result.join('');
  }

  /**
   * Remove JavaScript-style comments from JSON (LLMs sometimes add these)
   */
  private removeJsonComments(jsonStr: string): string {
    let result = '';
    let inString = false;
    let escapeNext = false;
    let i = 0;
    
    while (i < jsonStr.length) {
      const char = jsonStr[i];
      const nextChar = jsonStr[i + 1];
      
      if (escapeNext) {
        result += char;
        escapeNext = false;
        i++;
        continue;
      }
      
      if (char === '\\' && inString) {
        result += char;
        escapeNext = true;
        i++;
        continue;
      }
      
      if (char === '"') {
        result += char;
        inString = !inString;
        i++;
        continue;
      }
      
      // Skip single-line comments (// ...) when not in string
      if (!inString && char === '/' && nextChar === '/') {
        // Skip until end of line
        while (i < jsonStr.length && jsonStr[i] !== '\n') {
          i++;
        }
        continue;
      }
      
      // Skip multi-line comments (/* ... */) when not in string
      if (!inString && char === '/' && nextChar === '*') {
        i += 2; // Skip /*
        while (i < jsonStr.length - 1 && !(jsonStr[i] === '*' && jsonStr[i + 1] === '/')) {
          i++;
        }
        i += 2; // Skip */
        continue;
      }
      
      result += char;
      i++;
    }
    
    return result;
  }

  /**
   * Fix common JSON issues from LLM output
   */
  private fixCommonJsonIssues(jsonStr: string): string {
    // Remove comments first
    let fixed = this.removeJsonComments(jsonStr);
    
    // Fix trailing commas before ] or }
    fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
    
    // Fix single quotes used as string delimiters (outside of already-quoted strings)
    // This is tricky - we need to be careful not to break strings that contain single quotes
    
    // Fix control characters
    fixed = this.fixControlCharactersInJsonStrings(fixed);
    
    return fixed;
  }

  /**
   * Analyze customer website to understand business model and user journeys
   */
  private async analyzeCustomerWebsite(websiteUrl: string): Promise<string> {
    try {
      const settings = this.storage.getSettings();

      // Fetch the website content
      console.log('Fetching website content...');
      const response = await fetch(websiteUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        redirect: 'follow'
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch website: ${response.status}`);
      }

      const html = await response.text();

      // Extract text content from HTML (basic extraction)
      const textContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 8000); // Limit to first 8000 chars

      console.log('Analyzing website with LLM...');

      // Use LLM to analyze the website
      const analysisMessages: ChatMessage[] = [
        {
          role: 'system',
          content: `You are a business analyst. Analyze the website content and provide a concise summary of:
1. Business Type & Model (e.g., B2C e-commerce, SaaS platform, marketplace)
2. Primary Products/Services (generic categories only, DO NOT mention brand names)
3. Key User Journeys (e.g., browse → search → filter → checkout, signup → onboarding → dashboard)
4. Critical Features (e.g., search, filtering, checkout, payments, user accounts, recommendations)
5. Performance-Critical Operations (what would impact user experience most)

IMPORTANT:
- Focus on TYPES of operations, not specific brand features
- Use generic terminology (e.g., "product catalog" not specific product names)
- Identify what performance metrics would matter most for this type of business
- Keep the analysis concise (under 300 words)

Return a structured analysis that can be used to recommend relevant Sentry instrumentation.`
        },
        {
          role: 'user',
          content: `Website URL: ${websiteUrl}\n\nContent:\n${textContent}`
        }
      ];

      const analysis = await this.callLLM(analysisMessages, settings.llm);
      console.log('Website analysis complete');

      return analysis;
    } catch (error) {
      console.error('Failed to analyze website:', error);
      return `Failed to fetch website (${error instanceof Error ? error.message : 'Unknown error'}). Proceeding with vertical-based recommendations only.`;
    }
  }

  async suggestCustomSpans(projectId: string): Promise<{
    message: string;
    spans: SpanDefinition[];
  }> {
    const project = this.storage.getProject(projectId);
    const settings = this.storage.getSettings();

    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      throw new Error('LLM settings not configured');
    }

    const { name, vertical, customerWebsite, notes } = project.project;
    const { type: stackType, backend, frontend } = project.stack;

    let stackDesc = '';
    if (stackType === 'web') {
      stackDesc = `Web app (${frontend || 'Next.js'} frontend, ${backend} backend)`;
    } else if (stackType === 'mobile') {
      stackDesc = `Mobile app (React Native, ${backend} backend)`;
    } else {
      stackDesc = `Backend-only service (${backend})`;
    }

    const projectContext = [
      `- Name: ${name}`,
      `- Vertical: ${vertical}`,
      `- Stack: ${stackDesc}`,
      customerWebsite ? `- Website: ${customerWebsite}` : null,
      notes ? `- Notes: ${notes}` : null
    ].filter(Boolean).join('\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are a Sentry instrumentation expert. Always respond with valid JSON only — no markdown, no code fences, no extra text.'
      },
      {
        role: 'user',
        content: `Based on the following project information, suggest 4-6 highly relevant custom spans and attributes that would provide the most valuable observability insights for this specific application.

Project Information:
${projectContext}

Return a JSON object with this exact structure:
{
  "message": "A brief 2-3 sentence conversational message explaining what you are suggesting and why these spans are valuable for this specific project",
  "spans": [
    {
      "name": "checkout.validate_cart",
      "op": "checkout",
      "layer": "backend",
      "description": "What this span measures",
      "attributes": {
        "attr_name": "What this attribute captures"
      },
      "pii": { "keys": [] }
    }
  ]
}

Requirements:
- Suggest spans SPECIFIC to this project's domain and vertical (not generic boilerplate)
- Each span should have 2-4 meaningful attributes
- Mark any PII attributes (email, name, address, card, etc.) in the pii.keys array
- Span names must use snake_case dot notation (e.g., checkout.validate_cart)
- CRITICAL: The "op" field MUST be the first segment of the span name (e.g., name "checkout.validate_cart" → op "checkout"). NEVER use "operation" or any generic placeholder.
- Only return the JSON object`
      }
    ];

    const response = await this.callLLM(messages, settings.llm);

    const parsed = extractJsonObject(response);

    const GENERIC_OPS = new Set(['operation', 'operation_type', 'custom', 'span', 'generic', '']);
    const spans: SpanDefinition[] = (parsed.spans || []).map((s: any) => {
      const name = String(s.name || '');
      const derivedOp = name.split('.')[0] || '';
      const rawOp = String(s.op || '');
      // If LLM returned a generic placeholder, derive op from the span name prefix instead
      const op = GENERIC_OPS.has(rawOp.toLowerCase()) ? derivedOp : rawOp;
      return {
        name,
        op,
        layer: s.layer === 'frontend' ? 'frontend' as const : 'backend' as const,
        description: String(s.description || ''),
        attributes: (s.attributes && typeof s.attributes === 'object')
          ? Object.fromEntries(Object.entries(s.attributes).map(([k, v]) => [k, String(v)]))
          : {},
        pii: { keys: Array.isArray(s.pii?.keys) ? s.pii.keys : [] }
      };
    }).filter((s: SpanDefinition) => s.name.length > 0);

    return {
      message: String(parsed.message || 'I have some custom span suggestions for your project.'),
      spans
    };
  }

  /**
   * Generate dashboard widgets tailored to the project using a constrained vocabulary
   * of valid Sentry query syntax. Throws if fewer than 3 valid widgets are produced
   * so the caller can fall back to the hardcoded template.
   */
  async generateDashboardWidgets(project: EngagementSpec): Promise<any[]> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      throw new Error('LLM not configured');
    }

    // Import widget resolver
    const { resolveWidgetIntents, applyKPILayout, WIDGET_TEMPLATE_BANK } = await import('./widget-resolver');

    const { name, vertical, notes } = project.project;
    const spans = project.instrumentation.spans;

    // ── Phase A: Intent generation (LLM call) ────────────────────────────────
    const spanList = spans.map(s => `- ${s.name} (${s.op}): ${s.description || s.name}`).join('\n');

    const intentPrompt = `You are designing a Sentry dashboard for a demo with a prospect in the ${vertical} industry.

Project: ${name}
Description: ${notes || '(none)'}

Instrumented operations:
${spanList || '(no custom spans defined)'}

Your job is to decide what story this dashboard should tell. Think about:
- What does an engineer at this company care about most when their system is having problems?
- Which of the instrumented operations, if slow or failing, would cause the most customer impact?
- What would make an SE say "this dashboard shows exactly what matters for your business"?

Output a JSON array of widget intents. Each intent is a plain English description of one thing to show.

Format:
[
  { "intent": "<plain English description of what to show>", "priority": "KPI" | "chart" | "detail" },
  ...
]

Rules:
- Exactly 3 items with priority "KPI" — these are the headline numbers
- 2–4 items with priority "chart" — these are trends over time or breakdowns
- 1–2 items with priority "detail" — these are tables or drilldowns
- Every intent must reference a span by its descriptive name, not technical span name
- Do not mention field names, aggregates, SQL, or Sentry-specific vocabulary
- Focus on business meaning: latency, errors, volume, and attribute breakdowns

Return ONLY a valid JSON array, no other text.`;

    let intents: Array<{ intent: string; priority: 'KPI' | 'chart' | 'detail' }> = [];

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await this.callLLM([{ role: 'user', content: intentPrompt }], {
          baseUrl: settings.llm.baseUrl,
          apiKey: settings.llm.apiKey,
          model: settings.llm.model || 'gpt-4-turbo-preview',
          temperature: 0.7,
        });
        const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```[\s\S]*$/, '').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
          intents = parsed.filter((i: any) =>
            typeof i.intent === 'string' &&
            ['KPI', 'chart', 'detail'].includes(i.priority)
          );
          if (intents.length >= 3) break;
        }
      } catch (e) {
        if (attempt === 2) {
          console.warn('[generateDashboardWidgets] Intent generation failed, using template bank');
          return WIDGET_TEMPLATE_BANK;
        }
      }
    }

    if (intents.length === 0) {
      console.warn('[generateDashboardWidgets] No valid intents, using template bank');
      return WIDGET_TEMPLATE_BANK;
    }

    // ── Phase B: Resolution (deterministic) ──────────────────────────────────
    const plan = {
      transactions: project.instrumentation.transactions,
      spans: spans.map(s => ({
        name: s.name,
        op: s.op,
        layer: s.layer,
        description: s.description,
        attributes: s.attributes,
      }))
    };

    const { widgets, failures } = resolveWidgetIntents(intents, plan);

    if (failures.length > 0) {
      console.log(`[generateDashboardWidgets] ${failures.length} resolution failure(s):`, failures.map(f => f.reason).join(', '));
    }

    // ── Phase C: Enforcement gate ─────────────────────────────────────────────
    // Ensure we have enough widgets — fill from template bank if needed
    let finalWidgets = [...widgets];
    if (finalWidgets.length < 6) {
      const needed = 6 - finalWidgets.length;
      const templateFill = WIDGET_TEMPLATE_BANK.slice(finalWidgets.length, finalWidgets.length + needed);
      finalWidgets = [...finalWidgets, ...templateFill];
    }

    // Apply KPI layout enforcement (first 3 are big_number at y=0)
    finalWidgets = applyKPILayout(finalWidgets);

    // Run existing post-processing sanitisation as final safety net
    const VALID_SPAN_FIELDS = new Set([
      'span.description', 'span.op', 'span.duration', 'span.status',
      'transaction', 'project', 'timestamp', 'id', 'trace',
    ]);
    const VALID_DISPLAY_TYPES = new Set(['big_number', 'area', 'line', 'table', 'bar']);
    const VALID_WIDGET_TYPES  = new Set(['spans', 'error-events']);
    const VALID_AGGREGATE_RE  = /^(count|p\d+|avg|sum|count_unique|failure_rate)\([\w.]*\)$|^(count|failure_rate)\(\)$/;

    const sanitizeWidget = (w: any): any => {
      if (!w || typeof w !== 'object') return w;
      const out = { ...w };
      const isBigNumber = out.displayType === 'big_number';
      if (Array.isArray(out.queries)) {
        out.queries = out.queries.map((q: any) => {
          if (!q || typeof q !== 'object') return q;
          const sq = { ...q };
          if (typeof sq.conditions === 'string') {
            sq.conditions = sq.conditions
              .replace(/\s+and\s+/gi, ' ')
              .replace(/\s+or\s+/gi, ' ')
              .trim();
          }
          if (isBigNumber) {
            sq.columns = [];
            sq.fields = Array.isArray(sq.aggregates) ? [...sq.aggregates] : sq.fields;
            sq.orderby = '';
          } else {
            if (Array.isArray(sq.fields)) {
              sq.fields = sq.fields.filter((f: string) =>
                VALID_SPAN_FIELDS.has(f) || VALID_AGGREGATE_RE.test(f)
              );
              if (!sq.fields.some((f: string) => VALID_SPAN_FIELDS.has(f))) {
                sq.fields = ['span.description', ...sq.fields];
              }
            }
          }
          return sq;
        });
      }
      return out;
    };

    const isValidWidget = (w: any): boolean => {
      if (!w || typeof w !== 'object') return false;
      if (!w.title || !w.displayType || !w.widgetType) return false;
      if (!Array.isArray(w.queries) || w.queries.length === 0) return false;
      if (!w.layout || typeof w.layout !== 'object') return false;
      if (!VALID_DISPLAY_TYPES.has(w.displayType)) return false;
      if (!VALID_WIDGET_TYPES.has(w.widgetType)) return false;
      for (const q of w.queries) {
        if (!Array.isArray(q.aggregates) || q.aggregates.length === 0) return false;
        if (!q.aggregates.every((a: string) => VALID_AGGREGATE_RE.test(a))) return false;
      }
      const { x, y, w: width, h } = w.layout;
      if ([x, y, width, h].some(v => typeof v !== 'number')) return false;
      if (x + width > 6 || h < 1) return false;
      return true;
    };

    const valid = finalWidgets.map(sanitizeWidget).filter(isValidWidget);
    const dropped = finalWidgets.length - valid.length;
    if (dropped > 0) {
      console.warn(`  ⚠️  Dropped ${dropped} invalid widget(s) from dashboard`);
    }

    if (valid.length < 3) {
      throw new Error(`Only ${valid.length} valid widget(s) generated — falling back to template`);
    }

    console.log(`✅ Generated ${valid.length} valid dashboard widgets (intent→resolve→enforce pipeline)`);
    return valid;
  }

  /**
   * Generate realistic mock response bodies for template-generated route stubs.
   * This is the only LLM task for backend routes — structure is always from the template.
   * Small, focused prompt that any model can handle reliably.
   */
  async generateRouteStubs(
    project: EngagementSpec
  ): Promise<Array<{ spanName: string; mockResponse: Record<string, any> }>> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) return [];

    const spans = project.instrumentation.spans;
    if (spans.length === 0) return [];

    const spanList = spans.map(s => `- ${s.name} (op: ${s.op}): ${s.description || s.name}`).join('\n');

    const prompt = `You are generating mock API response data for a ${project.project.vertical} application called "${project.project.name}".

For each API endpoint below, return a realistic JSON mock response object that matches the domain.
Keep responses small (2-5 fields). Use realistic field names and values for ${project.project.vertical}.

ENDPOINTS:
${spanList}

Return ONLY a JSON array, no explanation:
[
  { "spanName": "product.list_fetch", "mockResponse": { "products": [...], "total": 10 } },
  ...
]`;

    try {
      const raw = await this.callLLM([{ role: 'user', content: prompt }], {
        ...settings.llm,
        temperature: 0.4,
        timeoutMs: 60_000,
      });
      const json = this.extractJsonFromResponse(raw);
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((r: any) =>
        typeof r.spanName === 'string' && r.mockResponse && typeof r.mockResponse === 'object'
      );
    } catch {
      return [];
    }
  }

  /**
   * Generate intelligent user flows for Puppeteer, with code-grounded prompting
   * and a reflection loop to catch coverage gaps.
   */
  async generateUserFlows(
    project: EngagementSpec,
    backendRoutesCode: string,
    frontendPages: string[],
    widgetFilters: Array<{ spanName: string; conditions: string }>,
    runId: string,
    coverageGapHint?: string,
    domManifest?: { pages: Array<{ pageFile: string; selectors: Array<{ testId: string; elementType: string; inferredAction: string }>; apiEndpoints: Array<{ method: string; path: string }> }> }
  ): Promise<any[]> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      throw new Error('LLM settings not configured');
    }

    const spans = project.instrumentation.spans;
    const isBackendOnly = project.stack.type === 'backend-only';

    // Derive HTTP method and endpoint for each span (must match generator.ts logic)
    const READ_KEYWORDS = ['fetch', 'load', 'get', 'list', 'read', 'query', 'search', 'filter', 'view', 'show', 'detail'];
    const spanMethod = (name: string) =>
      READ_KEYWORDS.some(k => name.toLowerCase().includes(k)) ? 'GET' : 'POST';
    const deriveRoute = (spanName: string): string => {
      const parts = spanName.split('.');
      if (parts.length === 1) return `/${parts[0].replace(/_/g, '-')}`;
      return `/${parts[0]}/${parts.slice(1).join('/').replace(/_/g, '-')}`;
    };

    // Build span endpoint map with widget seed values
    const spanEndpoints = spans.map(s => {
      const method = spanMethod(s.name);
      const endpoint = `/api${deriveRoute(s.name)}`;
      const widgetConditions = widgetFilters.find(f => f.spanName === s.name)?.conditions || '';

      // Parse attribute seed values from widget filter conditions
      const seedValues: Record<string, string> = {};
      if (widgetConditions) {
        const matches = widgetConditions.matchAll(/([a-z_][a-z0-9_.]*):([^\s"]+)/gi);
        for (const m of matches) {
          if (!m[1].startsWith('span.') && m[1] !== 'is_transaction' && !m[1].startsWith('has')) {
            seedValues[m[1]] = m[2];
          }
        }
      }

      return { ...s, method, endpoint, seedValues };
    });

    const frontendBase = `http://localhost:${isBackendOnly ? 3001 : 3000}`;
    const apiBase = 'http://localhost:3001';

    const spanDescriptions = spanEndpoints.map(se =>
      `- ${se.name} (${se.layer}, op: ${se.op})
  Description: ${se.description || 'no description'}
  Endpoint: ${se.method} ${apiBase}${se.endpoint}
  Body attributes: ${Object.keys(se.attributes).join(', ') || '(none)'}
  Widget seed values: ${Object.keys(se.seedValues).length > 0 ? JSON.stringify(se.seedValues) : '(none)'}`
    ).join('\n');

    const puppeteerRules = this.rulesBank?.getRulesForPrompt('flows') || '';
    const coverageGapSection = coverageGapHint ? `\nCOVERAGE GAP (re-reason required):\n${coverageGapHint}\n` : '';
    const prompt = `You are a Puppeteer automation expert generating user flows to trigger Sentry custom spans.
${puppeteerRules}${coverageGapSection}
PROJECT: ${project.project.name} (${project.project.vertical})
STACK: ${project.stack.type}
BASE URL: ${frontendBase}
API BASE: ${apiBase}
RUN ID: ${runId}

ENGAGEMENT SPEC SPANS — you MUST trigger EVERY one:
${spanDescriptions}

FRONTEND PAGES (for navigate steps):
${frontendPages.length > 0 ? frontendPages.join(', ') : '/'}

BACKEND ROUTES (actual generated code — use EXACT paths from this):
\`\`\`
${backendRoutesCode.substring(0, 2500)}
\`\`\`

DOM MANIFEST (real selectors from generated pages — use data-testid selectors for click/type steps):
${domManifest && domManifest.pages.length > 0
  ? domManifest.pages.map(p => {
      const name = p.pageFile.split('/').pop() ?? p.pageFile;
      const selectors = p.selectors.map(s => `  [${s.inferredAction}] data-testid="${s.testId}" (${s.elementType})`).join('\n');
      return `Page: ${name}\n${selectors || '  (no selectors found)'}`;
    }).join('\n\n')
  : '(no DOM manifest available — use generic selectors)'}

FLOW STEP TYPES:
  navigate: { "action": "navigate", "url": "/path" }
  api_call: { "action": "api_call", "url": "http://localhost:3001/api/...", "method": "GET"|"POST", "body": {...} }
  click:    { "action": "click", "selector": "[data-testid='submit-button']" }
  type:     { "action": "type", "selector": "[data-testid='email-input']", "value": "test@example.com" }
  wait:     { "action": "wait", "duration": 1500 }
  scroll:   { "action": "scroll" }

RULES:
1. Generate ONE flow per engagement spec span
2. EVERY backend span MUST have an api_call step hitting its EXACT endpoint
3. api_call bodies MUST include: "se_copilot_run_id": "${runId}"
4. api_call bodies MUST include all span attribute keys with realistic test values
5. Use widget seed values from the span description above when provided
6. For frontend spans: navigate to the correct page + interaction steps (scroll, click, wait)
7. Always start each flow with a navigate step (ensures browser context + Sentry is initialized)
8. api_call fires fetch() from browser context — Sentry automatically adds distributed trace headers
9. Use EXACT HTTP method and path from the backend routes code above — do not invent paths
10. One span per flow (focused flows reduce overlap noise in Sentry)
11. For click/type steps: use data-testid selectors from the DOM manifest above when available (e.g. "[data-testid='submit-payment-button']")
12. If no DOM manifest selector matches, use semantic selectors like "button[type=submit]" or "input[type=email]"

EXAMPLE flow (adapt names and paths to this project):
{
  "name": "Checkout Validate Cart",
  "description": "Triggers checkout.validate_cart backend span",
  "steps": [
    { "action": "navigate", "url": "/" },
    { "action": "wait", "duration": 500 },
    { "action": "api_call", "url": "http://localhost:3001/api/checkout/validate-cart", "method": "POST", "body": { "cart_id": "test-cart-001", "user_id": "test-user-001", "se_copilot_run_id": "${runId}" } },
    { "action": "wait", "duration": 1000 }
  ]
}

Return ONLY a valid JSON array of flows. No markdown fences, no explanation.`;

    // Round 1: generate all flows
    const raw = await this.callLLM([{ role: 'user', content: prompt }], settings.llm);
    let flows: any[];

    try {
      const jsonStr = this.extractJsonFromResponse(raw);
      flows = JSON.parse(jsonStr);
      if (!Array.isArray(flows)) throw new Error('Response is not a JSON array');
    } catch (err) {
      throw new Error(`LLM flow generation failed to parse: ${err}`);
    }

    // Round 2 (reflection): deterministic coverage check — which backend spans have no api_call?
    const backendSpans = spans.filter(s => s.layer === 'backend');
    const coveredEndpoints = new Set<string>();

    for (const flow of flows) {
      for (const step of (flow.steps || [])) {
        if (step.action === 'api_call' && typeof step.url === 'string') {
          // Normalize for comparison
          coveredEndpoints.add(step.url.toLowerCase().replace(/-/g, '').replace(/\//g, ''));
        }
      }
    }

    const uncoveredBackendSpans = backendSpans.filter(s => {
      const expectedEndpointNorm = `${apiBase}${spanEndpoints.find(se => se.name === s.name)?.endpoint || ''}`.toLowerCase().replace(/-/g, '').replace(/\//g, '');
      return ![...coveredEndpoints].some(ep => ep.includes(expectedEndpointNorm.replace('http:', '').replace('localhost3001', '')));
    });

    if (uncoveredBackendSpans.length > 0) {
      console.log(`[generateUserFlows] Reflection: ${uncoveredBackendSpans.length} backend spans uncovered, filling gaps`);

      const gapDescriptions = uncoveredBackendSpans.map(s => {
        const se = spanEndpoints.find(x => x.name === s.name)!;
        return `- ${s.name}: ${se.method} ${apiBase}${se.endpoint} — body attrs: ${Object.keys(s.attributes).join(', ')}`;
      }).join('\n');

      const gapPrompt = `Generate Puppeteer user flows for ONLY these backend spans that were missed:

${gapDescriptions}

RULES:
- Each api_call body MUST include "se_copilot_run_id": "${runId}"
- Always start with a navigate step to "/"
- Use EXACT method and path listed above
- One flow per span

Return ONLY a valid JSON array of flows. No markdown.`;

      try {
        const gapRaw = await this.callLLM([{ role: 'user', content: gapPrompt }], settings.llm);
        const gapJsonStr = this.extractJsonFromResponse(gapRaw);
        const gapFlows = JSON.parse(gapJsonStr);
        if (Array.isArray(gapFlows)) {
          flows.push(...gapFlows);
          console.log(`[generateUserFlows] Added ${gapFlows.length} gap-filling flows`);
        }
      } catch (err) {
        console.warn('[generateUserFlows] Gap fill failed (non-fatal):', err);
      }
    }

    console.log(`✅ generateUserFlows: ${flows.length} total flows generated`);
    return flows;
  }

  /**
   * Agent 1: Route Coherence Validator.
   * For every api_call step, verify url maps to a registered backend route and that
   * description (when set) matches the url. Returns corrected flows.
   */
  async validateFlowRouteCoherence(flows: any[], backendRoutesCode: string): Promise<any[]> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) return flows;

    const prompt = `You are a route coherence validator for Puppeteer test flows.

TASK: For every api_call step in the flows below:
1. Verify the "url" field maps to an actual route registered in the backend code.
2. If "description" is set, verify it accurately describes the url endpoint — fix if mismatched.
3. Fix any url that does not match a real registered route (use the closest matching route).
4. Do NOT add or remove flows. Do NOT change non-api_call steps.

BACKEND ROUTES:
\`\`\`
${backendRoutesCode.substring(0, 3000)}
\`\`\`

FLOWS (JSON):
${JSON.stringify(flows, null, 2).substring(0, 4000)}

Return ONLY the corrected flows as a valid JSON array. No markdown, no explanation.`;

    try {
      const raw = await this.callLLM([{ role: 'user', content: prompt }], settings.llm);
      const corrected = JSON.parse(this.extractJsonFromResponse(raw));
      if (Array.isArray(corrected)) return corrected;
    } catch (err) {
      console.warn('[validateFlowRouteCoherence] Failed (non-fatal):', err);
    }
    return flows;
  }

  /**
   * Agent 2: Duplicate Span Eliminator.
   * Identifies api_call steps that duplicate what the page already fetches natively.
   * Returns deduplicated flows.
   */
  async eliminateDuplicateSpanFlows(flows: any[], frontendPages: string[]): Promise<any[]> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) return flows;

    const prompt = `You are a span deduplication expert for Puppeteer test flows.

TASK: Identify api_call steps that are redundant because the page already triggers those
backend calls naturally during render (navigate → page loads → page fetches data).
Remove such redundant api_call steps. Keep api_call steps that trigger operations
not naturally triggered by page navigation (e.g. form submissions, mutations).
Do NOT add or remove flows. Do NOT change navigate/wait/scroll/click steps.

FRONTEND PAGES (routes that exist):
${frontendPages.join(', ') || '/'}

FLOWS (JSON):
${JSON.stringify(flows, null, 2).substring(0, 4000)}

Return ONLY the deduplicated flows as a valid JSON array. No markdown, no explanation.`;

    try {
      const raw = await this.callLLM([{ role: 'user', content: prompt }], settings.llm);
      const deduped = JSON.parse(this.extractJsonFromResponse(raw));
      if (Array.isArray(deduped)) return deduped;
    } catch (err) {
      console.warn('[eliminateDuplicateSpanFlows] Failed (non-fatal):', err);
    }
    return flows;
  }

  /**
   * Agent 3: Span Topology Validator.
   * Verifies every spec span is exercised by exactly one flow and each flow
   * navigates to the correct frontend page for that span's context.
   */
  async validateFlowSpanTopology(flows: any[], project: EngagementSpec): Promise<any[]> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) return flows;

    const spanList = project.instrumentation.spans.map(s =>
      `- ${s.name} (${s.layer}, op: ${s.op})`
    ).join('\n');

    const prompt = `You are a span topology validator for Puppeteer test flows.

TASK:
1. Verify every spec span below is exercised by at least one flow.
2. Verify each flow's navigate step goes to the correct frontend page for that span's domain
   (e.g. products.* spans → /products, checkout.* spans → /checkout, auth.* → /login).
3. Fix navigate urls that point to wrong pages for the span being tested.
4. Do NOT add or remove flows. Do NOT change api_call steps or wait/scroll/click steps.

ENGAGEMENT SPEC SPANS:
${spanList}

FLOWS (JSON):
${JSON.stringify(flows, null, 2).substring(0, 4000)}

Return ONLY the topology-corrected flows as a valid JSON array. No markdown, no explanation.`;

    try {
      const raw = await this.callLLM([{ role: 'user', content: prompt }], settings.llm);
      const corrected = JSON.parse(this.extractJsonFromResponse(raw));
      if (Array.isArray(corrected)) return corrected;
    } catch (err) {
      console.warn('[validateFlowSpanTopology] Failed (non-fatal):', err);
    }
    return flows;
  }

  /**
   * Agent 4: Widget Data Coverage Validator.
   * Ensures every dashboard widget filter condition is satisfiable by the generated flows.
   * Replaces has:error with success:false, removes filters on attributes not generated by any flow.
   * Returns corrected flows (adds attribute values to api_call bodies where needed).
   */
  async validateWidgetDataCoverage(flows: any[], project: EngagementSpec): Promise<any[]> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) return flows;

    const widgets: any[] = (project as any).dashboard?.widgets || [];
    if (widgets.length === 0) return flows;

    // Build widget filter summary
    const widgetConditions = widgets
      .flatMap((w: any) => (w.queries || []).map((q: any) => q.conditions || ''))
      .filter(Boolean)
      .join('\n');

    // Build known attributes from spec
    const knownAttributes = project.instrumentation.spans
      .map(s => `${s.name}: [${Object.keys(s.attributes).join(', ')}]`)
      .join('\n');

    const prompt = `You are a dashboard data coverage validator for Puppeteer test flows.

TASK: Ensure every flow generates data that satisfies the dashboard widget filter conditions below.
1. For each widget condition that references a custom attribute (e.g. success:false, payment_method:stripe),
   find the flow whose api_call step should produce that attribute.
2. If an api_call body is missing a required attribute, add it with a realistic value.
3. Replace any remaining has:error conditions with success:false in your mental model — the flows
   should send "success: false" in api_call bodies for error scenario flows.
4. Do NOT add or remove flows. Do NOT change navigate/wait/scroll steps.
5. ONLY add attributes that are listed in KNOWN SPAN ATTRIBUTES below — never invent new attributes.

DASHBOARD WIDGET CONDITIONS:
${widgetConditions.substring(0, 1500)}

KNOWN SPAN ATTRIBUTES:
${knownAttributes}

FLOWS (JSON):
${JSON.stringify(flows, null, 2).substring(0, 4000)}

Return ONLY the corrected flows as a valid JSON array. No markdown, no explanation.`;

    try {
      const raw = await this.callLLM([{ role: 'user', content: prompt }], settings.llm);
      const corrected = JSON.parse(this.extractJsonFromResponse(raw));
      if (Array.isArray(corrected)) return corrected;
    } catch (err) {
      console.warn('[validateWidgetDataCoverage] Failed (non-fatal):', err);
    }
    return flows;
  }

  /**
   * Analyzes actual trace failures and generates specific, actionable rules using the LLM.
   * These rules have unique titles derived from what the LLM actually observes in the span data,
   * so they accumulate in the rules bank rather than deduplicating against generic templates.
   */
  async generateTrainingRules(
    specName: string,
    specVertical: string,
    failingSummary: string,
    spanSamples: Array<{ op: string; description: string; data?: Record<string, any>; status?: string }>
  ): Promise<Array<{ category: string; title: string; rule: string; applyTo: string[] }>> {
    const settings = this.storage.getSettings();
    if (!settings.llm.apiKey || !settings.llm.baseUrl) return [];

    const spanLines = spanSamples.slice(0, 12).map(s =>
      `  op=${s.op} desc="${s.description}" status=${s.status || 'ok'} data=${JSON.stringify(s.data || {}).slice(0, 120)}`
    ).join('\n');

    const prompt = `You are a Sentry instrumentation expert analyzing trace quality failures from automated training.

SPEC: ${specName} (${specVertical} vertical)

FAILING CRITERIA:
${failingSummary}

SAMPLE SPANS FROM ACTUAL TRACES:
${spanLines || '  (no spans captured)'}

Generate 2–4 SPECIFIC, ACTIONABLE instrumentation rules that explain EXACTLY what code pattern in the generated app is causing these failures and how to fix it.

Rules must be:
- Specific to what you can see in the span data above (not generic principles)
- Actionable (include exact code patterns, method names, or attribute names)
- Different from these already-covered basics: "use continueTrace", "don't add api_call after networkidle2", "use METHOD /route format", "set http.status_code"

Return ONLY a JSON array (no markdown, no explanation):
[
  {
    "category": "orphan_spans|fe_be_connection|custom_spans|widget_data|span_gaps|span_timing|span_naming|attribute_completeness|transaction_completeness|general",
    "title": "Short specific title (max 80 chars) — must be unique and specific to this failure",
    "rule": "Detailed actionable rule with exact code patterns or attribute names",
    "applyTo": ["generation"|"flows"|"dashboard"|"instrumentation"]
  }
]`;

    try {
      const raw = await this.callLLM(
        [{ role: 'user', content: prompt }],
        { ...settings.llm, temperature: 0.4 } as any
      );
      const json = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const start = json.indexOf('[');
      const end = json.lastIndexOf(']');
      if (start === -1 || end === -1) return [];
      const parsed = JSON.parse(json.slice(start, end + 1));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((r: any) =>
        typeof r.category === 'string' &&
        typeof r.title === 'string' && r.title.length > 5 &&
        typeof r.rule === 'string' && r.rule.length > 20 &&
        Array.isArray(r.applyTo)
      );
    } catch {
      return [];
    }
  }

  /**
   * Public wrapper around callLLM for use by other services (e.g. GeneratorService
   * fix-validate loop) that need direct LLM access without going through a
   * project-specific flow.
   */
  async callLLMDirect(
    messages: ChatMessage[],
    config: { baseUrl?: string; apiKey?: string; model?: string; temperature?: number; timeoutMs?: number; context?: string; promptId?: string }
  ): Promise<string> {
    // Validate prompt integrity before sending to LLM
    if (config.promptId) {
      const userContent = messages.find(m => m.role === 'user')?.content ?? '';
      validatePrompt(config.promptId, userContent);
    }

    let effectiveMessages = messages;

    // Inject rules bank for the given context
    if (this.rulesBank && config.context) {
      const applyTo = config.context === 'repair' ? 'instrumentation'
        : config.context === 'generation' ? 'generation'
        : config.context === 'validation' ? 'instrumentation'
        : 'general' as any;
      const rules = this.rulesBank.getRulesForPrompt(applyTo);
      if (rules && messages.length > 0) {
        const lastUserMsg = messages[messages.length - 1];
        if (lastUserMsg.role === 'user') {
          effectiveMessages = [
            ...messages.slice(0, -1),
            { role: 'user' as const, content: `${rules}\n\n---\n\n${lastUserMsg.content}` }
          ];
        }
      }
    }

    return this.callLLM(effectiveMessages, { temperature: 0.2, ...config });
  }

  private async callLLM(
    messages: ChatMessage[],
    config: { baseUrl?: string; apiKey?: string; model?: string; temperature?: number; timeoutMs?: number }
  ): Promise<string> {
    const isLocal = config.baseUrl?.includes('localhost') || config.baseUrl?.includes('127.0.0.1');
    const defaultTimeout = isLocal ? 600_000 : 120_000;
    const { baseUrl, apiKey, model = 'gpt-4-turbo-preview', temperature = 0.7, timeoutMs = defaultTimeout } = config;

    const bodyObj = {
      model,
      messages,
      temperature,
      max_tokens: 4000,
      // Always stream for local models — mlx_lm.server holds the socket silent until
      // the full response is ready in non-streaming mode, which triggers the inactivity
      // timeout even for fast models. Streaming sends a token at a time so the socket
      // stays alive throughout generation regardless of how long it takes.
      ...(isLocal ? { stream: true } : {})
    };
    const bodyStr = JSON.stringify(bodyObj);

    // Local models (MLX etc.) take minutes to process the prompt before sending
    // the first response byte. Node's global fetch uses undici which has a 30s
    // headersTimeout that fires before AbortController. Use http.request for
    // local calls to avoid this entirely.
    // Also serialize: MLX handles one request at a time. Concurrent calls cause
    // the second socket to sit idle until the first finishes, triggering timeout.
    if (isLocal) {
      this.localQueueDepth++;
      console.log(`[callLLM] queuing local request (queue depth: ${this.localQueueDepth})`);
      const result = this.localQueue.then(async () => {
        console.log(`[callLLM] starting local request (queue depth: ${this.localQueueDepth})`);
        try {
          return await this.callLLMHttp(baseUrl!, apiKey!, bodyStr, bodyObj.stream ?? false, timeoutMs);
        } finally {
          this.localQueueDepth--;
          console.log(`[callLLM] finished local request (queue depth: ${this.localQueueDepth})`);
        }
      });
      this.localQueue = result.catch(() => {});
      return result;
    }

    // Cloud path — normal fetch
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: bodyStr
      });
    } catch (err: any) {
      clearTimeout(timer);
      const cause = err?.cause ? ` (cause: ${err.cause?.code || err.cause?.message || err.cause})` : '';
      console.error(`[callLLM] fetch failed — url: ${baseUrl}/chat/completions, model: ${model}${cause}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`LLM API error: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  private callLLMHttp(
    baseUrl: string,
    apiKey: string,
    bodyStr: string,
    streaming: boolean,
    timeoutMs: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}/chat/completions`);
      const req = http.request({
        hostname: url.hostname,
        port: Number(url.port) || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(bodyStr)
        },
        timeout: timeoutMs
      }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = '';
          res.on('data', (c: Buffer) => errBody += c.toString());
          res.on('end', () => reject(new Error(`LLM API error: ${res.statusCode} ${errBody}`)));
          return;
        }

        if (!streaming) {
          let body = '';
          res.on('data', (c: Buffer) => body += c.toString());
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              resolve(data.choices[0]?.message?.content || '');
            } catch (e) {
              reject(new Error(`Failed to parse LLM response: ${body.slice(0, 200)}`));
            }
          });
          return;
        }

        // SSE streaming
        let fullContent = '';
        let tokenCount = 0;
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                fullContent += delta;
                tokenCount++;
                if (tokenCount % 20 === 0) {
                  this.streamProgressCallback?.(tokenCount, `Generating… (${tokenCount} tokens)`);
                }
              }
            } catch { /* ignore malformed SSE lines */ }
          }
        });
        res.on('end', () => resolve(fullContent));
      });

      req.on('timeout', () => {
        console.error(`[callLLM] socket inactivity timeout after ${timeoutMs}ms — url: ${baseUrl}/chat/completions (streaming=${streaming})`);
        req.destroy(new Error('LLM request timed out'));
      });
      req.on('error', (err) => {
        console.error(`[callLLM] http request failed — url: ${baseUrl}/chat/completions`);
        reject(err);
      });
      req.on('socket', (socket) => {
        console.log(`[callLLM] socket assigned — streaming=${streaming}, timeoutMs=${timeoutMs}`);
        socket.on('connect', () => console.log('[callLLM] socket connected'));
        socket.on('close', (hadError) => console.log(`[callLLM] socket closed (hadError=${hadError})`));
      });
      req.write(bodyStr);
      req.end();
    });
  }
}
