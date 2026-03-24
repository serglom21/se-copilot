import fs from 'fs';
import path from 'path';
import { StorageService } from './storage';
import { LLMService } from './llm';
import { GeneratorService } from './generator';
import { LiveDataGeneratorService } from './live-data-generator';
import { TraceIngestService, CapturedTrace } from './trace-ingest';
import { RulesBankService, RuleCategory } from './rules-bank';
import { EngagementSpec } from '../../src/types/spec';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrainingSpec {
  name: string;
  slug: string;
  vertical: 'ecommerce' | 'fintech' | 'healthcare' | 'saas' | 'gaming' | 'media' | 'other';
  description: string;
  stack: { frontend: string; backend: 'express' | 'flask' | 'fastapi' };
  spans: Array<{
    name: string;
    op: string;
    layer: 'frontend' | 'backend';
    description?: string;
    attributes?: Record<string, string>;
  }>;
  dashboardWidgets: Array<{ title: string; query: string }>;
}

export interface CriteriaCheck {
  pass: boolean;
  details: string;
  issues: string[];
}

export interface CriteriaResult {
  // Category 1: Trace connectivity (existing)
  noOrphanSpans: { pass: boolean; details: string };
  feBeConnected: { pass: boolean; details: string };
  customSpansCovered: { pass: boolean; details: string; missing: string[] };
  widgetDataMatched: { pass: boolean; details: string; missingAttrs: string[] };
  noRootSpanGaps: { pass: boolean; details: string; gapSpans: string[] };
  // Category 2: Span timing integrity (new)
  spanTiming: CriteriaCheck;
  // Category 3: Span naming conventions (new)
  spanNaming: CriteriaCheck;
  // Category 4: Required attribute completeness (new)
  attributeCompleteness: CriteriaCheck;
  // Category 5: Transaction structure (new)
  transactionCompleteness: CriteriaCheck;
}

export interface TrainingRunResult {
  specSlug: string;
  specName: string;
  iterations: number;
  finalScore: number;
  finalGrade: string;
  criteria: CriteriaResult;
  rulesExtracted: string[];
  durationMs: number;
  error?: string;
}

export interface TrainingRunConfig {
  specs: TrainingSpec[];
  maxIterationsPerSpec: number; // default 3
  minPassScore: number; // default 80
  localIngestPort: number; // default 9999
}

// ---------------------------------------------------------------------------
// Built-in spec bank
// ---------------------------------------------------------------------------

