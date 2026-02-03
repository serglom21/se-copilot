import * as Sentry from '@sentry/node';
import Chance from 'chance';
import { StorageService } from './storage';
import { EngagementSpec, SpanDefinition } from '../../src/types/spec';

const chance = new Chance();

export interface IssueScenario {
  id: string;
  span: SpanDefinition;
  errorType: string;
  errorMessage: string;
  severity: 'fatal' | 'error' | 'warning';
  stackTrace: string;
  context: {
    user?: Record<string, any>;
    tags?: Record<string, string>;
    extra?: Record<string, any>;
  };
  codeSnippet: string;
}

export interface IssueSimulatorConfig {
  spanName?: string;
  count: number;
  severity: 'fatal' | 'error' | 'warning';
  includeUserContext: boolean;
  includeBreadcrumbs: boolean;
}

export class IssueSimulatorService {
  private storage: StorageService;
  private sentryInitialized: boolean = false;

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  async getScenarios(projectId: string): Promise<IssueScenario[]> {
    const project = this.storage.getProject(projectId);
    const scenarios: IssueScenario[] = [];

    for (const span of project.instrumentation.spans) {
      // Generate 2-3 different error scenarios for each span
      const errorCount = chance.integer({ min: 2, max: 3 });

      for (let i = 0; i < errorCount; i++) {
        scenarios.push(this.generateScenario(span, project));
      }
    }

    return scenarios;
  }

  private generateScenario(span: SpanDefinition, project: EngagementSpec): IssueScenario {
    const errorInfo = this.generateErrorForSpan(span);
    const severity = chance.pickone(['error', 'warning']) as 'error' | 'warning';

    return {
      id: chance.guid(),
      span,
      errorType: errorInfo.type,
      errorMessage: errorInfo.message,
      severity,
      stackTrace: this.generateStackTrace(span, project),
      context: this.generateContext(span),
      codeSnippet: this.generateCodeSnippet(span, errorInfo)
    };
  }

  private generateErrorForSpan(span: SpanDefinition): { type: string; message: string } {
    const op = span.op.toLowerCase();
    const name = span.name.toLowerCase();

    // Frontend errors
    if (span.layer === 'frontend') {
      if (op.includes('click') || op.includes('ui')) {
        return {
          type: 'TypeError',
          message: chance.pickone([
            `Cannot read property '${chance.word()}' of undefined`,
            `${chance.word()} is not a function`,
            `Failed to execute '${chance.word()}' on 'Element'`
          ])
        };
      } else if (op.includes('http') || op.includes('fetch')) {
        return {
          type: 'NetworkError',
          message: chance.pickone([
            'Failed to fetch',
            'Network request failed',
            `HTTP ${chance.pickone([500, 502, 503, 504])}: ${chance.pickone(['Internal Server Error', 'Bad Gateway', 'Service Unavailable', 'Gateway Timeout'])}`
          ])
        };
      } else if (op.includes('render')) {
        return {
          type: 'RenderError',
          message: chance.pickone([
            'Maximum update depth exceeded',
            'Cannot update component while rendering different component',
            'Invalid hook call'
          ])
        };
      }
    }

    // Backend errors
    if (span.layer === 'backend') {
      if (op.includes('db') || op.includes('query')) {
        return {
          type: 'DatabaseError',
          message: chance.pickone([
            'Connection timeout after 5000ms',
            'Deadlock detected',
            `Table '${chance.word()}' doesn't exist`,
            'Too many connections'
          ])
        };
      } else if (op.includes('http') || op.includes('request')) {
        return {
          type: 'HTTPError',
          message: chance.pickone([
            `${chance.pickone([400, 401, 403, 404, 500, 502])}: ${chance.pickone(['Bad Request', 'Unauthorized', 'Forbidden', 'Not Found', 'Internal Server Error', 'Bad Gateway'])}`,
            'Request timeout',
            'Connection refused'
          ])
        };
      } else if (op.includes('cache')) {
        return {
          type: 'CacheError',
          message: chance.pickone([
            'Redis connection refused',
            'Cache miss - key not found',
            'Memcached server unavailable'
          ])
        };
      } else if (name.includes('payment')) {
        return {
          type: 'PaymentError',
          message: chance.pickone([
            'Payment gateway timeout',
            'Invalid card number',
            'Insufficient funds',
            'Payment processing failed'
          ])
        };
      } else if (name.includes('auth')) {
        return {
          type: 'AuthenticationError',
          message: chance.pickone([
            'Invalid credentials',
            'Token expired',
            'Session not found',
            'Permission denied'
          ])
        };
      }
    }

    // Generic error
    return {
      type: 'Error',
      message: `Failed to execute ${span.name}: ${chance.sentence({ words: 5 })}`
    };
  }

