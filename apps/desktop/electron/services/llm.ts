import { StorageService } from './storage';
import { EngagementSpec, SpanDefinition } from '../../src/types/spec';
import { RulesBankService } from './rules-bank';
import * as http from 'http';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
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
      return {
        transactions: parsed.transactions || [],
        spans: normalizedSpans
      };
    } catch (error) {
      console.error('Failed to parse LLM response:', error);
      console.error('Response was:', response.substring(0, 500)); // Log first 500 chars
      throw new Error('LLM returned invalid JSON. Please try again.');
    }
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
  async generateWebPages(project: EngagementSpec): Promise<{
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

    // Derive API endpoints using /${namespace}/${action} pattern — must match backend route generation
    const deriveApiEndpoint = (spanName: string): string => {
      const parts = spanName.split('.');
      if (parts.length === 1) return `/${parts[0].replace(/_/g, '-')}`;
      const namespace = parts[0];
      const action = parts.slice(1).join('/').replace(/_/g, '-');
      return `/${namespace}/${action}`;
    };

    // Assign HTTP method per span — must match the backend route generation logic exactly.
    const FE_READ_KEYWORDS = ['fetch', 'load', 'get', 'list', 'read', 'query', 'search', 'filter', 'view', 'show', 'detail'];
    const feSpanMethod = (spanName: string): string =>
      FE_READ_KEYWORDS.some(k => spanName.toLowerCase().includes(k)) ? 'GET' : 'POST';

    // Build the API endpoint contract so frontend and backend agree on ALL spans
    const apiEndpoints = allSpansList.map(s =>
      `- trace_${s.name.replace(/\./g, '_')} → ${feSpanMethod(s.name)} /api${deriveApiEndpoint(s.name)}`
    ).join('\n');

    const exampleEndpoint = firstSpan ? deriveApiEndpoint(firstSpan.name).slice(1) : 'signup/submit';
    const generationRules = this.rulesBank?.getRulesForPrompt('generation') || '';
    const instrumentationRules = this.rulesBank?.getRulesForPrompt('instrumentation') || '';
    const allFrontendRules = [generationRules, instrumentationRules].filter(Boolean).join('\n');

    const prompt = `You are an expert Next.js developer with deep knowledge of Sentry instrumentation. Generate a complete, production-ready web application based on these requirements:
${allFrontendRules}

**PROJECT DETAILS:**
- Name: ${project.project.name}
- Vertical: ${project.project.vertical}
- Customer Requirements: ${project.project.notes || 'Build a functional demo application'}

**SENTRY FRONTEND INSTRUMENTATION REQUIREMENTS (MUST IMPLEMENT ALL):**
${instrumentationDetails}

**BACKEND API ENDPOINT CONTRACT (use EXACTLY these URLs for all fetch calls):**
${apiEndpoints || '- No frontend spans defined — derive endpoints from project requirements'}
The backend runs at http://localhost:3001. All calls go to http://localhost:3001/api/...
Match the endpoint path exactly as listed above for each span.

**CRITICAL REQUIREMENTS:**
1. You MUST implement EVERY span listed above using the exact span names and operations
2. Import instrumentation functions from '@/lib/instrumentation'
3. Use the pattern: \`import { trace_span_name } from '@/lib/instrumentation'\`
4. Actually CALL these functions in the appropriate places in the UI
5. Set all required attributes listed for each span
6. Use the EXACT API endpoints from the contract above — do NOT invent different route paths
7. CRITICAL — Trace function signature: ALWAYS call as \`await traceFunc(async () => { /* work */ }, { attr: value })\`. The FIRST argument MUST be an async callback function — NEVER a string, field name, or any other type. Example WRONG: \`trace_input_focus('email', ...)\`. Example CORRECT: \`await trace_input_focus(async () => {}, { field_name: 'email' })\`
8. NEVER wrap fetch() in \`Sentry.startSpan({ op: 'http.client', ... })\`. The Sentry SDK automatically instruments every fetch() call as an http.client span — adding a manual wrapper creates TWO http.client spans for the same request. Instead, wrap fetch() inside your CUSTOM instrumentation span (e.g. \`await trace_product_search(async () => { const r = await fetch(...); }, {...})\`) which gives you the correct hierarchy: custom span → auto-instrumented http.client child.
9. Use the correct HTTP method from the endpoint contract: GET endpoints use \`fetch(url)\` (no method needed), POST endpoints use \`fetch(url, { method: 'POST', ... })\`

**IMPORTANT — BUILD FOR THIS SPECIFIC PROJECT:**
- Base all pages, routes, and data models on the project name, requirements, and custom spans above
- DO NOT default to a generic e-commerce layout (products/cart/checkout) unless the project is explicitly an e-commerce store
- The page structure, data displayed, and user interactions must reflect what "${project.project.name}" actually does
- Let the custom spans above guide what pages and actions to build

**TASK:** Generate 3-5 Next.js pages (App Router) that implement the functionality described in the customer requirements.

**PAGE REQUIREMENTS:**
1. Each page must be fully functional with:
   - 'use client' directive at the top
   - State management (useState, useEffect)
   - API calls to backend using EXACTLY the URLs from the endpoint contract above
   - Sentry instrumentation using the EXACT spans listed above
   - Tailwind CSS styling
   - Loading states, error handling, empty states
   - Interactive elements (buttons, forms, cards)
2. Use emojis for placeholder images/icons
3. Implement the EXACT spans listed above — import them from @/lib/instrumentation
4. Use Next.js App Router conventions:
   - Home/main page: filename must be "page.tsx" (placed at the root of the app directory)
   - Sub-pages: use SUBDIRECTORY format — e.g. "signup/page.tsx", "confirm/page.tsx", "checkout/page.tsx"
   - NEVER use the ".page.tsx" suffix pattern (e.g. "signup.page.tsx" is WRONG)
5. CRITICAL — 'use client' is mandatory: every page uses hooks (useState, useEffect, etc.) so EVERY page MUST start with 'use client'; as its very first line — no exceptions
6. NEVER import Html, Head, Main, or NextScript from 'next/document' — these are Pages Router only
7. NEVER import from 'next/router' — always use 'next/navigation'
8. If you use useSearchParams(), you MUST wrap the component export in a React.Suspense boundary

**CODE STRUCTURE PATTERN (adapt naming to this project — do not copy these names literally):**
\`\`\`typescript
'use client';
import React, { useEffect, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import { ${exampleSpanFn} } from '@/lib/instrumentation';

export default function ExamplePage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      await ${exampleSpanFn}(async () => {
        const response = await fetch('http://localhost:3001/api/${exampleEndpoint}');
        const data = await response.json();
        setItems(data);
      }, { ${exampleAttrKey}: 0 });
    } catch (error) {
      Sentry.captureException(error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="flex justify-center items-center min-h-screen"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500"></div></div>;

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-4xl font-bold mb-8">{/* page title based on project */}</h1>
      {/* page content based on project domain */}
    </div>
  );
}
\`\`\`

Return ONLY valid JSON in this exact format (no markdown). The "code" field must contain the FULL, COMPLETE TypeScript source code of the page — not a placeholder, not a comment, not a summary:
{
  "pages": [
    {
      "name": "HomePage",
      "filename": "page.tsx",
      "code": "'use client';\\nimport React from 'react';\\n\\nexport default function HomePage() {\\n  return <div>Hello</div>;\\n}",
      "description": "Main home/dashboard page"
    }
  ]
}

CRITICAL: Every "code" value must be a complete, runnable Next.js page component. Do NOT write placeholders like "// complete page code here" or "// rest of code". Write the actual full code.

CRITICAL SYNTAX RULE — trace_* calls take TWO arguments and MUST end with ");" not "};"
WRONG:  await trace_foo(async () => { ... }, { key: val };
RIGHT:  await trace_foo(async () => { ... }, { key: val });
The outer function call needs its own closing ")" before the semicolon. Double-check every trace_* call.`;

    const messages: ChatMessage[] = [
      { role: 'user', content: prompt }
    ];

    const response = await this.callLLM(messages, settings.llm);

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
  async generateExpressRoutes(project: EngagementSpec): Promise<{ code: string }> {
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

    // Derive API endpoints using /${namespace}/${action} pattern — must match frontend page generation
    const deriveRouteEndpoint = (spanName: string): string => {
      const parts = spanName.split('.');
      if (parts.length === 1) return `/${parts[0].replace(/_/g, '-')}`;
      const namespace = parts[0];
      const action = parts.slice(1).join('/').replace(/_/g, '-');
      return `/${namespace}/${action}`;
    };

    // Assign HTTP method per span: GET for reads, POST for writes.
    // "Read" keywords match the action part of span names (e.g. product.fetch_details → fetch → GET).
    const READ_KEYWORDS = ['fetch', 'load', 'get', 'list', 'read', 'query', 'search', 'filter', 'view', 'show', 'detail'];
    const spanMethod = (spanName: string): string =>
      READ_KEYWORDS.some(k => spanName.toLowerCase().includes(k)) ? 'GET' : 'POST';

    // Build explicit route contract from ALL spans (frontend pages call all of them).
    // Each span MUST have a UNIQUE method+path — never collapse multiple spans onto one route.
    const allSpansForRoutes = project.instrumentation.spans;
    const requiredRoutes = allSpansForRoutes.map(s => {
      const route = deriveRouteEndpoint(s.name);
      const fn = `trace_${s.name.replace(/\./g, '_')}`;
      return `- ${spanMethod(s.name)} /api${route}  → call ${fn}`;
    }).join('\n');

    const firstAnySpan = allSpansForRoutes[0];
    const firstBackendSpan = backendSpanList[0];
    const exampleRoute = firstAnySpan ? deriveRouteEndpoint(firstAnySpan.name) : '/process';
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
    const prompt = `Generate Express.js API routes for the following application with Sentry instrumentation.
${allBackendRules}
**PROJECT:** ${project.project.name}
**VERTICAL:** ${project.project.vertical}
**REQUIREMENTS:** ${project.project.notes || 'Build functional API endpoints that match the custom spans below'}

**SENTRY BACKEND INSTRUMENTATION (call these within route handlers):**
${backendSpans || '(none — instrument with generic spans)'}

**FRONTEND SPANS (each needs a matching API route — these MUST be implemented):**
${frontendSpansSummary || '(none)'}

**REQUIRED ROUTES (implement ALL of these exactly — these are what the frontend will call):**
${requiredRoutes || '- Derive routes from the backend spans above'}

**CRITICAL REQUIREMENTS:**
1. Implement EVERY route listed above — the frontend will call these exact paths
2. Import ALL instrumentation from '../utils/instrumentation'
3. Use pattern: \`const { trace_span_name } = require('../utils/instrumentation');\`
4. Call trace functions within routes with meaningful attributes from req.body / req.params / req.query
5. Return mock data that matches the domain of "${project.project.name}"
6. Use the EXACT HTTP method shown (GET or POST) — GET for data-fetching, POST for mutations
7. EVERY span gets its OWN unique route. NEVER register two spans on the same method+path.
   WRONG (collapsed): router.post('/operation', ...) × 3  ← only the first ever fires in Express
   CORRECT (unique):  router.get('/product/fetch-details', ...) and router.post('/payment/process-payment', ...)

**IMPORTANT:**
- DO NOT generate generic e-commerce routes (products/cart/checkout) unless this is explicitly an e-commerce project
- Route paths are EXACTLY as specified in REQUIRED ROUTES above — do not rename them or use op-based names
- CRITICAL: Span attribute keys with dots MUST be quoted strings. CORRECT: \`{ 'http.method': value }\`. WRONG: \`{ http.method: value }\` — this is a JavaScript SyntaxError
- CRITICAL: Every route MUST wrap its handler in \`Sentry.continueTrace({ sentryTrace: req.headers['sentry-trace'], baggage: req.headers['baggage'] }, async () => { ... })\` — this ensures the backend span is attached to the frontend trace, not orphaned
- CRITICAL: The instrumentation functions set \`success: true\` on success and \`success: false\` on error automatically. Do NOT use \`has:error\` — dashboard filters use \`success:false\` instead

**CODE PATTERN:**
\`\`\`javascript
const express = require('express');
const router = express.Router();
const Sentry = require('@sentry/node');
const { ${allSpanImports || 'trace_main_operation'} } = require('../utils/instrumentation');

// Each span gets its OWN route — never collapse multiple spans onto the same path
router.get('${exampleRoute}', async (req, res) => {
  return Sentry.continueTrace(
    { sentryTrace: req.headers['sentry-trace'], baggage: req.headers['baggage'] },
    async () => {
      try {
        await ${exampleTraceFn}(async () => {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 300 + 100));
        }, { ${exampleAttr} });
        res.json({ success: true });
      } catch (error) {
        Sentry.captureException(error);
        res.status(500).json({ error: 'Operation failed' });
      }
    }
  );
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

    const { name, vertical, notes } = project.project;
    const spans = project.instrumentation.spans;

    // Build the span catalogue section
    const spanLines = spans.map(s => {
      const attrKeys = Object.keys(s.attributes || {}).join(', ') || '(none)';
      return `  • ${s.name} (op: ${s.op}) — ${s.description || 'no description'} — attributes: ${attrKeys}`;
    }).join('\n');

    // Collect all project-specific attribute keys for the vocabulary block
    const allAttrKeys = [...new Set(spans.flatMap(s => Object.keys(s.attributes || {})))];
    const attrKeysLine = allAttrKeys.length > 0 ? allAttrKeys.join(' | ') : '(none)';

    // Collect unique ops for reference
    const uniqueOps = [...new Set(spans.map(s => s.op))];
    const opsLine = uniqueOps.join(' | ');

    const dashboardRules = this.rulesBank?.getRulesForPrompt('dashboard') || '';
    const prompt = `You are a Sentry observability expert. Generate 8–12 dashboard widgets for the project below.
Use ONLY the vocabulary provided — any deviation will break the dashboard.
${dashboardRules}

PROJECT
  Name: ${name}
  Vertical: ${vertical}
  Description: ${notes || '(none)'}

CUSTOM SPANS
${spanLines || '  (no custom spans defined)'}

════════════════════════════════════════════════════
CONSTRAINED VOCABULARY — use NOTHING outside this list
════════════════════════════════════════════════════

VALID AGGREGATES
  widgetType "spans":
    count(span.duration) | p50(span.duration) | p75(span.duration) |
    p95(span.duration) | p99(span.duration) | avg(span.duration) |
    count_unique(user) | failure_rate() | sum(span.duration)
  widgetType "error-events":
    count()

VALID GROUPBY COLUMNS (for "columns" and "fields" arrays)
  span.op | span.description | transaction | span.status
  Project-specific attribute keys: ${attrKeysLine}

VALID SPAN OPS (use only these exact values in conditions)
  ${opsLine}

VALID CONDITIONS syntax (combine with spaces)
  span.op:<value>          — use an exact op from the list above
  span.description:<value> — use an exact span name from the span list above
  is_transaction:1         — pageload / navigation spans only
  success:false            — spans that recorded an error (custom attribute set by instrumentation)
  success:true             — spans that completed successfully
  ""                       — empty string = no filter (all spans)

CRITICAL FILTER RULES:
- NEVER use has:error or !has:error — these do NOT work for span widgets in Sentry. Use success:false / success:true instead
- NEVER filter on a custom attribute that is not listed in the span's "Attributes" list above. Every condition must match data the reference app actually generates. Using an attribute not in the list will result in an empty widget.

VALID displayType:  big_number | area | line | table
VALID widgetType:   spans | error-events

big_number query rules (CRITICAL):
  columns: []          ← always empty for big_number
  fields:  [<aggregate>]  ← only the single aggregate, nothing else
  orderby: ""          ← always empty string for big_number

LAYOUT (6-column grid)
  big_number:  w=2, h=1    (fit three side-by-side in one row)
  area / line: w=2 to 6, h=2
  table:       w=4 to 6, h=2 to 3
  Rules: x + w must be ≤ 6; h ≥ 1; no two widgets may overlap

════════════════════════════════════════════════════
INSTRUCTIONS
════════════════════════════════════════════════════
1. Start with exactly 3 big_number KPIs at y=0 (x=0,w=2 | x=2,w=2 | x=4,w=2).
2. Add 2–3 area or line trend charts in rows below (y≥1).
3. Add 2–4 project-specific widgets that use the span names / ops above
   to make filters that are semantically meaningful for this project.
4. End with exactly 1 table widget at full width (w=6) as the final row.
5. Title each widget with a human-readable business metric name — NOT a raw query.
6. For conditions, use the EXACT span.description or span.op values from the list.
   NEVER use "and", "or", "AND", "OR" — separate multiple filters with a SPACE only.
   CORRECT: "span.op:signup span.description:signup.form"
   WRONG:   "span.op:signup AND span.description:signup.form"
7. Pack rows tightly so widgets do not leave blank gaps.
8. The "fields" array must contain ONLY these valid Sentry field names:
   span.description | span.op | span.duration | transaction | span.status
   plus any aggregate expressions from the aggregates list.
   NEVER put custom attribute names (e.g. "email", "form_data") in fields.

Return ONLY a valid JSON array of widget objects. No markdown fences, no wrapper object.

EXAMPLES:

big_number widget (note: columns=[], fields=[aggregate only], orderby=""):
{
  "title": "Avg Submission Latency",
  "description": "Average duration of form submission spans",
  "displayType": "big_number",
  "widgetType": "spans",
  "interval": "1h",
  "queries": [{
    "aggregates": ["avg(span.duration)"],
    "columns": [],
    "conditions": "span.op:operation span.description:signup.form_submission",
    "fields": ["avg(span.duration)"],
    "orderby": "",
    "name": "Avg Submission Latency"
  }],
  "layout": { "x": 0, "y": 0, "w": 2, "h": 1, "minH": 1 }
}

area/line widget:
{
  "title": "Signup Form Submissions",
  "description": "Volume of signup form submission spans over time",
  "displayType": "area",
  "widgetType": "spans",
  "interval": "1h",
  "queries": [{
    "aggregates": ["count(span.duration)"],
    "columns": ["span.description"],
    "conditions": "span.op:operation",
    "fields": ["span.description", "count(span.duration)"],
    "orderby": "-count(span.duration)",
    "name": "Signup Form Submissions"
  }],
  "layout": { "x": 0, "y": 3, "w": 3, "h": 2, "minH": 2 }
}`;

    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

    const raw = await this.callLLM(messages, {
      baseUrl: settings.llm.baseUrl,
      apiKey: settings.llm.apiKey,
      model: settings.llm.model || 'gpt-4-turbo-preview',
    });

    // Strip markdown fences if the LLM wrapped the response (including any trailing explanation)
    const cleaned = raw
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```[\s\S]*$/, '')
      .trim();

    let parsed: any[];
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`LLM returned non-JSON response for dashboard widgets: ${cleaned.slice(0, 200)}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error('LLM dashboard response is not a JSON array');
    }

    // Valid Sentry span field names (non-aggregate columns)
    const VALID_SPAN_FIELDS = new Set([
      'span.description', 'span.op', 'span.duration', 'span.status',
      'transaction', 'project', 'timestamp', 'id', 'trace',
    ]);

    // Sanitize a single widget before validation
    const sanitizeWidget = (w: any): any => {
      if (!w || typeof w !== 'object') return w;
      const out = { ...w };
      const isBigNumber = out.displayType === 'big_number';
      if (Array.isArray(out.queries)) {
        out.queries = out.queries.map((q: any) => {
          if (!q || typeof q !== 'object') return q;
          const sq = { ...q };
          // Strip SQL-style boolean operators from conditions
          if (typeof sq.conditions === 'string') {
            sq.conditions = sq.conditions
              .replace(/\s+and\s+/gi, ' ')
              .replace(/\s+or\s+/gi, ' ')
              .trim();
          }
          // big_number: columns must be empty, fields must be only the aggregates
          if (isBigNumber) {
            sq.columns = [];
            sq.fields = Array.isArray(sq.aggregates) ? [...sq.aggregates] : sq.fields;
            sq.orderby = '';
          } else {
            // Sanitize fields: keep only valid span fields and aggregate expressions
            if (Array.isArray(sq.fields)) {
              sq.fields = sq.fields.filter((f: string) =>
                VALID_SPAN_FIELDS.has(f) || VALID_AGGREGATE_RE.test(f)
              );
              // Always keep at least one non-aggregate field
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

    // Validation constants
    const VALID_DISPLAY_TYPES = new Set(['big_number', 'area', 'line', 'table']);
    const VALID_WIDGET_TYPES  = new Set(['spans', 'error-events']);
    const VALID_AGGREGATE_RE  = /^(count|p\d+|avg|sum|count_unique|failure_rate)\([\w.]*\)$|^(count|failure_rate)\(\)$/;

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

    const valid = parsed.map(sanitizeWidget).filter(isValidWidget);
    const dropped = parsed.length - valid.length;
    if (dropped > 0) {
      console.warn(`  ⚠️  Dropped ${dropped} invalid widget(s) from LLM dashboard response`);
    }

    if (valid.length < 3) {
      throw new Error(`Only ${valid.length} valid widget(s) generated — falling back to template`);
    }

    console.log(`✅ LLM generated ${valid.length} valid dashboard widgets`);
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
    runId: string
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
    const prompt = `You are a Puppeteer automation expert generating user flows to trigger Sentry custom spans.
${puppeteerRules}
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

FLOW STEP TYPES:
  navigate: { "action": "navigate", "url": "/path" }
  api_call: { "action": "api_call", "url": "http://localhost:3001/api/...", "method": "GET"|"POST", "body": {...} }
  click:    { "action": "click", "selector": "button[type=submit]" }
  type:     { "action": "type", "selector": "input[name=email]", "value": "test@example.com" }
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
    config: { baseUrl?: string; apiKey?: string; model?: string; temperature?: number; timeoutMs?: number }
  ): Promise<string> {
    return this.callLLM(messages, { temperature: 0.2, ...config });
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
