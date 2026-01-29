import { StorageService } from './storage';
import { EngagementSpec, SpanDefinition } from '../../src/types/spec';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class LLMService {
  private storage: StorageService;

  constructor(storage: StorageService) {
    this.storage = storage;
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

    // Extract spans from the response
    const extractedSpans = this.extractSpansFromText(response);

    // Auto-add extracted spans to the project
    if (extractedSpans.length > 0) {
      const existingSpanNames = new Set(project.instrumentation.spans.map(s => s.name));
      const newSpans = extractedSpans.filter(span => !existingSpanNames.has(span.name));
      
      if (newSpans.length > 0) {
        const updatedSpans = [...project.instrumentation.spans, ...newSpans];
        this.storage.updateProject(projectId, {
          instrumentation: {
            ...project.instrumentation,
            spans: updatedSpans
          }
        });
      }
    }

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
    
    // Pattern 1: Backtick-wrapped span names (handles multi-part like shipping.address.format)
    const codeBlockPattern = /`([a-z]+(?:\.[a-zA-Z]+)+)`/g;
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
    const explicitPattern = /span.*?[:`]\s*([a-z]+(?:\.[a-zA-Z]+)+)/gi;
    const explicitMatches = text.matchAll(explicitPattern);
    
    for (const match of explicitMatches) {
      const spanName = match[1].toLowerCase();
      if (!spanName.includes('.')) continue;
      
      // Skip if already added
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
    let exampleSpans: string;

    if (project.stack.type === 'backend-only') {
      const framework = project.stack.backend === 'flask' ? 'Flask' : 'FastAPI';
      stackDescription = `- Backend: ${framework} (Python)`;
      exampleSpans = `Examples for Python backend:
- db.query_users
- cache.redis_get
- api.endpoint_process
- payment.stripe_charge
- email.sendgrid_send
- external.http_call
- data.transform
- file.s3_upload`;
    } else if (project.stack.type === 'mobile') {
      stackDescription = `- Frontend: React Native (Expo)\n- Backend: Express`;
      exampleSpans = `Examples for mobile:
- navigation.screen_load
- ui.button_press
- api.fetch_products
- auth.login
- sensor.camera_capture`;
    } else {
      stackDescription = `- Frontend: Next.js\n- Backend: Express`;
      exampleSpans = `Examples for web:
- checkout.validate_cart
- payment.process
- cart.addProduct`;
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are an expert in Sentry instrumentation and observability. Your task is to generate a comprehensive instrumentation plan for a ${project.project.vertical} application.

The application uses:
${stackDescription}

Generate a JSON response with the following structure:
{
  "transactions": ["list of transaction names"],
  "spans": [
    {
      "name": "span.operation_name",
      "op": "operation_type",
      "layer": "frontend" or "backend",
      "description": "what this span measures",
      "attributes": {
        "attribute_key": "description of what this attribute captures"
      },
      "pii": {
        "keys": ["list of attribute keys that contain PII"]
      }
    }
  ]
}

${exampleSpans}

For each critical user journey:
1. Define transaction names (e.g., "GET /api/products", "POST /api/checkout")
2. Define custom spans for key operations
3. Add meaningful attributes (e.g., cart_value, item_count, payment_method)
4. Mark PII attributes (e.g., email, credit_card, address)

Be specific and comprehensive. Return ONLY valid JSON.`
      },
      {
        role: 'user',
        content: `Project: ${project.project.name}
Vertical: ${project.project.vertical}
Stack Type: ${project.stack.type}
Notes: ${project.project.notes || 'None'}

Generate an instrumentation plan for this project.`
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
      return {
        transactions: parsed.transactions || [],
        spans: parsed.spans || []
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
      // Remove markdown code blocks if present
      let jsonText = response.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\n?/, '');
        jsonText = jsonText.replace(/\n?```$/, '');
        jsonText = jsonText.trim();
      }
      
      const parsed = JSON.parse(jsonText);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('Failed to parse custom features response:', error);
      return [];
    }
  }

  private buildSystemPrompt(project: EngagementSpec): string {
    let stackDescription: string;
    let spanSuggestions: string;

    if (project.stack.type === 'backend-only') {
      const framework = project.stack.backend === 'flask' ? 'Flask' : 'FastAPI';
      stackDescription = `${framework} (Python) backend API`;
      spanSuggestions = `- Backend API spans: \`db.query\`, \`cache.get\`, \`api.endpoint\`, \`external.http_call\`
- Business logic spans: \`payment.process\`, \`order.validate\`, \`email.send\`
- Data processing: \`data.transform\`, \`file.process\`, \`batch.job\``;
    } else if (project.stack.type === 'mobile') {
      stackDescription = `React Native (${project.stack.mobile_framework}) + Express backend`;
      spanSuggestions = `- Mobile-specific spans: \`navigation.screen_load\`, \`ui.button_press\`, \`sensor.camera\`, \`sensor.location\`
- API calls: \`api.fetch\`, \`api.post\``;
    } else {
      stackDescription = `Next.js frontend + Express backend`;
      spanSuggestions = `- Web spans: \`checkout.validate\`, \`payment.process\`, \`cart.addProduct\``;
    }

    return `You are an expert Sentry Sales Engineer helping to plan instrumentation for a customer demo.

Project: ${project.project.name}
Vertical: ${project.project.vertical}
Stack: ${stackDescription}

Current instrumentation plan:
- Transactions: ${project.instrumentation.transactions.join(', ') || 'None yet'}
- Custom spans: ${project.instrumentation.spans.length} defined

Your role is to:
1. Answer questions about Sentry instrumentation best practices
2. Help refine the instrumentation plan
3. Suggest additional spans or attributes based on the use case
4. Provide guidance on what data to capture

IMPORTANT: When suggesting custom spans, use this format:
- Use backticks around span names: \`operation.action\`
${spanSuggestions}
- Mention if it's for frontend or backend
- Suggest relevant attributes like \`cart_value\`, \`item_count\`, \`payment_method\`

The system will automatically extract and add these spans to the instrumentation spec!

Be concise and practical. Focus on delivering value for a demo.`;
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
    
    // Remove markdown code blocks if present
    let code = response.trim();
    if (code.startsWith('```')) {
      code = code.replace(/^```(?:typescript|ts|javascript|js)?\n?/, '');
      code = code.replace(/\n?```$/, '');
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
      const escaped = content.replace(/[\u0000-\u001F\u007F-\u009F"\\]/g, (char) => {
        // Handle common escape sequences
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

    return cleanedResponse.substring(jsonStartIndex, jsonEndIndex + 1);
  }

  private async callLLM(messages: ChatMessage[], config: { baseUrl?: string; apiKey?: string; model?: string }): Promise<string> {
    const { baseUrl, apiKey, model = 'gpt-4-turbo-preview' } = config;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 4000  // Increased for larger code generation
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LLM API error: ${response.status} ${error}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }
}