  private generateStackTrace(span: SpanDefinition, project: EngagementSpec): string {
    const layer = span.layer;
    const isBackend = layer === 'backend';
    const lines: string[] = [];

    // Error origin
    const fileName = isBackend
      ? `backend/src/${chance.pickone(['routes', 'controllers', 'services'])}/${span.op}.${chance.pickone(['js', 'ts'])}`
      : `frontend/app/${chance.pickone(['components', 'pages', 'lib'])}/${span.op}.${chance.pickone(['tsx', 'jsx', 'ts'])}`;

    lines.push(`  at ${span.name.replace(/\./g, '_')} (${fileName}:${chance.integer({ min: 10, max: 200 })}:${chance.integer({ min: 5, max: 50 })})`);

    // Add intermediate frames
    const frameCount = chance.integer({ min: 3, max: 8 });
    for (let i = 0; i < frameCount; i++) {
      const frameName = chance.pickone([
        'processRequest',
        'handleError',
        'executeHandler',
        'runMiddleware',
        'validateInput',
        'performAction'
      ]);
      const frameFile = isBackend
        ? `backend/src/${chance.pickone(['middleware', 'utils', 'lib'])}/${chance.word()}.${chance.pickone(['js', 'ts'])}`
        : `frontend/${chance.pickone(['components', 'hooks', 'utils'])}/${chance.word()}.${chance.pickone(['tsx', 'ts'])}`;

      lines.push(`  at ${frameName} (${frameFile}:${chance.integer({ min: 10, max: 500 })}:${chance.integer({ min: 5, max: 80 })})`);
    }

    // Add framework frames
    if (isBackend) {
      lines.push(`  at Layer.handle [as handle_request] (node_modules/express/lib/router/layer.js:95:5)`);
      lines.push(`  at next (node_modules/express/lib/router/route.js:144:13)`);
    } else {
      lines.push(`  at React.createElement (node_modules/react/cjs/react.production.min.js:32:${chance.integer({ min: 100, max: 999 })})`);
      lines.push(`  at renderWithHooks (node_modules/react-dom/cjs/react-dom.production.min.js:10:${chance.integer({ min: 100, max: 999 })})`);
    }

    return lines.join('\n');
  }

  private generateContext(span: SpanDefinition): IssueScenario['context'] {
    const tags: Record<string, string> = {
      'span.op': span.op,
      'span.name': span.name,
      'layer': span.layer
    };

    // Add custom attributes as tags
    Object.keys(span.attributes).forEach(key => {
      tags[key] = String(span.attributes[key]);
    });

    return {
      user: {
        id: `user_${chance.integer({ min: 1000, max: 9999 })}`,
        email: chance.email(),
        username: chance.twitter().substring(1),
        ip_address: chance.ip()
      },
      tags,
      extra: {
        request_id: chance.guid(),
        session_id: chance.hash({ length: 32 }),
        timestamp: new Date().toISOString(),
        environment: chance.pickone(['production', 'staging', 'development'])
      }
    };
  }

  private generateCodeSnippet(span: SpanDefinition, errorInfo: { type: string; message: string }): string {
    const isBackend = span.layer === 'backend';

    if (isBackend) {
      return `// ${span.description || 'Backend operation'}
const Sentry = require('@sentry/node');

async function ${span.name.replace(/\./g, '_')}() {
  return await Sentry.startSpan(
    {
      op: '${span.op}',
      name: '${span.name}'
    },
    async () => {
      try {
        // Your operation here
        ${this.generateOperationCode(span)}
      } catch (error) {
        Sentry.captureException(error, {
          tags: {
            'span.op': '${span.op}',
            'span.name': '${span.name}'
          },
          extra: {
            ${Object.keys(span.attributes).map(k => `${k}: context.${k}`).join(',\n            ')}
          }
        });
        throw error;
      }
    }
  );
}`;
    } else {
      return `// ${span.description || 'Frontend operation'}
import * as Sentry from '@sentry/nextjs';

async function ${span.name.replace(/\./g, '_')}() {
  return await Sentry.startSpan(
    {
      op: '${span.op}',
      name: '${span.name}'
    },
    async () => {
      try {
        // Your operation here
        ${this.generateOperationCode(span)}
      } catch (error) {
        Sentry.captureException(error, {
          tags: {
            'span.op': '${span.op}',
            'span.name': '${span.name}'
          }
        });
        throw error;
      }
    }
  );
}`;
    }
  }

  private generateOperationCode(span: SpanDefinition): string {
    const op = span.op.toLowerCase();

    if (op.includes('db') || op.includes('query')) {
      return `const result = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (!result.rows.length) throw new Error('User not found');`;
    } else if (op.includes('http') || op.includes('fetch')) {
      return `const response = await fetch('https://api.example.com/data');
        if (!response.ok) throw new Error('Request failed');`;
    } else if (op.includes('cache')) {
      return `const data = await redis.get(cacheKey);
        if (!data) throw new Error('Cache miss');`;
    } else {
      return `const result = await performOperation();
        if (!result.success) throw new Error('Operation failed');`;
    }
  }

  async sendToSentry(
    projectId: string,
    scenarios: IssueScenario[],
    dsn: string
  ): Promise<{ success: boolean; issuesCreated: number; errors: string[] }> {
    if (!this.sentryInitialized) {
      Sentry.init({
        dsn,
        tracesSampleRate: 1.0,
        environment: 'demo'
      });
      this.sentryInitialized = true;
    }

    const errors: string[] = [];
    let successCount = 0;

    for (const scenario of scenarios) {
      try {
        Sentry.withScope(scope => {
          // Set user
          if (scenario.context.user) {
            scope.setUser(scenario.context.user);
          }

          // Set tags
          if (scenario.context.tags) {
            Object.entries(scenario.context.tags).forEach(([key, value]) => {
              scope.setTag(key, value);
            });
          }

          // Set extra context
          if (scenario.context.extra) {
            scope.setExtras(scenario.context.extra);
          }

          // Set level based on severity
          scope.setLevel(scenario.severity);

          // Create error and capture
          const error = new Error(scenario.errorMessage);
          error.name = scenario.errorType;
          error.stack = `${scenario.errorType}: ${scenario.errorMessage}\n${scenario.stackTrace}`;

          Sentry.captureException(error);
        });

        successCount++;
      } catch (error) {
        errors.push(`Failed to send scenario ${scenario.id}: ${error}`);
      }
    }

    // Flush to ensure all events are sent
    await Sentry.flush(2000);

    return {
      success: errors.length === 0,
      issuesCreated: successCount,
      errors
    };
  }
}