export const BUILTIN_SPECS: TrainingSpec[] = [
  {
    name: 'Shopify-style E-Commerce',
    slug: 'training-ecommerce',
    vertical: 'ecommerce',
    description: 'Online store with product catalog, cart, and checkout',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'product.list_fetch', op: 'http.client', layer: 'frontend', description: 'Fetches product catalog', attributes: { 'product.count': 'number', category: 'string' } },
      { name: 'cart.add_item', op: 'http.client', layer: 'frontend', description: 'Adds item to cart', attributes: { 'product.id': 'string', quantity: 'number' } },
      { name: 'checkout.validate_cart', op: 'function', layer: 'backend', description: 'Validates cart items', attributes: { 'cart.total': 'number', 'item.count': 'number' } },
      { name: 'checkout.process_payment', op: 'function', layer: 'backend', description: 'Processes payment', attributes: { 'payment.method': 'string', success: 'boolean' } },
      { name: 'order.create', op: 'db', layer: 'backend', description: 'Creates order record', attributes: { 'order.id': 'string', status: 'string' } },
    ],
    dashboardWidgets: [
      { title: 'Checkout Conversion Rate', query: 'success:true span.op:function' },
      { title: 'Payment Errors', query: 'success:false span.op:function' },
    ],
  },
  {
    name: 'Banking Dashboard (Fintech)',
    slug: 'training-fintech',
    vertical: 'fintech',
    description: 'Online banking with account overview and transfers',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'account.balance_fetch', op: 'http.client', layer: 'frontend', description: 'Fetches account balance', attributes: { 'account.id': 'string', currency: 'string' } },
      { name: 'transaction.list', op: 'http.client', layer: 'frontend', description: 'Lists recent transactions', attributes: { limit: 'number', page: 'number' } },
      { name: 'transfer.validate', op: 'function', layer: 'backend', description: 'Validates transfer request', attributes: { 'transfer.amount': 'number', success: 'boolean' } },
      { name: 'transfer.execute', op: 'db', layer: 'backend', description: 'Executes fund transfer', attributes: { 'transfer.id': 'string', status: 'string' } },
    ],
    dashboardWidgets: [
      { title: 'Transfer Success Rate', query: 'success:true span.op:function' },
      { title: 'Failed Transfers', query: 'success:false span.op:db' },
    ],
  },
  {
    name: 'Patient Portal (Healthcare)',
    slug: 'training-healthcare',
    vertical: 'healthcare',
    description: 'Patient appointment booking and medical records',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'appointment.availability', op: 'http.client', layer: 'frontend', description: 'Fetches available slots', attributes: { 'doctor.id': 'string', date: 'string' } },
      { name: 'appointment.book', op: 'http.client', layer: 'frontend', description: 'Books appointment', attributes: { 'appointment.id': 'string', success: 'boolean' } },
      { name: 'records.fetch', op: 'db', layer: 'backend', description: 'Fetches patient records', attributes: { 'record.count': 'number', 'patient.id': 'string' } },
      { name: 'appointment.validate', op: 'function', layer: 'backend', description: 'Validates booking', attributes: { available: 'boolean', success: 'boolean' } },
    ],
    dashboardWidgets: [
      { title: 'Appointment Bookings', query: 'success:true span.op:http.client' },
      { title: 'Booking Failures', query: 'success:false span.op:function' },
    ],
  },
  {
    name: 'SaaS Analytics Platform',
    slug: 'training-saas',
    vertical: 'saas',
    description: 'Analytics dashboard with data ingestion and reporting',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'dashboard.load', op: 'pageload', layer: 'frontend', description: 'Main dashboard load', attributes: { 'widget.count': 'number' } },
      { name: 'metrics.fetch', op: 'http.client', layer: 'frontend', description: 'Fetches metrics data', attributes: { 'metric.type': 'string', period: 'string' } },
      { name: 'report.generate', op: 'function', layer: 'backend', description: 'Generates analytics report', attributes: { 'report.rows': 'number', success: 'boolean' } },
      { name: 'data.aggregate', op: 'db', layer: 'backend', description: 'Aggregates raw data', attributes: { 'row.count': 'number', duration_ms: 'number' } },
    ],
    dashboardWidgets: [
      { title: 'Report Generation Time', query: 'span.op:function success:true' },
      { title: 'Slow Aggregations', query: 'span.op:db' },
    ],
  },
  {
    name: 'Game Leaderboard (Gaming)',
    slug: 'training-gaming',
    vertical: 'gaming',
    description: 'Real-time game leaderboard with score tracking',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'leaderboard.fetch', op: 'http.client', layer: 'frontend', description: 'Fetches top scores', attributes: { 'game.id': 'string', limit: 'number' } },
      { name: 'score.submit', op: 'http.client', layer: 'frontend', description: 'Submits player score', attributes: { score: 'number', success: 'boolean' } },
      { name: 'score.validate', op: 'function', layer: 'backend', description: 'Validates score submission', attributes: { valid: 'boolean', success: 'boolean' } },
      { name: 'leaderboard.update', op: 'db', layer: 'backend', description: 'Updates leaderboard table', attributes: { rank: 'number', status: 'string' } },
    ],
    dashboardWidgets: [
      { title: 'Score Submissions', query: 'success:true span.op:http.client' },
      { title: 'Validation Failures', query: 'success:false span.op:function' },
    ],
  },
  {
    name: 'Media Streaming Platform',
    slug: 'training-media',
    vertical: 'media',
    description: 'Video streaming with content catalog and playback',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'content.catalog_fetch', op: 'http.client', layer: 'frontend', description: 'Fetches content catalog', attributes: { 'content.type': 'string', count: 'number' } },
      { name: 'playback.start', op: 'http.client', layer: 'frontend', description: 'Starts content playback', attributes: { 'content.id': 'string', quality: 'string' } },
      { name: 'stream.resolve', op: 'function', layer: 'backend', description: 'Resolves stream URL', attributes: { 'stream.url': 'string', success: 'boolean' } },
      { name: 'analytics.track_view', op: 'db', layer: 'backend', description: 'Records view event', attributes: { 'user.id': 'string', duration: 'number' } },
    ],
    dashboardWidgets: [
      { title: 'Stream Resolutions', query: 'success:true span.op:function' },
      { title: 'Playback Errors', query: 'success:false span.op:http.client' },
    ],
  },

  // --- Round 2: deeper complexity, more spans ---
  {
    name: 'Food Delivery App',
    slug: 'training-food-delivery',
    vertical: 'ecommerce',
    description: 'Food ordering with restaurant search, cart, and delivery tracking',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'restaurant.search', op: 'http.client', layer: 'frontend', description: 'Searches nearby restaurants', attributes: { query: 'string', count: 'number' } },
      { name: 'menu.fetch', op: 'http.client', layer: 'frontend', description: 'Loads restaurant menu', attributes: { 'restaurant.id': 'string', 'item.count': 'number' } },
      { name: 'order.place', op: 'http.client', layer: 'frontend', description: 'Places food order', attributes: { 'order.total': 'number', success: 'boolean' } },
      { name: 'order.validate', op: 'function', layer: 'backend', description: 'Validates order items', attributes: { valid: 'boolean', success: 'boolean' } },
      { name: 'delivery.assign', op: 'function', layer: 'backend', description: 'Assigns delivery driver', attributes: { 'driver.id': 'string', 'eta.minutes': 'number' } },
      { name: 'order.persist', op: 'db', layer: 'backend', description: 'Saves order to database', attributes: { 'order.id': 'string', status: 'string' } },
    ],
    dashboardWidgets: [
      { title: 'Order Success Rate', query: 'success:true span.op:function' },
      { title: 'Failed Orders', query: 'success:false span.op:function' },
    ],
  },
  {
    name: 'Crypto Trading Platform',
    slug: 'training-crypto',
    vertical: 'fintech',
    description: 'Crypto exchange with price feeds, order book, and trade execution',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'price.feed_fetch', op: 'http.client', layer: 'frontend', description: 'Fetches live price data', attributes: { symbol: 'string', 'price.usd': 'number' } },
      { name: 'orderbook.fetch', op: 'http.client', layer: 'frontend', description: 'Loads order book', attributes: { depth: 'number', symbol: 'string' } },
      { name: 'trade.submit', op: 'http.client', layer: 'frontend', description: 'Submits trade order', attributes: { side: 'string', quantity: 'number', success: 'boolean' } },
      { name: 'trade.validate', op: 'function', layer: 'backend', description: 'Validates trade eligibility', attributes: { sufficient_balance: 'boolean', success: 'boolean' } },
      { name: 'trade.execute', op: 'db', layer: 'backend', description: 'Executes and records trade', attributes: { 'trade.id': 'string', price: 'number' } },
    ],
    dashboardWidgets: [
      { title: 'Trade Executions', query: 'success:true span.op:db' },
      { title: 'Failed Trades', query: 'success:false span.op:function' },
    ],
  },
  {
    name: 'Telemedicine Platform',
    slug: 'training-telemedicine',
    vertical: 'healthcare',
    description: 'Virtual doctor consultations with scheduling and prescriptions',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'doctor.search', op: 'http.client', layer: 'frontend', description: 'Searches available doctors', attributes: { specialty: 'string', count: 'number' } },
      { name: 'consultation.book', op: 'http.client', layer: 'frontend', description: 'Books video consultation', attributes: { 'consultation.id': 'string', success: 'boolean' } },
      { name: 'prescription.fetch', op: 'http.client', layer: 'frontend', description: 'Fetches patient prescriptions', attributes: { count: 'number', status: 'string' } },
      { name: 'consultation.validate', op: 'function', layer: 'backend', description: 'Validates booking availability', attributes: { available: 'boolean', success: 'boolean' } },
      { name: 'prescription.create', op: 'db', layer: 'backend', description: 'Creates prescription record', attributes: { 'prescription.id': 'string', medication: 'string' } },
    ],
    dashboardWidgets: [
      { title: 'Consultations Booked', query: 'success:true span.op:function' },
      { title: 'Booking Failures', query: 'success:false span.op:http.client' },
    ],
  },
  {
    name: 'Project Management Tool',
    slug: 'training-project-mgmt',
    vertical: 'saas',
    description: 'Team project tracking with tasks, sprints, and reporting',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'project.list', op: 'http.client', layer: 'frontend', description: 'Lists user projects', attributes: { count: 'number', status: 'string' } },
      { name: 'task.create', op: 'http.client', layer: 'frontend', description: 'Creates new task', attributes: { 'task.id': 'string', priority: 'string', success: 'boolean' } },
      { name: 'sprint.fetch', op: 'http.client', layer: 'frontend', description: 'Loads current sprint', attributes: { 'sprint.id': 'string', 'task.count': 'number' } },
      { name: 'task.validate', op: 'function', layer: 'backend', description: 'Validates task assignment', attributes: { assigned: 'boolean', success: 'boolean' } },
      { name: 'task.persist', op: 'db', layer: 'backend', description: 'Persists task to database', attributes: { 'task.id': 'string', status: 'string' } },
      { name: 'sprint.update', op: 'db', layer: 'backend', description: 'Updates sprint metrics', attributes: { velocity: 'number', success: 'boolean' } },
    ],
    dashboardWidgets: [
      { title: 'Tasks Created', query: 'success:true span.op:db' },
      { title: 'Task Creation Failures', query: 'success:false span.op:function' },
    ],
  },
  {
    name: 'Multiplayer Game Matchmaking',
    slug: 'training-matchmaking',
    vertical: 'gaming',
    description: 'Online game lobby with matchmaking, ranking, and session management',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'lobby.fetch', op: 'http.client', layer: 'frontend', description: 'Fetches open lobbies', attributes: { count: 'number', game_mode: 'string' } },
      { name: 'match.join', op: 'http.client', layer: 'frontend', description: 'Joins matchmaking queue', attributes: { 'player.rank': 'number', success: 'boolean' } },
      { name: 'session.create', op: 'http.client', layer: 'frontend', description: 'Creates game session', attributes: { 'session.id': 'string', 'player.count': 'number' } },
      { name: 'match.validate', op: 'function', layer: 'backend', description: 'Validates match eligibility', attributes: { eligible: 'boolean', success: 'boolean' } },
      { name: 'session.persist', op: 'db', layer: 'backend', description: 'Records session to database', attributes: { 'session.id': 'string', status: 'string' } },
    ],
    dashboardWidgets: [
      { title: 'Successful Matches', query: 'success:true span.op:function' },
      { title: 'Match Failures', query: 'success:false span.op:db' },
    ],
  },
  {
    name: 'News & Content Platform',
    slug: 'training-news',
    vertical: 'media',
    description: 'News aggregator with personalized feed, search, and bookmarks',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'feed.personalized', op: 'http.client', layer: 'frontend', description: 'Fetches personalized news feed', attributes: { count: 'number', category: 'string' } },
      { name: 'article.fetch', op: 'http.client', layer: 'frontend', description: 'Loads full article', attributes: { 'article.id': 'string', 'word.count': 'number' } },
      { name: 'bookmark.save', op: 'http.client', layer: 'frontend', description: 'Saves article bookmark', attributes: { 'article.id': 'string', success: 'boolean' } },
      { name: 'feed.rank', op: 'function', layer: 'backend', description: 'Ranks articles by relevance', attributes: { algorithm: 'string', success: 'boolean' } },
      { name: 'bookmark.persist', op: 'db', layer: 'backend', description: 'Persists bookmark record', attributes: { 'bookmark.id': 'string', status: 'string' } },
    ],
    dashboardWidgets: [
      { title: 'Articles Served', query: 'success:true span.op:function' },
      { title: 'Feed Ranking Errors', query: 'success:false span.op:function' },
    ],
  },

  // --- Round 3: edge cases and tricky instrumentation patterns ---
  {
    name: 'B2B Invoice & Billing',
    slug: 'training-billing',
    vertical: 'saas',
    description: 'Invoice generation, payment collection, and subscription management',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'invoice.list', op: 'http.client', layer: 'frontend', description: 'Lists customer invoices', attributes: { count: 'number', status: 'string' } },
      { name: 'invoice.generate', op: 'http.client', layer: 'frontend', description: 'Generates new invoice', attributes: { 'invoice.total': 'number', success: 'boolean' } },
      { name: 'payment.charge', op: 'http.client', layer: 'frontend', description: 'Charges payment method', attributes: { amount: 'number', currency: 'string', success: 'boolean' } },
      { name: 'subscription.check', op: 'function', layer: 'backend', description: 'Checks subscription status', attributes: { active: 'boolean', success: 'boolean' } },
      { name: 'invoice.persist', op: 'db', layer: 'backend', description: 'Saves invoice record', attributes: { 'invoice.id': 'string', status: 'string' } },
      { name: 'payment.record', op: 'db', layer: 'backend', description: 'Records payment transaction', attributes: { 'payment.id': 'string', success: 'boolean' } },
    ],
    dashboardWidgets: [
      { title: 'Payment Success Rate', query: 'success:true span.op:db' },
      { title: 'Failed Payments', query: 'success:false span.op:function' },
    ],
  },
  {
    name: 'Ride-sharing App',
    slug: 'training-rideshare',
    vertical: 'other',
    description: 'Ride booking with driver matching, fare estimation, and trip tracking',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'driver.nearby', op: 'http.client', layer: 'frontend', description: 'Fetches nearby drivers', attributes: { count: 'number', radius_km: 'number' } },
      { name: 'fare.estimate', op: 'http.client', layer: 'frontend', description: 'Estimates trip fare', attributes: { 'fare.usd': 'number', distance_km: 'number' } },
      { name: 'ride.request', op: 'http.client', layer: 'frontend', description: 'Requests a ride', attributes: { 'ride.id': 'string', success: 'boolean' } },
      { name: 'driver.match', op: 'function', layer: 'backend', description: 'Matches driver to rider', attributes: { matched: 'boolean', 'eta.minutes': 'number', success: 'boolean' } },
      { name: 'ride.persist', op: 'db', layer: 'backend', description: 'Saves ride record', attributes: { 'ride.id': 'string', status: 'string' } },
    ],
    dashboardWidgets: [
      { title: 'Rides Matched', query: 'success:true span.op:function' },
      { title: 'Match Failures', query: 'success:false span.op:function' },
    ],
  },
  {
    name: 'HR & Recruitment Platform',
    slug: 'training-hr',
    vertical: 'saas',
    description: 'Job postings, applicant tracking, and interview scheduling',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'job.list', op: 'http.client', layer: 'frontend', description: 'Lists open positions', attributes: { count: 'number', department: 'string' } },
      { name: 'application.submit', op: 'http.client', layer: 'frontend', description: 'Submits job application', attributes: { 'job.id': 'string', success: 'boolean' } },
      { name: 'interview.schedule', op: 'http.client', layer: 'frontend', description: 'Schedules interview slot', attributes: { 'slot.id': 'string', success: 'boolean' } },
      { name: 'application.screen', op: 'function', layer: 'backend', description: 'Screens application with rules', attributes: { passed: 'boolean', success: 'boolean' } },
      { name: 'candidate.persist', op: 'db', layer: 'backend', description: 'Saves candidate record', attributes: { 'candidate.id': 'string', stage: 'string' } },
    ],
    dashboardWidgets: [
      { title: 'Applications Submitted', query: 'success:true span.op:db' },
      { title: 'Screening Failures', query: 'success:false span.op:function' },
    ],
  },
  {
    name: 'IoT Device Dashboard',
    slug: 'training-iot',
    vertical: 'saas',
    description: 'IoT fleet management with telemetry, alerts, and remote commands',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'device.list', op: 'http.client', layer: 'frontend', description: 'Lists registered devices', attributes: { count: 'number', online: 'number' } },
      { name: 'telemetry.fetch', op: 'http.client', layer: 'frontend', description: 'Fetches device telemetry', attributes: { 'device.id': 'string', 'reading.count': 'number' } },
      { name: 'command.send', op: 'http.client', layer: 'frontend', description: 'Sends remote command', attributes: { command: 'string', success: 'boolean' } },
      { name: 'command.validate', op: 'function', layer: 'backend', description: 'Validates command eligibility', attributes: { allowed: 'boolean', success: 'boolean' } },
      { name: 'telemetry.persist', op: 'db', layer: 'backend', description: 'Stores telemetry reading', attributes: { 'reading.id': 'string', value: 'number' } },
    ],
    dashboardWidgets: [
      { title: 'Commands Sent', query: 'success:true span.op:function' },
      { title: 'Command Failures', query: 'success:false span.op:function' },
    ],
  },
  {
    name: 'EdTech Learning Platform',
    slug: 'training-edtech',
    vertical: 'saas',
    description: 'Online courses with progress tracking, quizzes, and certificates',
    stack: { frontend: 'nextjs', backend: 'express' },
    spans: [
      { name: 'course.catalog', op: 'http.client', layer: 'frontend', description: 'Fetches course catalog', attributes: { count: 'number', category: 'string' } },
      { name: 'lesson.fetch', op: 'http.client', layer: 'frontend', description: 'Loads lesson content', attributes: { 'lesson.id': 'string', duration_min: 'number' } },
      { name: 'quiz.submit', op: 'http.client', layer: 'frontend', description: 'Submits quiz answers', attributes: { score: 'number', success: 'boolean' } },
      { name: 'progress.update', op: 'function', layer: 'backend', description: 'Updates learner progress', attributes: { completion_pct: 'number', success: 'boolean' } },
      { name: 'quiz.grade', op: 'db', layer: 'backend', description: 'Records quiz grade', attributes: { 'quiz.id': 'string', passed: 'boolean' } },
    ],
    dashboardWidgets: [
      { title: 'Quizzes Passed', query: 'success:true span.op:db' },
      { title: 'Failed Submissions', query: 'success:false span.op:function' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

// Regex patterns for naming validators
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NUMERIC_SEGMENT_RE = /\/\d{4,}(\/|$)/; // long numeric path segments (IDs)
const VALID_OPS = new Set([
  'pageload', 'navigation', 'http.client', 'http.server',
  'db', 'db.query', 'db.sql', 'db.redis', 'db.mongodb', 'db.elasticsearch',
  'cache.get', 'cache.put', 'cache.set', 'cache.delete',
  'ui.render', 'ui.load', 'ui.action',
  'function', 'task', 'console', 'serialize', 'middleware',
  'rpc', 'graphql', 'websocket', 'file', 'subprocess', 'queue',
  'event', 'measure', 'mark', 'resource', 'fetch',
  // SDK-auto-generated browser performance spans — not custom code, always valid
  'browser', 'browser.domcontentloadedevent', 'browser.loadevent', 'browser.connect',
  'browser.cache', 'browser.dns', 'browser.request', 'browser.response',
  'browser.paint', 'browser.domcontentloaded', 'browser.load',
]);

function validateCriteria(
  traces: CapturedTrace[],
  spec: TrainingSpec
): CriteriaResult {
  const skipped = (label: string): CriteriaCheck => ({ pass: true, details: `Skipped — ${label}`, issues: [] });
  const failed = (label: string): CriteriaCheck => ({ pass: false, details: label, issues: [label] });

  if (traces.length === 0) {
    return {
      noOrphanSpans: { pass: false, details: 'No traces captured' },
      feBeConnected: { pass: false, details: 'No traces captured' },
      customSpansCovered: { pass: false, details: 'No traces captured', missing: spec.spans.map(s => s.name) },
      widgetDataMatched: { pass: false, details: 'No traces captured', missingAttrs: [] },
      noRootSpanGaps: { pass: false, details: 'No traces captured', gapSpans: [] },
      spanTiming: failed('No traces captured'),
      spanNaming: failed('No traces captured'),
      attributeCompleteness: failed('No traces captured'),
      transactionCompleteness: failed('No traces captured'),
    };
  }

  const allSpans = traces.flatMap(t => t.allSpans);
  const allTx = traces.flatMap(t => t.transactions);
  const spanMap = new Map(allSpans.filter(s => s.span_id).map(s => [s.span_id, s]));

  // ── Criterion 1: No orphan spans ─────────────────────────────────────────
  const totalOrphans = traces.reduce((sum, t) => sum + t.orphanSpanIds.length, 0);
  const noOrphanSpans = {
    pass: totalOrphans === 0,
    details: totalOrphans === 0
      ? `All ${allSpans.length} spans properly connected`
      : `${totalOrphans} orphan span(s) detected across ${traces.length} traces`,
  };

  // ── Criterion 2: FE→BE connection ────────────────────────────────────────
  const beRootCount = traces.reduce((sum, t) => {
    const hasFeRoot = t.allSpans.some(s => s.op === 'pageload' || s.op === 'navigation');
    const beRoots = t.allSpans.filter(s => s.op === 'http.server' && !s.parent_span_id);
    return hasFeRoot ? sum + beRoots.length : sum;
  }, 0);
  const feBeConnected = {
    pass: beRootCount === 0,
    details: beRootCount === 0
      ? 'All BE transactions connected to FE trace'
      : `${beRootCount} backend root(s) not connected to frontend trace`,
  };

  // ── Criterion 3: Custom span coverage ────────────────────────────────────
  const coveredSpanNames = new Set<string>();
  for (const span of allSpans) {
    const key = `${span.op}:${span.description}`.toLowerCase();
    const desc = span.description?.toLowerCase() || '';
    const op = span.op?.toLowerCase() || '';
    for (const specSpan of spec.spans) {
      const nameWords = specSpan.name.toLowerCase().replace(/_/g, ' ').split('.');
      const lastName = nameWords[nameWords.length - 1];
      if (
        desc.includes(lastName) ||
        key.includes(specSpan.name.replace(/_/g, '-').toLowerCase()) ||
        op === specSpan.op.toLowerCase()
      ) {
        coveredSpanNames.add(specSpan.name);
      }
    }
  }
  const missingSpans = spec.spans.filter(s => !coveredSpanNames.has(s.name)).map(s => s.name);
  const customSpansCovered = {
    pass: missingSpans.length === 0,
    details: missingSpans.length === 0
      ? `All ${spec.spans.length} custom spans reported`
      : `${missingSpans.length}/${spec.spans.length} spans missing from traces`,
    missing: missingSpans,
  };

  // Skip remaining validators when no actual span data (app launched but sent no spans)
  if (allSpans.length === 0) {
    return {
      noOrphanSpans, feBeConnected, customSpansCovered,
      widgetDataMatched: { pass: true, details: 'Skipped — no span data', missingAttrs: [] },
      noRootSpanGaps: { pass: true, details: 'Skipped — no span data', gapSpans: [] },
      spanTiming: skipped('no span data'),
      spanNaming: skipped('no span data'),
      attributeCompleteness: skipped('no span data'),
      transactionCompleteness: skipped('no span data'),
    };
  }

  // ── Criterion 4: Widget data attributes ──────────────────────────────────
  const widgetAttrs = new Set<string>();
  const SENTRY_NATIVE_KEYS = new Set(['span.op', 'transaction', 'project', 'environment', 'success', 'error', 'status', 'http.status_code', 'has', 'level', 'release', 'user.id']);
  for (const w of spec.dashboardWidgets) {
    for (const m of w.query.matchAll(/([a-z_.]+):([a-z0-9_.]+)/g)) {
      if (!SENTRY_NATIVE_KEYS.has(m[1])) widgetAttrs.add(m[1]);
    }
  }
  const capturedDataKeys = new Set<string>(allSpans.flatMap(s => Object.keys(s.data || {})));
  const missingAttrs = [...widgetAttrs].filter(a => !capturedDataKeys.has(a) && !capturedDataKeys.has(a.replace('.', '_')));
  const widgetDataMatched = {
    pass: missingAttrs.length === 0,
    details: missingAttrs.length === 0
      ? 'All widget filter attributes present in trace data'
      : `${missingAttrs.length} custom attribute(s) in widget queries not found in spans: ${missingAttrs.join(', ')}`,
    missingAttrs,
  };

  // ── Criterion 5: No root span gaps ───────────────────────────────────────
  const childrenOf = new Map<string, typeof allSpans>();
  for (const s of allSpans) {
    if (s.parent_span_id && spanMap.has(s.parent_span_id)) {
      if (!childrenOf.has(s.parent_span_id)) childrenOf.set(s.parent_span_id, []);
      childrenOf.get(s.parent_span_id)!.push(s);
    }
  }
  const gapSpans: string[] = [];
  for (const [parentId, children] of childrenOf) {
    const parent = spanMap.get(parentId);
    if (!parent?.start_timestamp || !parent.timestamp) continue;
    const parentDur = parent.timestamp - parent.start_timestamp;
    if (parentDur < 0.01) continue;
    const childrenDur = children.reduce((sum, c) => sum + Math.max(0, (c.timestamp || 0) - (c.start_timestamp || 0)), 0);
    if (childrenDur / parentDur < 0.5) gapSpans.push(parent.description || parent.op);
  }
  const noRootSpanGaps = {
    pass: gapSpans.length === 0,
    details: gapSpans.length === 0
      ? 'All parent spans accounted for by children'
      : `${gapSpans.length} span(s) with unexplained duration gaps`,
    gapSpans: [...new Set(gapSpans)],
  };

  // ── NEW Criterion 6: Span timing integrity ───────────────────────────────
  const timingIssues: string[] = [];

  // Child spans must fall within parent time bounds
  let outOfBoundsCount = 0;
  for (const span of allSpans) {
    if (!span.parent_span_id) continue;
    const parent = spanMap.get(span.parent_span_id);
    if (!parent) continue;
    if (span.start_timestamp < parent.start_timestamp - 0.005 || span.timestamp > parent.timestamp + 0.005) {
      outOfBoundsCount++;
    }
  }
  if (outOfBoundsCount > 0) timingIssues.push(`${outOfBoundsCount} child span(s) fall outside parent time bounds`);

  // No negative durations
  const negDur = allSpans.filter(s => s.timestamp < s.start_timestamp).length;
  if (negDur > 0) timingIssues.push(`${negDur} span(s) have negative duration (end < start)`);

  // No zero-duration I/O spans
  const ioOps = ['http.client', 'http.server', 'db', 'cache'];
  const zeroDurIo = allSpans.filter(s =>
    ioOps.some(prefix => s.op.startsWith(prefix)) &&
    Math.abs(s.timestamp - s.start_timestamp) < 0.001
  ).length;
  if (zeroDurIo > 0) timingIssues.push(`${zeroDurIo} I/O span(s) report near-zero duration (timestamps not captured correctly)`);

  // Clock skew: http.client end should not be after http.server end (gross skew)
  const clientSpans = allSpans.filter(s => s.op === 'http.client');
  let skewCount = 0;
  for (const cs of clientSpans) {
    if (!cs.parent_span_id) continue;
    // Find server span whose parent is this client span
    const serverSpan = allSpans.find(s => s.op === 'http.server' && s.parent_span_id === cs.span_id);
    if (serverSpan && serverSpan.timestamp > cs.timestamp + 0.5) skewCount++;
  }
  if (skewCount > 0) timingIssues.push(`${skewCount} http.server span(s) end significantly after their http.client parent (clock skew or instrumentation bug)`);

  const spanTiming: CriteriaCheck = {
    pass: timingIssues.length === 0,
    details: timingIssues.length === 0 ? 'All span timestamps valid' : timingIssues.join('; '),
    issues: timingIssues,
  };

  // ── NEW Criterion 7: Span naming conventions ─────────────────────────────
  const namingIssues: string[] = [];

  // Helper: a span is auto-instrumented if its origin contains 'auto'.
  // origin is a top-level field on CapturedSpan, captured directly from the Sentry envelope.
  // Examples: 'auto.http.browser', 'auto.http.node', 'auto.db', 'manual'
  const isAutoSpan = (s: any): boolean => (s.origin || '').includes('auto');

  // Only validate custom spans for non-standard ops — SDK-generated spans use their own op vocabulary
  const customSpans = allSpans.filter(s => !isAutoSpan(s));

  const badOps = customSpans.filter(s => {
    const op = (s.op || '').toLowerCase();
    return op !== 'unknown' && !VALID_OPS.has(op)
      && !op.startsWith('db.') && !op.startsWith('cache.')
      && !op.startsWith('ui.') && !op.startsWith('http.')
      && !op.startsWith('browser.')
      && !op.startsWith('resource.') // browser Resource Timing API spans (link, script, img, xhr, fetch)
      && op !== 'paint'; // First Paint / First Contentful Paint — browser Performance API
  });
  if (badOps.length > 0) {
    const uniq = [...new Set(badOps.map(s => s.op))].slice(0, 3);
    namingIssues.push(`Non-standard op values (use Sentry semantic conventions): ${uniq.join(', ')}`);
  }

  // UUIDs or high-cardinality numeric IDs — only check custom spans
  const highCardSpans = customSpans.filter(s =>
    UUID_RE.test(s.description || '') || NUMERIC_SEGMENT_RE.test(s.description || '')
  );
  if (highCardSpans.length > 0) {
    namingIssues.push(`${highCardSpans.length} span(s) contain raw IDs in description — use parameterized routes (e.g. /users/:id)`);
  }

  // HTTP spans must have "METHOD /route" format — only check custom spans
  const httpSpans = allSpans.filter(s => (s.op === 'http.client' || s.op === 'http.server') && !isAutoSpan(s));
  const badHttpDesc = httpSpans.filter(s => !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//i.test(s.description || ''));
  if (badHttpDesc.length > 0) {
    namingIssues.push(`${badHttpDesc.length} HTTP span(s) missing "METHOD /route" format in description (e.g. "GET /api/users")`);
  }

  // No "GET /" or "POST /" on http.server — only check custom spans
  const rootRouteSpans = allSpans.filter(s =>
    s.op === 'http.server' && !isAutoSpan(s) && /^(GET|POST|PUT|PATCH|DELETE)\s+\/$/.test(s.description || '')
  );
  if (rootRouteSpans.length > 0) {
    namingIssues.push(`${rootRouteSpans.length} backend span(s) named "METHOD /" — Express route prefix not propagated to Sentry transaction name`);
  }

  const spanNaming: CriteriaCheck = {
    pass: namingIssues.length === 0,
    details: namingIssues.length === 0 ? 'All span names follow Sentry conventions' : namingIssues.join('; '),
    issues: namingIssues,
  };

  // ── NEW Criterion 8: Attribute completeness ───────────────────────────────
  const attrIssues: string[] = [];

  // Only validate custom (manually-instrumented) spans — auto spans are the SDK's responsibility
  const customHttpSpans = allSpans.filter(s =>
    (s.op === 'http.client' || s.op === 'http.server') && !isAutoSpan(s)
  );

  // Custom HTTP spans should carry http.status_code
  const httpWithNoStatus = customHttpSpans.filter(s =>
    !s.data?.['http.status_code'] && !s.data?.['http.response.status_code'] && !s.data?.['http.request.method']
  );
  if (httpWithNoStatus.length > 0) {
    attrIssues.push(`${httpWithNoStatus.length} HTTP span(s) missing http.status_code — add it via span.setAttributes({ 'http.status_code': res.statusCode })`);
  }

  // Custom DB spans should have db.system
  const dbSpans = allSpans.filter(s => s.op.startsWith('db') && !isAutoSpan(s));
  const dbWithNoSystem = dbSpans.filter(s => !s.data?.['db.system']);
  if (dbSpans.length > 0 && dbWithNoSystem.length > 0) {
    attrIssues.push(`${dbWithNoSystem.length} DB span(s) missing db.system attribute (e.g. 'postgresql', 'mysql', 'sqlite')`);
  }

  // Custom DB spans should have a sanitized db.statement or db.operation
  const dbWithNoStmt = dbSpans.filter(s => !s.data?.['db.statement'] && !s.data?.['db.operation'] && !s.data?.['db.name']);
  if (dbSpans.length > 0 && dbWithNoStmt.length > 0) {
    attrIssues.push(`${dbWithNoStmt.length} DB span(s) missing db.statement / db.operation`);
  }

  // Custom http.server spans should have server.address or http.host
  const serverWithNoHost = allSpans.filter(s =>
    s.op === 'http.server' && !isAutoSpan(s) &&
    !s.data?.['server.address'] && !s.data?.['http.host'] && !s.data?.['net.host.name']
  );
  if (serverWithNoHost.length > 0) {
    attrIssues.push(`${serverWithNoHost.length} http.server span(s) missing server.address / http.host attribute`);
  }

  const attributeCompleteness: CriteriaCheck = {
    pass: attrIssues.length === 0,
    details: attrIssues.length === 0 ? 'All required span attributes present' : attrIssues.join('; '),
    issues: attrIssues,
  };

  // ── NEW Criterion 9: Transaction completeness ─────────────────────────────
  const txIssues: string[] = [];

  // At least one pageload or navigation transaction must exist
  const hasFeTx = allTx.some(tx => tx.op === 'pageload' || tx.op === 'navigation');
  if (!hasFeTx) {
    txIssues.push('No pageload or navigation transaction found — frontend Sentry SDK not initializing correctly');
  }

  // pageload vs navigation: initial load should use pageload, client-side transitions navigation
  const allNavOps = allTx.map(tx => tx.op);
  const hasOnlyNavigation = allNavOps.every(op => op === 'navigation') && allNavOps.length > 0;
  if (hasOnlyNavigation) {
    txIssues.push('All transactions use "navigation" op — at least one initial "pageload" transaction is expected for hard loads');
  }

  // No dangling transactions (end_timestamp must be > start_timestamp by at least 1ms)
  const danglingTx = allTx.filter(tx => tx.timestamp <= tx.start_timestamp + 0.001 && tx.timestamp > 0);
  if (danglingTx.length > 0) {
    txIssues.push(`${danglingTx.length} transaction(s) appear unfinished (end_timestamp ≈ start_timestamp)`);
  }

  // Transaction names must not contain raw UUIDs or numeric IDs (high cardinality)
  const highCardTx = allTx.filter(tx => UUID_RE.test(tx.transaction) || NUMERIC_SEGMENT_RE.test(tx.transaction));
  if (highCardTx.length > 0) {
    txIssues.push(`${highCardTx.length} transaction(s) have dynamic values in name — use parameterized routes: e.g. "/products/[id]" not "/products/abc-123"`);
  }

  // Next.js API routes should produce http.server transactions, not pageload
  const apiAsPageload = allTx.filter(tx =>
    (tx.op === 'pageload' || tx.op === 'navigation') && tx.transaction.startsWith('/api/')
  );
  if (apiAsPageload.length > 0) {
    txIssues.push(`${apiAsPageload.length} /api/* route(s) captured as pageload/navigation — they should produce http.server transactions`);
  }

  // Sampling consistency: if FE has transactions with no corresponding BE, flag it
  const feTxWithBe = traces.filter(t => {
    const hasFeRoot = t.allSpans.some(s => s.op === 'pageload' || s.op === 'navigation');
    const hasBe = t.allSpans.some(s => s.op === 'http.server');
    return hasFeRoot && !hasBe;
  });
  if (feTxWithBe.length > 0 && traces.length > 1) {
    txIssues.push(`${feTxWithBe.length} FE trace(s) have no corresponding BE transaction — possible sampling mismatch or missing sentry-trace header propagation`);
  }

  const transactionCompleteness: CriteriaCheck = {
    pass: txIssues.length === 0,
    details: txIssues.length === 0 ? 'All transactions correctly structured' : txIssues.join('; '),
    issues: txIssues,
  };

  return {
    noOrphanSpans, feBeConnected, customSpansCovered, widgetDataMatched, noRootSpanGaps,
    spanTiming, spanNaming, attributeCompleteness, transactionCompleteness,
  };
}

function criteriaToScore(c: CriteriaResult): number {
  let score = 100;
  // Core trace connectivity (55 pts)
  if (!c.noOrphanSpans.pass) score -= 20;
  if (!c.feBeConnected.pass) score -= 15;
  if (!c.customSpansCovered.pass) score -= 15;
  if (!c.noRootSpanGaps.pass) score -= 5;
  // New: Data quality (35 pts)
  if (!c.spanTiming.pass) score -= 10;
  if (!c.spanNaming.pass) score -= 10;
  if (!c.attributeCompleteness.pass) score -= 10;
  if (!c.transactionCompleteness.pass) score -= 5;
  // Widget queries (10 pts)
  if (!c.widgetDataMatched.pass) score -= 10;
  return Math.max(0, score);
}

function scoreToGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

// ---------------------------------------------------------------------------
// Training Runner Service
// ---------------------------------------------------------------------------

export class TrainingRunnerService {
  private storage: StorageService;
  private llmService: LLMService;
  private generatorService: GeneratorService;
  private liveDataGen: LiveDataGeneratorService;
  private traceIngest: TraceIngestService;
  private rulesBank: RulesBankService;
  private running = false;
  private stopRequested = false;

  constructor(
    storage: StorageService,
    llmService: LLMService,
    generatorService: GeneratorService,
    liveDataGen: LiveDataGeneratorService,
    traceIngest: TraceIngestService,
    rulesBank: RulesBankService
  ) {
    this.storage = storage;
    this.llmService = llmService;
    this.generatorService = generatorService;
    this.liveDataGen = liveDataGen;
    this.traceIngest = traceIngest;
    this.rulesBank = rulesBank;
  }

  isRunning(): boolean { return this.running; }
  stop(): void { this.stopRequested = true; }

  async runTraining(
    config: TrainingRunConfig,
    onLog: (msg: string) => void,
    onSpecResult: (result: TrainingRunResult) => void,
    onComplete: (results: TrainingRunResult[]) => void
  ): Promise<void> {
    if (this.running) {
      onLog('⚠️ Training already in progress\n');
      return;
    }
    this.running = true;
    this.stopRequested = false;

    // Wrap callbacks so a destroyed renderer window never crashes the training loop
    const safeLog = (msg: string) => { try { onLog(msg); } catch {} };
    const safeResult = (r: TrainingRunResult) => { try { onSpecResult(r); } catch {} };
    const finish = (results: TrainingRunResult[]) => {
      this.running = false;
      try { onComplete(results); } catch {}
    };

    const { specs, maxIterationsPerSpec = 3, minPassScore = 80, localIngestPort = 9999 } = config;
    const localDsn = `http://localingest@127.0.0.1:${localIngestPort}/0`;
    const results: TrainingRunResult[] = [];

    // Ensure ingest server is running
    if (!this.traceIngest.isRunning()) {
      try {
        await this.traceIngest.start();
        safeLog(`🟢 Local ingest server started on port ${localIngestPort}\n`);
      } catch (e: any) {
        safeLog(`❌ Failed to start local ingest: ${e.message}\n`);
        finish(results);
        return;
      }
    }

    // Clean up leftover training projects from previous interrupted runs
    try {
      const allProjects = this.storage.listProjects();
      const stale = allProjects.filter(p => p.project.slug.startsWith('training-'));
      for (const p of stale) {
        try { await this.storage.deleteProject(p.id); } catch {}
      }
      if (stale.length > 0) safeLog(`🧹 Cleaned up ${stale.length} leftover training project(s)\n`);
    } catch {}

    safeLog(`\n🏋️  Training run started — ${specs.length} spec(s), max ${maxIterationsPerSpec} iterations each\n`);
    safeLog(`📡 Local DSN: ${localDsn}\n\n`);

    // Outer try/finally guarantees finish() is ALWAYS called, even on unhandled exceptions
    try {
    for (let specIdx = 0; specIdx < specs.length; specIdx++) {
      if (this.stopRequested) {
        safeLog('\n⏹️ Training stopped by user\n');
        break;
      }

      const spec = specs[specIdx];
      const startMs = Date.now();
      safeLog(`\n${'─'.repeat(60)}\n`);
      safeLog(`[${specIdx + 1}/${specs.length}] ${spec.name} (${spec.vertical})\n`);
      safeLog(`${'─'.repeat(60)}\n`);

      let projectId: string | null = null;
      let finalCriteria: CriteriaResult | null = null;
      let finalScore = 0;
      let finalGrade = 'F';
      let iterationsRun = 0;
      const rulesExtracted: string[] = [];
      let specError: string | undefined;

      try {
        // --- Create temporary project ---
        safeLog(`\n📋 Creating project spec...\n`);
        const project = await this.createProjectFromTrainingSpec(spec);
        projectId = project.id;
        safeLog(`   ✓ Project created: ${project.id}\n`);

        // --- Generate reference app ---
        safeLog(`\n🏗️  Generating reference app...\n`);
        const genResult = await this.generatorService.generateReferenceApp(project);
        if (!genResult.success) {
          throw new Error(`App generation failed: ${genResult.error}`);
        }
        safeLog(`   ✓ Reference app generated at ${genResult.outputPath}\n`);

        // --- Iteration loop ---
        for (let iter = 1; iter <= maxIterationsPerSpec; iter++) {
          if (this.stopRequested) break;
          iterationsRun = iter;
          safeLog(`\n🔁 Iteration ${iter}/${maxIterationsPerSpec}\n`);

          // Clear previous traces
          this.traceIngest.clear();

          // If the shared data generator is stuck from a previous run, force-stop it first
          if (this.liveDataGen.getIsRunning()) {
            safeLog(`   ⚠️ Data gen still running — stopping before iteration...\n`);
            await this.liveDataGen.stop();
            await sleep(1000);
          }

          safeLog(`   ▶ Running live data generator...\n`);

          // Timeout wrapper — kill the data gen run if it hangs for more than 20 minutes
          const dataGenResult = await Promise.race([
            this.liveDataGen.runLiveDataGenerator(
              projectId!,
              { frontendDsn: localDsn, backendDsn: localDsn, numTraces: 5, numErrors: 1, environment: 'training' },
              (out) => { if (out.trim()) safeLog(`     ${out.trimEnd()}\n`); },
              (err) => { safeLog(`     ⚠️ ${err.trimEnd()}\n`); }
            ),
            sleep(20 * 60 * 1000).then(() => ({ success: false, error: 'Timed out after 20 minutes' })),
          ]);

          if (!dataGenResult.success) {
            safeLog(`   ⚠️ Data gen issue: ${dataGenResult.error}\n`);
            // Force-stop in case it's still running after timeout
            if (this.liveDataGen.getIsRunning()) await this.liveDataGen.stop();
          }

          // Wait for traces to flush to local ingest
          await sleep(4000);

          // Collect traces
          const traces = this.traceIngest.getTraces();
          safeLog(`   📊 Captured ${traces.length} trace(s)\n`);

          // Validate
          const currentProject = this.storage.getProject(projectId!);
          finalCriteria = validateCriteria(traces, spec);
          finalScore = criteriaToScore(finalCriteria);
          finalGrade = scoreToGrade(finalScore);

          safeLog(`   Score: ${finalScore}/100 (${finalGrade})\n`);
          safeLog(this.formatCriteriaLog(finalCriteria));

          if (finalScore >= minPassScore) {
            safeLog(`   ✅ Passed threshold (${minPassScore}) — moving on\n`);
            break;
          }

          if (iter < maxIterationsPerSpec) {
            // ── Extract rules NOW, before regeneration ────────────────────────
            // Rules are written to the JSON file immediately, so the next call to
            // generateReferenceApp (inside applyFixes) will pick them up via
            // getRulesForPrompt(). This is the core feedback loop that improves
            // scores within a spec's own iterations.
            if (traces.length > 0) {
              safeLog(`   📖 Extracting rules before next iteration...\n`);
              const newRules = await this.extractRules(spec, finalCriteria, traces, safeLog);
              for (const id of newRules) {
                if (!rulesExtracted.includes(id)) rulesExtracted.push(id);
              }
            }
            safeLog(`   🔧 Applying fixes for iteration ${iter + 1} (rules bank: ${this.rulesBank.listRules().length} rules)...\n`);
            await this.applyFixes(projectId!, finalCriteria, traces, safeLog);
          }
        }

        // Final rule extraction pass for the last iteration (may find new rules if score still low)
        const finalTraces = this.traceIngest.getTraces();
        const hasRealTraces = finalTraces.length > 0;
        if (finalCriteria && finalScore < minPassScore && hasRealTraces) {
          safeLog(`\n📖 Final rule extraction (score ${finalScore} below threshold)...\n`);
          const extracted = await this.extractRules(spec, finalCriteria, finalTraces, safeLog);
          for (const id of extracted) {
            if (!rulesExtracted.includes(id)) rulesExtracted.push(id);
          }
        } else if (finalCriteria && finalScore < minPassScore && !hasRealTraces) {
          safeLog(`\n⚠️ No traces captured — skipping rule extraction (app generation failed, not a trace quality issue)\n`);
        }

      } catch (err: any) {
        specError = err.message || String(err);
        safeLog(`\n❌ Spec failed with error: ${specError}\n`);
        // Only extract rules if we had actual trace data showing quality issues
        const partialTraces = this.traceIngest.getTraces();
        if (finalCriteria && partialTraces.length > 0) {
          safeLog(`📖 Extracting rules from partial results...\n`);
          try {
            const extracted = await this.extractRules(spec, finalCriteria, partialTraces, safeLog);
            for (const id of extracted) {
              if (!rulesExtracted.includes(id)) rulesExtracted.push(id);
            }
          } catch (ruleErr) {
            safeLog(`   ⚠️ Rule extraction also failed: ${ruleErr}\n`);
          }
        }
      } finally {
        // Always clean up the project entry from storage
        if (projectId) {
          try { await this.storage.deleteProject(projectId); } catch {}
        }
      }

      const result: TrainingRunResult = {
        specSlug: spec.slug,
        specName: spec.name,
        iterations: iterationsRun,
        finalScore,
        finalGrade,
        criteria: finalCriteria || {
          noOrphanSpans: { pass: false, details: 'Not run' },
          feBeConnected: { pass: false, details: 'Not run' },
          customSpansCovered: { pass: false, details: 'Not run', missing: [] },
          widgetDataMatched: { pass: false, details: 'Not run', missingAttrs: [] },
          noRootSpanGaps: { pass: false, details: 'Not run', gapSpans: [] },
          spanTiming: { pass: false, details: 'Not run', issues: [] },
          spanNaming: { pass: false, details: 'Not run', issues: [] },
          attributeCompleteness: { pass: false, details: 'Not run', issues: [] },
          transactionCompleteness: { pass: false, details: 'Not run', issues: [] },
        },
        rulesExtracted,
        durationMs: Date.now() - startMs,
        error: specError,
      };
      results.push(result);
      safeResult(result);

      const status = finalScore >= minPassScore ? '✅ PASS' : '❌ FAIL';
      safeLog(`\n${status} — ${spec.name} — ${finalScore}/100 (${finalGrade}) in ${iterationsRun} iteration(s)\n`);
    }
    } finally {
      // Outer finally — guarantees finish() is always called regardless of what happened
      safeLog(`\n${'═'.repeat(60)}\n`);
      safeLog(`🏁 Training complete — ${results.filter(r => r.finalScore >= minPassScore).length}/${results.length} specs passed\n`);
      safeLog(`📚 Rules bank now has ${this.rulesBank.listRules().length} rule(s)\n`);
      safeLog(`${'═'.repeat(60)}\n`);
      finish(results);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async createProjectFromTrainingSpec(spec: TrainingSpec): Promise<EngagementSpec> {
    const now = new Date().toISOString();
    const project = this.storage.createProject({
      project: {
        name: spec.name,
        slug: spec.slug,
        vertical: spec.vertical,
        notes: spec.description,
        createdAt: now,
        updatedAt: now,
      },
      stack: {
        type: 'web',
        frontend: spec.stack.frontend,
        backend: spec.stack.backend,
      },
      instrumentation: {
        transactions: spec.spans.map(s => s.name.split('.')[0]),
        spans: spec.spans.map(s => ({
          name: s.name,
          op: s.op,
          layer: s.layer,
          description: s.description || `Tracks ${s.name}`,
          attributes: s.attributes || {},
          pii: { keys: [] },
        })),
      },
      dashboard: {
        widgets: spec.dashboardWidgets.map((w, i) => ({
          title: w.title,
          type: 'timeseries' as const,
          query: w.query,
          layout: { x: (i % 2) * 6, y: Math.floor(i / 2) * 4, w: 6, h: 4 },
        })),
      },
    });
    return project;
  }

  private formatCriteriaLog(c: CriteriaResult): string {
    const icon = (p: boolean) => p ? '✅' : '❌';
    return [
      `     ${icon(c.noOrphanSpans.pass)} No orphan spans: ${c.noOrphanSpans.details}\n`,
      `     ${icon(c.feBeConnected.pass)} FE→BE connected: ${c.feBeConnected.details}\n`,
      `     ${icon(c.customSpansCovered.pass)} Custom span coverage: ${c.customSpansCovered.details}\n`,
      `     ${icon(c.noRootSpanGaps.pass)} No span gaps: ${c.noRootSpanGaps.details}\n`,
      `     ${icon(c.spanTiming.pass)} Span timing: ${c.spanTiming.details}\n`,
      `     ${icon(c.spanNaming.pass)} Span naming: ${c.spanNaming.details}\n`,
      `     ${icon(c.attributeCompleteness.pass)} Attribute completeness: ${c.attributeCompleteness.details}\n`,
      `     ${icon(c.transactionCompleteness.pass)} Transaction structure: ${c.transactionCompleteness.details}\n`,
      `     ${icon(c.widgetDataMatched.pass)} Widget data: ${c.widgetDataMatched.details}\n`,
    ].join('');
  }

  private async applyFixes(
    projectId: string,
    criteria: CriteriaResult,
    traces: CapturedTrace[],
    onLog: (msg: string) => void
  ): Promise<void> {
    // Always re-read project from storage — fixWidgetQueries may have patched it already
    const project = this.storage.getProject(projectId);
    let regenReason: string | null = null;

    // Fix 1: Orphan spans / FE-BE disconnect
    if (!criteria.noOrphanSpans.pass || !criteria.feBeConnected.pass) {
      regenReason = 'orphan spans / FE-BE disconnect';
    }

    // Fix 2: Custom span coverage — bust cached flows so generateIntelligentFlows re-runs
    if (!criteria.customSpansCovered.pass && criteria.customSpansCovered.missing.length > 0) {
      onLog(`     🔧 Missing spans: ${criteria.customSpansCovered.missing.join(', ')} — busting flow cache\n`);
      try {
        const outputPath = this.storage.getOutputPath(projectId);
        const flowsPath = path.join(outputPath, 'user-flows.json');
        if (fs.existsSync(flowsPath)) fs.unlinkSync(flowsPath);
      } catch {}
      regenReason = regenReason || 'custom span coverage gaps';
    }

    // Fix 3: Widget data — patch widget queries directly in storage (no regen needed for this alone)
    if (!criteria.widgetDataMatched.pass && criteria.widgetDataMatched.missingAttrs.length > 0) {
      onLog(`     🔧 Patching widget queries — missing attrs: ${criteria.widgetDataMatched.missingAttrs.join(', ')}\n`);
      try {
        await this.fixWidgetQueries(projectId, traces, criteria.widgetDataMatched.missingAttrs, onLog);
      } catch (e: any) {
        onLog(`     ⚠️ Widget fix failed: ${e.message}\n`);
      }
    }

    // Fix 4: All other instrumentation issues require full app regeneration
    if (!criteria.spanTiming.pass) regenReason = regenReason || `span timing: ${criteria.spanTiming.issues[0]}`;
    if (!criteria.spanNaming.pass) regenReason = regenReason || `span naming: ${criteria.spanNaming.issues[0]}`;
    if (!criteria.attributeCompleteness.pass) regenReason = regenReason || `missing attributes: ${criteria.attributeCompleteness.issues[0]}`;
    if (!criteria.transactionCompleteness.pass) regenReason = regenReason || `transaction structure: ${criteria.transactionCompleteness.issues[0]}`;
    if (!criteria.noRootSpanGaps.pass) regenReason = regenReason || 'span duration gaps';

    // Single regeneration call — rules bank already has new rules from extractRules called just
    // before this, so getRulesForPrompt() will inject them into the regenerated code
    if (regenReason) {
      // Re-read project AGAIN in case fixWidgetQueries just updated it
      const freshProject = this.storage.getProject(projectId);
      onLog(`     🔧 Regenerating app with ${this.rulesBank.listRules().length} rules (${regenReason})...\n`);
      try {
        await this.generatorService.generateReferenceApp(freshProject);
        onLog(`     ✓ App regenerated\n`);
      } catch (e: any) {
        onLog(`     ⚠️ Regen failed: ${e.message}\n`);
      }
    }
  }

  private async fixWidgetQueries(
    projectId: string,
    traces: CapturedTrace[],
    missingAttrs: string[],
    onLog: (msg: string) => void
  ): Promise<void> {
    const allDataKeys = new Set<string>(
      traces.flatMap(t => t.allSpans.flatMap(s => Object.keys(s.data || {})))
    );
    const allOps = new Set<string>(traces.flatMap(t => t.allSpans.map(s => s.op)));

    // For each dashboard widget, replace missing attribute references with known ones
    const updatedProject = this.storage.getProject(projectId);
    let changed = false;
    const updatedWidgets = updatedProject.dashboard.widgets.map(w => {
      let query = w.query;
      for (const missing of missingAttrs) {
        if (query.includes(missing)) {
          // Replace with a known attribute (success is always set)
          if (missing.includes('error') || missing.includes('status')) {
            query = query.replace(new RegExp(`${missing}:[^\\s]+`, 'g'), 'success:false');
          } else {
            query = query.replace(new RegExp(`${missing}:[^\\s]+`, 'g'), 'success:true');
          }
          changed = true;
        }
      }
      return { ...w, query };
    });

    if (changed) {
      this.storage.updateProject(projectId, { dashboard: { widgets: updatedWidgets } });
      onLog(`     ✓ Widget queries patched\n`);
    }
  }

  private async extractRules(
    spec: TrainingSpec,
    criteria: CriteriaResult,
    traces: CapturedTrace[],
    onLog: (msg: string) => void
  ): Promise<string[]> {
    const extracted: string[] = [];

    if (!criteria.noOrphanSpans.pass) {
      const rule = this.rulesBank.addRule({
        category: 'orphan_spans',
        title: 'No direct api_call steps after page navigation',
        rule: 'Never add api_call steps that fire after waitUntil:networkidle2. Instead, let page navigation trigger backend calls naturally within the active pageload transaction. Direct api_call steps after full page load cause orphan spans because the pageload transaction has already closed.',
        discoveredFrom: spec.slug,
        applyTo: ['flows'],
      });
      extracted.push(rule.id);
      onLog(`   📖 Rule added: ${rule.title}\n`);
    }

    if (!criteria.feBeConnected.pass) {
      const rule = this.rulesBank.addRule({
        category: 'fe_be_connection',
        title: 'Every Express route must use Sentry.continueTrace',
        rule: 'Every Express route handler MUST wrap its logic in Sentry.continueTrace({ sentryTrace: req.headers["sentry-trace"], baggage: req.headers["baggage"] }, async () => { ... }). Without this, backend spans appear as disconnected root transactions in Sentry instead of children of the frontend trace.',
        discoveredFrom: spec.slug,
        applyTo: ['generation'],
      });
      extracted.push(rule.id);
      onLog(`   📖 Rule added: ${rule.title}\n`);
    }

    if (!criteria.customSpansCovered.pass && criteria.customSpansCovered.missing.length > 0) {
      const rule = this.rulesBank.addRule({
        category: 'custom_spans',
        title: 'Generate flows that explicitly trigger each custom span',
        rule: `Each custom span in the spec MUST be triggered by at least one user flow. Do not assume a span will be called during normal page load — create explicit flows that navigate to the page and interact with the UI to trigger the span. Spans that are commonly missed: ${criteria.customSpansCovered.missing.slice(0, 3).join(', ')}.`,
        discoveredFrom: spec.slug,
        applyTo: ['flows'],
      });
      extracted.push(rule.id);
      onLog(`   📖 Rule added: ${rule.title}\n`);
    }

    if (!criteria.widgetDataMatched.pass && criteria.widgetDataMatched.missingAttrs.length > 0) {
      const rule = this.rulesBank.addRule({
        category: 'widget_data',
        title: 'Dashboard widget queries must only reference emitted span attributes',
        rule: `Widget query conditions must only reference CUSTOM attributes that are explicitly set via span.setAttributes() in the generated code. The following custom attribute keys were referenced in widget queries but not found in any captured span's data: ${criteria.widgetDataMatched.missingAttrs.slice(0, 3).join(', ')}. Sentry native fields like span.op, success, error, http.status_code are always available. Never reference custom attributes in widget queries unless the span explicitly calls setAttributes({ key: value }).`,
        discoveredFrom: spec.slug,
        applyTo: ['dashboard'],
      });
      extracted.push(rule.id);
      onLog(`   📖 Rule added: ${rule.title}\n`);
    }

    if (!criteria.noRootSpanGaps.pass && criteria.noRootSpanGaps.gapSpans.length > 0) {
      const rule = this.rulesBank.addRule({
        category: 'span_gaps',
        title: 'Parent span duration must be accounted for by child spans',
        rule: `When a parent span (e.g. ${criteria.noRootSpanGaps.gapSpans[0]}) has a much longer duration than the sum of its children, add intermediate child spans to cover the gap. Common causes: database connection setup, external API wait times, serialization. Always wrap these in Sentry.startSpan().`,
        discoveredFrom: spec.slug,
        applyTo: ['generation', 'instrumentation'],
      });
      extracted.push(rule.id);
      onLog(`   📖 Rule added: ${rule.title}\n`);
    }

    if (!criteria.spanTiming.pass && criteria.spanTiming.issues.length > 0) {
      const issue = criteria.spanTiming.issues[0];
      if (issue.includes('negative duration')) {
        const rule = this.rulesBank.addRule({
          category: 'span_timing',
          title: 'Capture timestamps before and after async operations',
          rule: 'Spans must capture start_timestamp before the async operation begins and end the span only after the operation resolves. Never compute timestamps from Date.now() after an await — the span end is always called automatically by Sentry.startSpan() when the callback returns. Negative durations mean the span was ended before it started.',
          discoveredFrom: spec.slug,
          applyTo: ['generation', 'instrumentation'],
        });
        extracted.push(rule.id);
        onLog(`   📖 Rule added: ${rule.title}\n`);
      }
      if (issue.includes('outside parent')) {
        const rule = this.rulesBank.addRule({
          category: 'span_timing',
          title: 'Child spans must be created inside the parent Sentry.startSpan callback',
          rule: 'Every child span must be started inside the parent span\'s callback closure, never after awaiting the parent. Correct pattern: Sentry.startSpan({ name: "parent" }, async () => { await Sentry.startSpan({ name: "child" }, ...) }). Creating spans outside their parent\'s callback causes child timestamps to fall outside parent time bounds.',
          discoveredFrom: spec.slug,
          applyTo: ['generation', 'instrumentation'],
        });
        extracted.push(rule.id);
        onLog(`   📖 Rule added: ${rule.title}\n`);
      }
      if (issue.includes('zero duration')) {
        const rule = this.rulesBank.addRule({
          category: 'span_timing',
          title: 'I/O spans must wrap the actual async operation',
          rule: 'DB, HTTP, and cache spans must wrap the actual async call inside their callback so Sentry records real latency. Zero-duration I/O spans mean the span was created but the operation was not awaited inside it. Example: await Sentry.startSpan({ op: "db.query" }, async () => { return await db.query(...) })',
          discoveredFrom: spec.slug,
          applyTo: ['generation', 'instrumentation'],
        });
        extracted.push(rule.id);
        onLog(`   📖 Rule added: ${rule.title}\n`);
      }
    }

    if (!criteria.spanNaming.pass && criteria.spanNaming.issues.length > 0) {
      if (criteria.spanNaming.issues.some(i => i.includes('METHOD'))) {
        const rule = this.rulesBank.addRule({
          category: 'span_naming',
          title: 'HTTP spans must use "METHOD /parameterized-route" format in description',
          rule: 'All http.client and http.server span descriptions must follow the format "GET /api/users/:id" — the HTTP method followed by a parameterized route pattern. Never use the resolved URL with actual IDs. The Sentry Express integration captures this automatically via expressIntegration(); for manual http.client spans set the description explicitly.',
          discoveredFrom: spec.slug,
          applyTo: ['generation', 'instrumentation'],
        });
        extracted.push(rule.id);
        onLog(`   📖 Rule added: ${rule.title}\n`);
      }
      if (criteria.spanNaming.issues.some(i => i.includes('raw IDs'))) {
        const rule = this.rulesBank.addRule({
          category: 'span_naming',
          title: 'Never include dynamic values (IDs, UUIDs) in span names or descriptions',
          rule: 'Span descriptions must use parameterized patterns, not resolved values. Use "/products/:id" not "/products/abc-123-xyz". High-cardinality span names create thousands of unique entries in Sentry and make dashboards unusable. Use span attributes (setAttributes) to record the actual ID value instead.',
          discoveredFrom: spec.slug,
          applyTo: ['generation', 'instrumentation'],
        });
        extracted.push(rule.id);
        onLog(`   📖 Rule added: ${rule.title}\n`);
      }
      if (criteria.spanNaming.issues.some(i => i.includes('prefix'))) {
        const rule = this.rulesBank.addRule({
          category: 'span_naming',
          title: 'Register Express routes with full /api/ prefix to get correct transaction names',
          rule: 'Express routes must be registered at the app level with the full path (app.get("/api/users", ...)) not via a sub-router mounted at "/api" with bare paths ("/users"). The Sentry Express integration captures the mounted path as the transaction name — using app.use("/api", router) with router.get("/users") results in "GET /" transaction names instead of "GET /api/users".',
          discoveredFrom: spec.slug,
          applyTo: ['generation'],
        });
        extracted.push(rule.id);
        onLog(`   📖 Rule added: ${rule.title}\n`);
      }
      if (criteria.spanNaming.issues.some(i => i.includes('Non-standard op'))) {
        const rule = this.rulesBank.addRule({
          category: 'span_naming',
          title: 'Span op values must follow Sentry semantic conventions',
          rule: 'The "op" field of every span must use a Sentry semantic convention value: http.client, http.server, db, db.query, cache.get, cache.set, ui.render, function, task, rpc, graphql. Custom op values like "api-call", "database", or "render" break Sentry\'s built-in dashboards and performance views.',
          discoveredFrom: spec.slug,
          applyTo: ['generation', 'instrumentation'],
        });
        extracted.push(rule.id);
        onLog(`   📖 Rule added: ${rule.title}\n`);
      }
    }

    if (!criteria.attributeCompleteness.pass && criteria.attributeCompleteness.issues.length > 0) {
      if (criteria.attributeCompleteness.issues.some(i => i.includes('http.status_code'))) {
        const rule = this.rulesBank.addRule({
          category: 'attribute_completeness',
          title: 'Every HTTP span must include http.status_code',
          rule: 'Both http.client and http.server spans must set http.status_code so traces can be filtered by 2xx/4xx/5xx in Sentry. For Express: span.setAttributes({ "http.status_code": res.statusCode, "http.method": req.method, "http.route": req.route?.path }). For fetch() on the frontend: span.setAttributes({ "http.status_code": response.status }). The Sentry SDK may add this automatically if you use the httpIntegration().',
          discoveredFrom: spec.slug,
          applyTo: ['generation', 'instrumentation'],
        });
        extracted.push(rule.id);
        onLog(`   📖 Rule added: ${rule.title}\n`);
      }
      if (criteria.attributeCompleteness.issues.some(i => i.includes('db.system'))) {
        const rule = this.rulesBank.addRule({
          category: 'attribute_completeness',
          title: 'DB spans must include db.system, db.name, and db.statement',
          rule: 'Every database span must set: db.system (e.g. "postgresql", "mysql", "sqlite", "mongodb"), db.name (database name), and either db.statement (sanitized SQL) or db.operation (e.g. "SELECT", "INSERT"). Without these, Sentry\'s Queries view cannot identify which database or query is slow.',
          discoveredFrom: spec.slug,
          applyTo: ['generation', 'instrumentation'],
        });
        extracted.push(rule.id);
        onLog(`   📖 Rule added: ${rule.title}\n`);
      }
    }

    if (!criteria.transactionCompleteness.pass && criteria.transactionCompleteness.issues.length > 0) {
      if (criteria.transactionCompleteness.issues.some(i => i.includes('pageload'))) {
        const rule = this.rulesBank.addRule({
          category: 'transaction_completeness',
          title: 'Every page must produce a pageload or navigation transaction',
          rule: 'The Sentry Browser SDK must be initialized before React hydrates so it can capture the pageload transaction. Initialize Sentry in _app.tsx or layout.tsx with browserTracingIntegration() enabled. Hard page loads produce "pageload" op; client-side navigations produce "navigation" op. If neither appears, the SDK init is missing or deferred.',
          discoveredFrom: spec.slug,
          applyTo: ['generation', 'instrumentation'],
        });
        extracted.push(rule.id);
        onLog(`   📖 Rule added: ${rule.title}\n`);
      }
      if (criteria.transactionCompleteness.issues.some(i => i.includes('parameterized'))) {
        const rule = this.rulesBank.addRule({
          category: 'transaction_completeness',
          title: 'Next.js transactions must use route template names not resolved URLs',
          rule: 'Next.js page transactions must be named by route pattern (/products/[id]) not the resolved URL (/products/abc-123). Configure this via Sentry.withSentryConfig() in next.config.js with tunnelRoute and the correct release. The @sentry/nextjs withSentryServerSideGetProps wrapper automatically normalizes transaction names for SSR routes.',
          discoveredFrom: spec.slug,
          applyTo: ['generation', 'instrumentation'],
        });
        extracted.push(rule.id);
        onLog(`   📖 Rule added: ${rule.title}\n`);
      }
      if (criteria.transactionCompleteness.issues.some(i => i.includes('sampling'))) {
        const rule = this.rulesBank.addRule({
          category: 'transaction_completeness',
          title: 'Backend must honor frontend sampling decision via sentry-trace header',
          rule: 'The backend must NOT make an independent sampling decision. It must read the sentry-trace and baggage headers from the incoming request and use Sentry.continueTrace() to propagate the frontend\'s sampling decision. If tracesSampleRate is set on the backend independently, it may conflict with the frontend rate and produce partial traces.',
          discoveredFrom: spec.slug,
          applyTo: ['generation', 'instrumentation'],
        });
        extracted.push(rule.id);
        onLog(`   📖 Rule added: ${rule.title}\n`);
      }
    }

    // ── LLM-generated rules ────────────────────────────────────────────────
    // The hardcoded rules above cap out at ~9 unique titles. The LLM can generate
    // spec-specific rules with unique titles that accumulate across all specs.
    if (traces.length > 0) {
      try {
        const failingSummary = [
          !criteria.noOrphanSpans.pass && `Orphan spans: ${criteria.noOrphanSpans.details}`,
          !criteria.feBeConnected.pass && `FE→BE: ${criteria.feBeConnected.details}`,
          !criteria.customSpansCovered.pass && `Missing spans: ${criteria.customSpansCovered.missing.slice(0, 4).join(', ')}`,
          !criteria.spanNaming.pass && `Naming: ${criteria.spanNaming.issues.join('; ')}`,
          !criteria.attributeCompleteness.pass && `Attributes: ${criteria.attributeCompleteness.issues.join('; ')}`,
          !criteria.transactionCompleteness.pass && `Transactions: ${criteria.transactionCompleteness.issues.slice(0, 2).join('; ')}`,
          !criteria.spanTiming.pass && `Timing: ${criteria.spanTiming.issues.join('; ')}`,
          !criteria.widgetDataMatched.pass && `Widget attrs: ${criteria.widgetDataMatched.missingAttrs.join(', ')}`,
        ].filter(Boolean).join('\n');

        if (failingSummary) {
          const allSpans = traces.flatMap(t => t.allSpans);
          const spanSamples = allSpans
            .filter(s => s.op !== 'pageload' && s.op !== 'navigation') // skip root tx spans
            .slice(0, 12)
            .map(s => ({ op: s.op, description: s.description, data: s.data, status: s.status }));

          onLog(`   🤖 LLM analyzing ${allSpans.length} spans for specific rules...\n`);
          const llmRules = await this.llmService.generateTrainingRules(
            spec.name, spec.vertical, failingSummary, spanSamples
          );

          for (const r of llmRules) {
            const rule = this.rulesBank.addRule({
              category: r.category as any,
              title: r.title,
              rule: r.rule,
              discoveredFrom: spec.slug,
              applyTo: r.applyTo as any,
            });
            if (!extracted.includes(rule.id)) {
              extracted.push(rule.id);
              onLog(`   🤖 LLM rule: ${rule.title}\n`);
            }
          }
        }
      } catch (e: any) {
        onLog(`   ⚠️ LLM rule generation failed (non-fatal): ${e.message}\n`);
      }
    }

    return extracted;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
