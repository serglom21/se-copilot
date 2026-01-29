import { describe, it, expect } from 'vitest';
import {
  EngagementSpecSchema,
  SpanDefinitionSchema,
  DashboardWidgetSchema
} from './spec';

describe('Spec Validation', () => {
  describe('SpanDefinitionSchema', () => {
    it('should validate a valid span', () => {
      const span = {
        name: 'checkout.validate',
        op: 'checkout',
        layer: 'backend' as const,
        description: 'Validates cart items',
        attributes: {
          cart_value: 'Total cart value',
          item_count: 'Number of items'
        },
        pii: {
          keys: ['email']
        }
      };

      const result = SpanDefinitionSchema.safeParse(span);
      expect(result.success).toBe(true);
    });

    it('should reject span without required fields', () => {
      const span = {
        name: 'test',
        // missing op and layer
      };

      const result = SpanDefinitionSchema.safeParse(span);
      expect(result.success).toBe(false);
    });

    it('should set default values for optional fields', () => {
      const span = {
        name: 'test',
        op: 'test',
        layer: 'frontend' as const
      };

      const result = SpanDefinitionSchema.parse(span);
      expect(result.attributes).toEqual({});
      expect(result.pii.keys).toEqual([]);
    });
  });

  describe('DashboardWidgetSchema', () => {
    it('should validate a valid widget', () => {
      const widget = {
        title: 'Transaction Volume',
        type: 'timeseries' as const,
        query: 'count()',
        layout: { x: 0, y: 0, w: 2, h: 2 }
      };

      const result = DashboardWidgetSchema.safeParse(widget);
      expect(result.success).toBe(true);
    });
  });

  describe('EngagementSpecSchema', () => {
    it('should validate a complete engagement spec', () => {
      const spec = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        project: {
          name: 'Test Project',
          slug: 'test-project',
          vertical: 'ecommerce' as const,
          notes: 'Test notes',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        stack: {
          frontend: 'nextjs' as const,
          backend: 'express' as const
        },
        instrumentation: {
          transactions: ['/api/products'],
          spans: []
        },
        dashboard: {
          widgets: []
        },
        chatHistory: [],
        status: 'draft' as const
      };

      const result = EngagementSpecSchema.safeParse(spec);
      expect(result.success).toBe(true);
    });
  });
});
