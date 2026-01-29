import fs from 'fs';
import path from 'path';
import { StorageService } from './storage';
import { EngagementSpec, SpanDefinition } from '../../src/types/spec';

export class GeneratorService {
  private storage: StorageService;
  private templatesDir: string;

  constructor(storage: StorageService) {
    this.storage = storage;
    this.templatesDir = path.join(__dirname, '../../../../templates/reference-app');
  }

  async generateReferenceApp(project: EngagementSpec): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      const outputPath = this.storage.getOutputPath(project.id);
      const appPath = path.join(outputPath, 'reference-app');

      // Create app structure based on stack type
      if (project.stack.type === 'backend-only') {
        this.createPythonDirectoryStructure(appPath);
        this.generatePythonBackend(appPath, project);
      } else if (project.stack.type === 'mobile') {
        this.createMobileDirectoryStructure(appPath);
        await this.generateReactNativeApp(appPath, project);
        this.generateBackend(appPath, project); // Express backend
      } else {
        this.createDirectoryStructure(appPath);
        this.generateFrontend(appPath, project);
        this.generateBackend(appPath, project); // Express backend
      }

      // Generate config files (README, etc.)
      this.generateConfigFiles(appPath, project);

      // Save engagement spec
      const specPath = path.join(outputPath, 'engagement-spec.json');
      fs.writeFileSync(specPath, JSON.stringify(project, null, 2));

      // Update project
      this.storage.updateProject(project.id, {
        outputPath: appPath,
        status: 'generated'
      });

      return { success: true, outputPath: appPath };
    } catch (error) {
      console.error('Error generating reference app:', error);
      return { success: false, error: String(error) };
    }
  }

  async generateImplementationGuide(project: EngagementSpec): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      const outputPath = this.storage.getOutputPath(project.id);
      const guidePath = path.join(outputPath, 'IMPLEMENTATION_GUIDE.md');

      const guide = this.buildImplementationGuide(project);
      fs.writeFileSync(guidePath, guide);

      return { success: true, outputPath: guidePath };
    } catch (error) {
      console.error('Error generating implementation guide:', error);
      return { success: false, error: String(error) };
    }
  }

  async generateDashboard(project: EngagementSpec): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      const outputPath = this.storage.getOutputPath(project.id);
      const dashboardPath = path.join(outputPath, 'sentry-dashboard.json');

      const dashboard = this.buildDashboard(project);
      fs.writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2));

      return { success: true, outputPath: dashboardPath };
    } catch (error) {
      console.error('Error generating dashboard:', error);
      return { success: false, error: String(error) };
    }
  }

  async generateDataScript(project: EngagementSpec): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      const outputPath = this.storage.getOutputPath(project.id);
      const scriptPath = path.join(outputPath, 'generate_data.py');

      const script = this.buildDataGenerationScript(project);
      fs.writeFileSync(scriptPath, script);

      // Also create requirements.txt
      const requirementsPath = path.join(outputPath, 'requirements.txt');
      const requirements = `sentry-sdk==1.40.0
faker==22.0.0
requests==2.31.0
python-dotenv==1.0.0
`;
      fs.writeFileSync(requirementsPath, requirements);

      // Create .env.example for DSN configuration
      const envExamplePath = path.join(outputPath, '.env.example');
      const envExample = `# Sentry DSN Configuration
SENTRY_DSN_FRONTEND=your_frontend_dsn_here
SENTRY_DSN_BACKEND=your_backend_dsn_here

# Data Generation Settings
NUM_TRACES=100
NUM_ERRORS=20
`;
      fs.writeFileSync(envExamplePath, envExample);

      return { success: true, outputPath: scriptPath };
    } catch (error) {
      console.error('Error generating data script:', error);
      return { success: false, error: String(error) };
    }
  }

  private createDirectoryStructure(appPath: string): void {
    const dirs = [
      appPath,
      path.join(appPath, 'frontend'),
      path.join(appPath, 'frontend', 'app'),
      path.join(appPath, 'frontend', 'app', 'product'),
      path.join(appPath, 'frontend', 'app', 'product', '[id]'),
      path.join(appPath, 'frontend', 'app', 'cart'),
      path.join(appPath, 'frontend', 'app', 'checkout'),
      path.join(appPath, 'frontend', 'app', 'order'),
      path.join(appPath, 'frontend', 'app', 'order', '[id]'),
      path.join(appPath, 'frontend', 'lib'),
      path.join(appPath, 'backend'),
      path.join(appPath, 'backend', 'src'),
      path.join(appPath, 'backend', 'src', 'routes'),
      path.join(appPath, 'backend', 'src', 'middleware'),
      path.join(appPath, 'backend', 'src', 'utils')
    ];

    dirs.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  private generateFrontend(appPath: string, project: EngagementSpec): void {
    const frontendPath = path.join(appPath, 'frontend');

    // Package.json
    const packageJson = {
      name: `${project.project.slug}-frontend`,
      version: '0.1.0',
      private: true,
      scripts: {
        dev: 'next dev',
        build: 'next build',
        start: 'next start',
        lint: 'next lint'
      },
      dependencies: {
        '@sentry/nextjs': '^7.99.0',
        'next': '^14.1.0',
        'react': '^18.2.0',
        'react-dom': '^18.2.0'
      },
      devDependencies: {
        '@types/node': '^20',
        '@types/react': '^18',
        '@types/react-dom': '^18',
        'typescript': '^5',
        'tailwindcss': '^3.4.0',
        'postcss': '^8.4.33',
        'autoprefixer': '^10.4.16'
      }
    };
    fs.writeFileSync(path.join(frontendPath, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Next.js config
    const nextConfig = `/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
  }
}

module.exports = nextConfig
`;
    fs.writeFileSync(path.join(frontendPath, 'next.config.js'), nextConfig);

    // Tailwind config
    const tailwindConfig = `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
`;
    fs.writeFileSync(path.join(frontendPath, 'tailwind.config.js'), tailwindConfig);

    // PostCSS config
    const postcssConfig = `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
`;
    fs.writeFileSync(path.join(frontendPath, 'postcss.config.js'), postcssConfig);

    // TypeScript config
    const tsConfig = {
      compilerOptions: {
        target: 'ES2020',
        lib: ['dom', 'dom.iterable', 'esnext'],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'preserve',
        incremental: true,
        plugins: [{ name: 'next' }],
        paths: {
          '@/*': ['./*']
        }
      },
      include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
      exclude: ['node_modules']
    };
    fs.writeFileSync(path.join(frontendPath, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));

    // Sentry config
    this.generateSentryConfig(frontendPath, 'frontend', project);

    // Pages
    this.generateFrontendPages(frontendPath, project);

    // Instrumentation
    this.generateFrontendInstrumentation(frontendPath, project);
  }

  private generateBackend(appPath: string, project: EngagementSpec): void {
    const backendPath = path.join(appPath, 'backend');

    // Package.json
    const packageJson = {
      name: `${project.project.slug}-backend`,
      version: '0.1.0',
      private: true,
      scripts: {
        dev: 'tsx watch src/index.ts',
        build: 'tsc',
        start: 'node dist/index.js'
      },
      dependencies: {
        '@sentry/node': '^7.99.0',
        '@sentry/profiling-node': '^7.99.0',
        'express': '^4.18.2',
        'cors': '^2.8.5',
        'dotenv': '^16.3.1'
      },
      devDependencies: {
        '@types/express': '^4.17.21',
        '@types/cors': '^2.8.17',
        '@types/node': '^20.10.6',
        'tsx': '^4.7.0',
        'typescript': '^5.3.3'
      }
    };
    fs.writeFileSync(path.join(backendPath, 'package.json'), JSON.stringify(packageJson, null, 2));

    // TypeScript config
    const tsConfig = {
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        outDir: './dist',
        rootDir: './src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true
      },
      include: ['src/**/*'],
      exclude: ['node_modules']
    };
    fs.writeFileSync(path.join(backendPath, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));

    // Sentry config
    this.generateSentryConfig(backendPath, 'backend', project);

    // Main server file
    this.generateBackendServer(backendPath, project);

    // Routes
    this.generateBackendRoutes(backendPath, project);

    // Sentry instrumentation
    this.generateBackendInstrumentation(backendPath, project);
  }

  private generateSentryConfig(basePath: string, layer: 'frontend' | 'backend', project: EngagementSpec): void {
    const sentryConfigPath = path.join(basePath, 'sentry.config.js');
    
    const config = layer === 'frontend' ? `
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || 'development',
  tracesSampleRate: 1.0,
  debug: false,
  integrations: [
    new Sentry.BrowserTracing(),
  ],
});
` : `
const Sentry = require('@sentry/node');
const { ProfilingIntegration } = require('@sentry/profiling-node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT || 'development',
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
  integrations: [
    new ProfilingIntegration(),
  ],
});

module.exports = Sentry;
`;

    fs.writeFileSync(sentryConfigPath, config);
  }

  private generateFrontendPages(frontendPath: string, project: EngagementSpec): void {
    const appPath = path.join(frontendPath, 'app');

    // Home page with enhanced styling
    const homePage = `import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';

export default function Home() {
  // TODO: Customize this template based on your project requirements
  // See README.md and IMPLEMENTATION_GUIDE.md for details
  
  const products = [
    { id: 1, name: 'Premium Headphones', price: 99.99, image: '🎧', description: 'Wireless noise-cancelling' },
    { id: 2, name: 'Smart Watch', price: 149.99, image: '⌚', description: 'Fitness tracking & notifications' },
    { id: 3, name: 'Laptop Stand', price: 199.99, image: '💻', description: 'Ergonomic aluminum design' },
    { id: 4, name: 'Mechanical Keyboard', price: 129.99, image: '⌨️', description: 'RGB backlit switches' },
    { id: 5, name: 'Wireless Mouse', price: 49.99, image: '🖱️', description: 'High precision sensor' },
    { id: 6, name: 'USB-C Hub', price: 79.99, image: '🔌', description: '7-in-1 multiport adapter' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-purple-600">${project.project.name}</h1>
              <p className="text-sm text-gray-500 mt-1">Sentry-instrumented demo store</p>
            </div>
            <Link href="/cart" className="btn btn-primary flex items-center gap-2">
              🛒 Cart
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center mb-12">
          <h2 className="text-4xl font-bold text-gray-900 mb-4">
            Welcome to Our Store
          </h2>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Discover amazing products with real-time performance monitoring powered by Sentry
          </p>
        </div>

        {/* Products Grid */}
        {/* TODO: Customize product display based on your requirements
            Example: Show bid count, current bid, auction end time, etc. */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {products.map((product) => (
            <Link 
              key={product.id}
              href={\`/product/\${product.id}\`}
              className="card group"
            >
              <div className="p-6">
                <div className="text-6xl mb-4 group-hover:scale-110 transition-transform duration-200">
                  {product.image}
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">
                  {product.name}
                </h3>
                <p className="text-gray-600 text-sm mb-4">
                  {product.description}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-2xl font-bold text-purple-600">
                    \${product.price}
                  </span>
                  <span className="text-sm text-purple-600 font-medium group-hover:translate-x-1 transition-transform">
                    View Details →
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white mt-16 border-t">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <p className="text-center text-gray-500 text-sm">
            © 2024 ${project.project.name} • Powered by Sentry
          </p>
        </div>
      </footer>
    </div>
  );
}
`;
    fs.writeFileSync(path.join(appPath, 'page.tsx'), homePage);

    // Cart page with enhanced styling
    const cartPage = `'use client';
import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useState } from 'react';

export default function Cart() {
  const [items, setItems] = useState([
    { id: 1, name: 'Premium Headphones', price: 99.99, quantity: 1, image: '🎧' },
    { id: 2, name: 'Smart Watch', price: 149.99, quantity: 2, image: '⌚' },
  ]);

  const updateQuantity = (id: number, delta: number) => {
    setItems(items.map(item => 
      item.id === id 
        ? { ...item, quantity: Math.max(0, item.quantity + delta) }
        : item
    ).filter(item => item.quantity > 0));
  };

  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const tax = subtotal * 0.08;
  const total = subtotal + tax;

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <Link href="/" className="text-purple-600 hover:text-purple-700 font-medium">
            ← Back to Store
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">Shopping Cart</h1>
        
        {items.length === 0 ? (
          <div className="bg-white rounded-lg shadow-md p-12 text-center">
            <p className="text-xl text-gray-600 mb-6">Your cart is empty</p>
            <Link href="/" className="btn btn-primary">
              Continue Shopping
            </Link>
          </div>
        ) : (
          <div className="grid gap-8 lg:grid-cols-3">
            {/* Cart Items */}
            <div className="lg:col-span-2 space-y-4">
              {items.map(item => (
                <div key={item.id} className="card">
                  <div className="p-6 flex items-center gap-6">
                    <div className="text-5xl">{item.image}</div>
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-gray-900 mb-1">
                        {item.name}
                      </h3>
                      <p className="text-2xl font-bold text-purple-600">
                        \${item.price.toFixed(2)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => updateQuantity(item.id, -1)}
                        className="w-8 h-8 rounded-full bg-gray-200 hover:bg-gray-300 flex items-center justify-center"
                      >
                        −
                      </button>
                      <span className="text-lg font-semibold w-8 text-center">
                        {item.quantity}
                      </span>
                      <button
                        onClick={() => updateQuantity(item.id, 1)}
                        className="w-8 h-8 rounded-full bg-purple-600 hover:bg-purple-700 text-white flex items-center justify-center"
                      >
                        +
                      </button>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-gray-500 mb-1">Subtotal</p>
                      <p className="text-xl font-bold text-gray-900">
                        \${(item.price * item.quantity).toFixed(2)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Order Summary */}
            <div className="lg:col-span-1">
              <div className="card sticky top-8">
                <div className="p-6">
                  <h2 className="text-xl font-bold text-gray-900 mb-6">Order Summary</h2>
                  
                  <div className="space-y-3 mb-6">
                    <div className="flex justify-between text-gray-600">
                      <span>Subtotal</span>
                      <span>\${subtotal.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-gray-600">
                      <span>Tax (8%)</span>
                      <span>\${tax.toFixed(2)}</span>
                    </div>
                    <div className="border-t pt-3 flex justify-between text-xl font-bold">
                      <span>Total</span>
                      <span className="text-purple-600">\${total.toFixed(2)}</span>
                    </div>
                  </div>

                  <Link href="/checkout" className="btn btn-primary w-full text-center block mb-3">
                    Proceed to Checkout
                  </Link>
                  
                  <Link href="/" className="btn btn-secondary w-full text-center block">
                    Continue Shopping
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
`;
    fs.writeFileSync(path.join(appPath, 'cart', 'page.tsx'), cartPage);

    // Checkout page with enhanced styling
    const checkoutPage = `'use client';
import * as Sentry from '@sentry/nextjs';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function Checkout() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    cardNumber: '',
    name: '',
    address: '',
    city: '',
    zipCode: ''
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    
    const span = Sentry.startSpan({ op: 'checkout.submit', name: 'Submit Checkout Form' }, async () => {
      try {
        const response = await fetch(process.env.NEXT_PUBLIC_API_URL + '/api/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData)
        });

        if (response.ok) {
          const data = await response.json();
          router.push('/order/' + data.orderId);
        } else {
          throw new Error('Checkout failed');
        }
      } catch (error) {
        Sentry.captureException(error);
        alert('Checkout failed. Please try again.');
      } finally {
        setLoading(false);
      }
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <Link href="/cart" className="text-purple-600 hover:text-purple-700 font-medium">
            ← Back to Cart
          </Link>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Checkout</h1>
          <p className="text-gray-600">Complete your order securely</p>
        </div>
        
        <div className="card">
          <form onSubmit={handleSubmit} className="p-8 space-y-6">
            {/* Contact Information */}
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Contact Information</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={e => setFormData({ ...formData, email: e.target.value })}
                    className="input"
                    placeholder="you@example.com"
                    required
                  />
                </div>
              </div>
            </div>

            {/* Shipping Address */}
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Shipping Address</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Full Name
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                    className="input"
                    placeholder="John Doe"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Street Address
                  </label>
                  <input
                    type="text"
                    value={formData.address}
                    onChange={e => setFormData({ ...formData, address: e.target.value })}
                    className="input"
                    placeholder="123 Main St"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      City
                    </label>
                    <input
                      type="text"
                      value={formData.city}
                      onChange={e => setFormData({ ...formData, city: e.target.value })}
                      className="input"
                      placeholder="San Francisco"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      ZIP Code
                    </label>
                    <input
                      type="text"
                      value={formData.zipCode}
                      onChange={e => setFormData({ ...formData, zipCode: e.target.value })}
                      className="input"
                      placeholder="94102"
                      required
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Payment Information */}
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Payment Information</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Card Number
                  </label>
                  <input
                    type="text"
                    value={formData.cardNumber}
                    onChange={e => setFormData({ ...formData, cardNumber: e.target.value })}
                    className="input"
                    placeholder="4242 4242 4242 4242"
                    maxLength={19}
                    required
                  />
                </div>
              </div>
            </div>

            {/* Submit Button */}
            <button 
              type="submit" 
              disabled={loading}
              className="btn btn-primary w-full text-lg py-4 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Processing...' : '🔒 Complete Order'}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
`;
    fs.writeFileSync(path.join(appPath, 'checkout', 'page.tsx'), checkoutPage);

    // Product detail page with enhanced styling
    const productPage = `'use client';
import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const products = [
  { id: '1', name: 'Premium Headphones', price: 99.99, image: '🎧', description: 'Wireless noise-cancelling headphones with premium sound quality', features: ['40-hour battery', 'Active noise cancellation', 'Premium sound drivers', 'Comfortable ear cushions'] },
  { id: '2', name: 'Smart Watch', price: 149.99, image: '⌚', description: 'Fitness tracking & notifications on your wrist', features: ['Heart rate monitor', 'GPS tracking', 'Water resistant', 'Smart notifications'] },
  { id: '3', name: 'Laptop Stand', price: 199.99, image: '💻', description: 'Ergonomic aluminum design for better posture', features: ['Adjustable height', 'Aluminum construction', 'Cable management', 'Non-slip base'] },
  { id: '4', name: 'Mechanical Keyboard', price: 129.99, image: '⌨️', description: 'RGB backlit mechanical switches for gaming', features: ['Mechanical switches', 'RGB backlighting', 'Anti-ghosting', 'Programmable keys'] },
  { id: '5', name: 'Wireless Mouse', price: 49.99, image: '🖱️', description: 'High precision optical sensor', features: ['Ergonomic design', 'Wireless connectivity', 'Long battery life', 'DPI switching'] },
  { id: '6', name: 'USB-C Hub', price: 79.99, image: '🔌', description: '7-in-1 multiport adapter', features: ['USB-C power delivery', 'HDMI output', '3x USB 3.0 ports', 'SD card reader'] },
];

export default function ProductPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [quantity, setQuantity] = useState(1);
  const product = products.find(p => p.id === params.id);

  if (!product) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">Product Not Found</h1>
          <Link href="/" className="btn btn-primary">
            Back to Store
          </Link>
        </div>
      </div>
    );
  }

  const handleAddToCart = async () => {
    Sentry.startSpan({ op: 'cart.add', name: 'Add to Cart' }, async () => {
      try {
        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 500));
        alert(\`Added \${quantity} x \${product.name} to cart!\`);
        router.push('/cart');
      } catch (error) {
        Sentry.captureException(error);
        alert('Failed to add to cart');
      }
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <Link href="/" className="text-purple-600 hover:text-purple-700 font-medium">
            ← Back to Store
          </Link>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid md:grid-cols-2 gap-12">
          {/* Product Image */}
          <div className="card">
            <div className="p-12 flex items-center justify-center bg-gradient-to-br from-purple-100 to-blue-100">
              <div className="text-9xl">{product.image}</div>
            </div>
          </div>

          {/* Product Info */}
          <div>
            <h1 className="text-4xl font-bold text-gray-900 mb-4">
              {product.name}
            </h1>
            <div className="text-4xl font-bold text-purple-600 mb-6">
              \${product.price.toFixed(2)}
            </div>
            <p className="text-lg text-gray-600 mb-8">
              {product.description}
            </p>

            {/* Features */}
            <div className="mb-8">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Features:</h3>
              <ul className="space-y-2">
                {product.features.map((feature, idx) => (
                  <li key={idx} className="flex items-center text-gray-700">
                    <span className="text-purple-600 mr-2">✓</span>
                    {feature}
                  </li>
                ))}
              </ul>
            </div>

            {/* Quantity Selector */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Quantity
              </label>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  className="w-10 h-10 rounded-lg bg-gray-200 hover:bg-gray-300 flex items-center justify-center text-xl"
                >
                  −
                </button>
                <span className="text-2xl font-semibold w-16 text-center">
                  {quantity}
                </span>
                <button
                  onClick={() => setQuantity(quantity + 1)}
                  className="w-10 h-10 rounded-lg bg-purple-600 hover:bg-purple-700 text-white flex items-center justify-center text-xl"
                >
                  +
                </button>
              </div>
            </div>

            {/* Add to Cart */}
            {/* TODO: Add custom purchase options here based on your requirements
                Example: Bidding feature, installment plans, pre-orders, etc. */}
            <button 
              onClick={handleAddToCart}
              className="btn btn-primary w-full text-lg py-4 mb-4"
            >
              🛒 Add to Cart
            </button>
            
            <Link href="/" className="btn btn-secondary w-full text-center block">
              Continue Shopping
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
`;
    fs.writeFileSync(path.join(appPath, 'product', '[id]', 'page.tsx'), productPage);

    // Order confirmation page with enhanced styling
    const orderPage = `'use client';
import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect, useState } from 'react';

export default function OrderPage({ params }: { params: { id: string } }) {
  const [orderData, setOrderData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Sentry.startSpan({ op: 'order.fetch', name: 'Fetch Order Details' }, async () => {
      try {
        const response = await fetch(\`\${process.env.NEXT_PUBLIC_API_URL}/api/order/\${params.id}\`);
        if (response.ok) {
          const data = await response.json();
          setOrderData(data);
        }
      } catch (error) {
        Sentry.captureException(error);
      } finally {
        setLoading(false);
      }
    });
  }, [params.id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-4">⏳</div>
          <p className="text-xl text-gray-600">Loading order details...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <Link href="/" className="text-purple-600 hover:text-purple-700 font-medium">
            ← Back to Store
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Success Message */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-100 mb-6">
            <span className="text-5xl">✓</span>
          </div>
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            Order Confirmed!
          </h1>
          <p className="text-xl text-gray-600 mb-2">
            Thank you for your purchase
          </p>
          <p className="text-lg text-gray-500">
            Order #{params.id}
          </p>
        </div>

        {/* Order Details Card */}
        <div className="card mb-6">
          <div className="p-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Order Details</h2>
            
            {orderData ? (
              <div className="space-y-6">
                {/* Order Items */}
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Items</h3>
                  <div className="space-y-3">
                    {orderData.items?.map((item: any, idx: number) => (
                      <div key={idx} className="flex justify-between items-center py-3 border-b last:border-0">
                        <div>
                          <p className="font-medium text-gray-900">{item.name}</p>
                          <p className="text-sm text-gray-500">Qty: {item.quantity}</p>
                        </div>
                        <p className="font-semibold text-gray-900">
                          \${(item.price * item.quantity).toFixed(2)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Order Summary */}
                <div className="bg-gray-50 rounded-lg p-6">
                  <div className="space-y-3">
                    <div className="flex justify-between text-gray-600">
                      <span>Subtotal</span>
                      <span>\${orderData.subtotal?.toFixed(2) || '0.00'}</span>
                    </div>
                    <div className="flex justify-between text-gray-600">
                      <span>Shipping</span>
                      <span>\${orderData.shipping?.toFixed(2) || '0.00'}</span>
                    </div>
                    <div className="flex justify-between text-gray-600">
                      <span>Tax</span>
                      <span>\${orderData.tax?.toFixed(2) || '0.00'}</span>
                    </div>
                    <div className="border-t pt-3 flex justify-between text-xl font-bold">
                      <span>Total</span>
                      <span className="text-purple-600">
                        \${orderData.total?.toFixed(2) || '0.00'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Shipping Info */}
                {orderData.shippingAddress && (
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-3">Shipping Address</h3>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-gray-700">{orderData.shippingAddress.name}</p>
                      <p className="text-gray-700">{orderData.shippingAddress.address}</p>
                      <p className="text-gray-700">
                        {orderData.shippingAddress.city}, {orderData.shippingAddress.zipCode}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-gray-600 mb-4">Order details not found</p>
                <p className="text-sm text-gray-500">
                  Your order has been processed successfully. 
                  You will receive a confirmation email shortly.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-4">
          <Link href="/" className="btn btn-primary flex-1 text-center">
            Continue Shopping
          </Link>
          <button 
            onClick={() => window.print()} 
            className="btn btn-secondary flex-1"
          >
            Print Receipt
          </button>
        </div>
      </main>
    </div>
  );
}
`;
    fs.writeFileSync(path.join(appPath, 'order', '[id]', 'page.tsx'), orderPage);

    // Layout
    const layout = `import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '${project.project.name}',
  description: 'Reference app with Sentry instrumentation',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`;
    fs.writeFileSync(path.join(appPath, 'layout.tsx'), layout);

    // Globals CSS with custom styles
    const globalsCss = `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  body {
    @apply bg-gray-50 text-gray-900;
  }
  
  h1 {
    @apply text-3xl font-bold;
  }
  
  h2 {
    @apply text-2xl font-semibold;
  }
  
  h3 {
    @apply text-xl font-medium;
  }
}

@layer components {
  .btn {
    @apply px-4 py-2 rounded-lg font-medium transition-all duration-200;
  }
  
  .btn-primary {
    @apply bg-purple-600 text-white hover:bg-purple-700 shadow-md hover:shadow-lg;
  }
  
  .btn-secondary {
    @apply bg-gray-200 text-gray-800 hover:bg-gray-300;
  }
  
  .card {
    @apply bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow duration-200 overflow-hidden;
  }
  
  .input {
    @apply w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent;
  }
}
`;
    fs.writeFileSync(path.join(appPath, 'globals.css'), globalsCss);
  }

  private generateFrontendInstrumentation(frontendPath: string, project: EngagementSpec): void {
    const frontendSpans = project.instrumentation.spans.filter(s => s.layer === 'frontend');
    
    const instrumentationFile = `import * as Sentry from '@sentry/nextjs';

// Custom instrumentation generated from your engagement spec
// These spans have been designed based on your project requirements
// Call these functions to track key operations in your application

${frontendSpans.map(span => `
export function trace_${span.name.replace(/\./g, '_')}(
  callback: () => Promise<any>,
  attributes: Record<string, any> = {}
) {
  return Sentry.startSpan(
    {
      op: '${span.op}',
      name: '${span.name}',
      attributes: filterPII(attributes, ${JSON.stringify(span.pii.keys)})
    },
    callback
  );
}
`).join('\n')}

function filterPII(attributes: Record<string, any>, piiKeys: string[]): Record<string, any> {
  const filtered = { ...attributes };
  piiKeys.forEach(key => {
    if (filtered[key]) {
      filtered[key] = '[REDACTED]';
    }
  });
  return filtered;
}
`;

    fs.writeFileSync(path.join(frontendPath, 'lib', 'instrumentation.ts'), instrumentationFile);
  }

  private generateBackendServer(backendPath: string, project: EngagementSpec): void {
    const serverFile = `require('dotenv').config();
const Sentry = require('../sentry.config');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Sentry request handler must be the first middleware
app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());

app.use(cors());
app.use(express.json());

// Routes
app.use('/api', require('./routes/api'));

// Sentry error handler must be before other error middleware
app.use(Sentry.Handlers.errorHandler());

app.listen(PORT, () => {
  console.log(\`Backend running on port \${PORT}\`);
});
`;
    fs.writeFileSync(path.join(backendPath, 'src', 'index.ts'), serverFile);

    // .env.example
    const envExample = `SENTRY_DSN=your_sentry_dsn_here
SENTRY_ENVIRONMENT=development
PORT=3001
`;
    fs.writeFileSync(path.join(backendPath, '.env.example'), envExample);
  }

  private generateBackendRoutes(backendPath: string, project: EngagementSpec): void {
    const routesFile = `const express = require('express');
const router = express.Router();
const Sentry = require('@sentry/node');
const { traceCheckout } = require('../utils/instrumentation');

// TODO: Customize these API endpoints based on your project requirements
// See README.md and IMPLEMENTATION_GUIDE.md for your specific use case
// Example: Add bidding endpoints, auction management, real-time updates, etc.

router.get('/products', (req, res) => {
  const products = [
    { id: 1, name: 'Product 1', price: 99.99 },
    { id: 2, name: 'Product 2', price: 149.99 },
    { id: 3, name: 'Product 3', price: 199.99 }
  ];
  res.json(products);
});

router.post('/checkout', async (req, res) => {
  try {
    await traceCheckout(async () => {
      // Simulate checkout processing
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const orderId = Math.random().toString(36).substring(7);
      res.json({ success: true, orderId });
    }, {
      cart_items: 1,
      total_amount: 99.99,
      customer_email: req.body.email
    });
  } catch (error) {
    Sentry.captureException(error);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

module.exports = router;
`;
    fs.writeFileSync(path.join(backendPath, 'src', 'routes', 'api.ts'), routesFile);
  }

  private generateBackendInstrumentation(backendPath: string, project: EngagementSpec): void {
    const backendSpans = project.instrumentation.spans.filter(s => s.layer === 'backend');
    
    const instrumentationFile = `const Sentry = require('@sentry/node');

// Custom instrumentation generated from your engagement spec
// These spans have been designed based on your project requirements
// Call these functions to track key operations in your application

${backendSpans.map(span => `
exports.trace_${span.name.replace(/\./g, '_')} = function(
  callback,
  attributes = {}
) {
  return Sentry.startSpan(
    {
      op: '${span.op}',
      name: '${span.name}',
      attributes: filterPII(attributes, ${JSON.stringify(span.pii.keys)})
    },
    callback
  );
};
`).join('\n')}

function filterPII(attributes, piiKeys) {
  const filtered = { ...attributes };
  piiKeys.forEach(key => {
    if (filtered[key]) {
      filtered[key] = '[REDACTED]';
    }
  });
  return filtered;
}
`;

    fs.writeFileSync(path.join(backendPath, 'src', 'utils', 'instrumentation.ts'), instrumentationFile);
  }

  private generateConfigFiles(appPath: string, project: EngagementSpec): void {
    // Docker compose
    const dockerCompose = `version: '3.8'

services:
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NEXT_PUBLIC_API_URL=http://backend:3001
      - NEXT_PUBLIC_SENTRY_DSN=\${SENTRY_DSN}
    depends_on:
      - backend

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "3001:3001"
    environment:
      - SENTRY_DSN=\${SENTRY_DSN}
      - PORT=3001
`;
    fs.writeFileSync(path.join(appPath, 'docker-compose.yml'), dockerCompose);

    // README
    const readme = `# ${project.project.name}

Reference application with Sentry instrumentation.

${project.project.notes ? `## Project Requirements

${project.project.notes}

**⚠️ Important:** This is a template starting point. The generated code provides a basic e-commerce structure with Sentry instrumentation. You'll need to customize the application logic to fully implement the requirements above. The custom spans and instrumentation have been designed to track your specific use case.

` : ''}## Setup

1. Install dependencies:
\`\`\`bash
cd frontend && npm install
cd ../backend && npm install
\`\`\`

2. Configure environment variables:
\`\`\`bash
cp backend/.env.example backend/.env
# Add your Sentry DSN to backend/.env
\`\`\`

3. Run the application:
\`\`\`bash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev
\`\`\`

4. Open http://localhost:3000

## Instrumentation

This app includes custom Sentry instrumentation:
- ${project.instrumentation.spans.length} custom spans
- ${project.instrumentation.transactions.length} transactions

See IMPLEMENTATION_GUIDE.md for details.
`;
    fs.writeFileSync(path.join(appPath, 'README.md'), readme);
  }

  private buildImplementationGuide(project: EngagementSpec): string {
    return `# Implementation Guide: ${project.project.name}

## Overview

This guide explains the Sentry instrumentation implemented in this reference application.

**Project:** ${project.project.name}  
**Vertical:** ${project.project.vertical}  
**Stack:** Next.js (Frontend) + Express (Backend)

${project.project.notes ? `## Requirements

${project.project.notes}

**Note:** The generated reference app provides a basic e-commerce template. You should customize the code to implement the specific requirements above. The custom Sentry instrumentation has been tailored to track the operations relevant to your use case.

` : ''}## Instrumentation Plan

### Transactions

${project.instrumentation.transactions.map(t => `- \`${t}\``).join('\n')}

### Custom Spans

${project.instrumentation.spans.map(span => `
#### ${span.name} (${span.layer})

**Operation:** \`${span.op}\`  
**Description:** ${span.description || 'N/A'}

**Attributes:**
${Object.entries(span.attributes).map(([key, desc]) => `- \`${key}\`: ${desc}`).join('\n')}

${span.pii.keys.length > 0 ? `**PII Keys (Redacted):** ${span.pii.keys.map(k => `\`${k}\``).join(', ')}` : ''}
`).join('\n')}

## Files Modified

### Frontend

- \`frontend/lib/instrumentation.ts\` - Custom instrumentation helpers
- \`frontend/app/checkout/page.tsx\` - Checkout flow with tracing

### Backend

- \`backend/src/utils/instrumentation.ts\` - Custom span helpers
- \`backend/src/routes/api.ts\` - API endpoints with instrumentation

## Validation in Sentry

1. **Performance Tab**
   - View transactions: ${project.instrumentation.transactions.join(', ')}
   - Check span waterfall for custom operations

2. **Search by Span**
   - Use query: \`span.op:[${project.instrumentation.spans.map(s => s.op).join(',')}]\`

3. **Dashboard**
   - Import \`sentry-dashboard.json\` to visualize key metrics

## PII Handling

The following attributes are automatically redacted:
${[...new Set(project.instrumentation.spans.flatMap(s => s.pii.keys))].map(k => `- \`${k}\``).join('\n') || '- None'}

## Generating Test Data

A Python script (generate_data.py) has been included to populate your Sentry dashboard with realistic test data.

### Setup

1. Install Python dependencies:
\\\`\\\`\\\`bash
pip install -r requirements.txt
\\\`\\\`\\\`

2. Configure your Sentry DSNs:
\\\`\\\`\\\`bash
cp .env.example .env
# Edit .env and add your DSNs
\\\`\\\`\\\`

3. Run the data generator:
\\\`\\\`\\\`bash
python generate_data.py
\\\`\\\`\\\`

### What It Generates

The script creates realistic test data including:
- **Custom spans** from your instrumentation plan
- **Realistic attributes** based on your schema
- **PII handling** - automatically redacts sensitive data
- **Variety of outcomes** - success, errors, slow requests
- **Both layers** - frontend and backend data

### Configuration

Edit .env to customize:
- NUM_TRACES - Number of traces to generate (default: 100)
- NUM_ERRORS - Number of errors to generate (default: 20)
- SENTRY_DSN_FRONTEND - Frontend project DSN
- SENTRY_DSN_BACKEND - Backend project DSN

## Next Steps

1. Add your Sentry DSN to environment variables
2. Run the data generation script to populate your dashboard
3. Import the dashboard JSON to Sentry
4. Customize spans and attributes for your use case
`;
  }

  private buildDashboard(project: EngagementSpec): any {
    const widgets: any[] = [];
    let x = 0, y = 0;

    // Transaction volume widget
    widgets.push({
      title: 'Transaction Volume',
      description: 'Count of all transactions',
      displayType: 'area',
      widgetType: 'spans',
      interval: '1h',
      queries: [{
        aggregates: ['count(span.duration)'],
        columns: ['transaction'],
        conditions: 'is_transaction:1',
        name: '',
        orderby: '-count(span.duration)',
        fields: ['transaction', 'count(span.duration)']
      }],
      layout: { x: 0, y: 0, w: 2, h: 2, minH: 2 }
    });

    // P95 latency
    widgets.push({
      title: 'P95 Latency',
      description: 'P95 transaction duration',
      displayType: 'line',
      widgetType: 'spans',
      interval: '1h',
      queries: [{
        aggregates: ['p95(span.duration)'],
        columns: ['transaction'],
        conditions: 'is_transaction:1',
        name: '',
        orderby: '-p95(span.duration)',
        fields: ['transaction', 'p95(span.duration)']
      }],
      layout: { x: 2, y: 0, w: 2, h: 2, minH: 2 }
    });

    // Custom spans widget for each operation
    const ops = [...new Set(project.instrumentation.spans.map(s => s.op))];
    ops.forEach((op, idx) => {
      widgets.push({
        title: `Span Op: ${op}`,
        description: `Custom spans with op=${op}`,
        displayType: 'area',
        widgetType: 'spans',
        interval: '1h',
        queries: [{
          aggregates: ['count(span.duration)'],
          columns: ['span.description'],
          conditions: `span.op:${op}`,
          name: '',
          orderby: '-count(span.duration)',
          fields: ['span.description', 'count(span.duration)']
        }],
        layout: { x: (idx % 3) * 2, y: 2 + Math.floor(idx / 3) * 2, w: 2, h: 2, minH: 2 }
      });
    });

    // Error rate
    widgets.push({
      title: 'Error Rate',
      description: 'Errors over time',
      displayType: 'area',
      widgetType: 'error-events',
      interval: '1h',
      queries: [{
        aggregates: ['count()'],
        columns: ['issue', 'title'],
        conditions: '',
        name: '',
        orderby: '-count()',
        fields: ['issue', 'title', 'count()']
      }],
      layout: { x: 4, y: 0, w: 2, h: 2, minH: 2 }
    });

    return {
      title: `${project.project.name} - Monitoring Dashboard`,
      filters: {},
      projects: [],
      environment: [],
      widgets
    };
  }

  private buildDataGenerationScript(project: EngagementSpec): string {
    const frontendSpans = project.instrumentation.spans.filter(s => s.layer === 'frontend');
    const backendSpans = project.instrumentation.spans.filter(s => s.layer === 'backend');

    return `#!/usr/bin/env python3
"""
Data Generator for ${project.project.name}
Generates realistic test data with custom spans and attributes
"""

import os
import random
import time
from datetime import datetime, timedelta
from typing import Dict, List, Any
import sentry_sdk
from sentry_sdk import start_transaction, start_span
from faker import Faker
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

fake = Faker()

# Configuration
FRONTEND_DSN = os.getenv('SENTRY_DSN_FRONTEND')
BACKEND_DSN = os.getenv('SENTRY_DSN_BACKEND')
NUM_TRACES = int(os.getenv('NUM_TRACES', '100'))
NUM_ERRORS = int(os.getenv('NUM_ERRORS', '20'))

# Instrumentation from engagement spec
FRONTEND_SPANS = ${JSON.stringify(frontendSpans.map(s => ({
  name: s.name,
  op: s.op,
  attributes: Object.keys(s.attributes),
  pii: s.pii.keys
})), null, 2)}

BACKEND_SPANS = ${JSON.stringify(backendSpans.map(s => ({
  name: s.name,
  op: s.op,
  attributes: Object.keys(s.attributes),
  pii: s.pii.keys
})), null, 2)}


class DataGenerator:
    def __init__(self, dsn: str, environment: str = 'development'):
        """Initialize Sentry SDK for data generation"""
        sentry_sdk.init(
            dsn=dsn,
            environment=environment,
            traces_sample_rate=1.0,
            profiles_sample_rate=1.0,
        )
        self.fake = Faker()
    
    def generate_attribute_value(self, attr_name: str, pii_keys: List[str]) -> Any:
        """Generate realistic values for attributes"""
        attr_lower = attr_name.lower()
        
        # Handle PII - return redacted or fake data
        if attr_name in pii_keys:
            if 'email' in attr_lower:
                return '[REDACTED]'
            elif 'card' in attr_lower or 'payment' in attr_lower:
                return '[REDACTED]'
            elif 'phone' in attr_lower:
                return '[REDACTED]'
            else:
                return '[REDACTED]'
        
        # Generate realistic non-PII values
        if 'id' in attr_lower:
            return self.fake.uuid4()
        elif 'name' in attr_lower:
            return self.fake.word()
        elif 'price' in attr_lower or 'amount' in attr_lower or 'value' in attr_lower:
            return round(random.uniform(10.0, 500.0), 2)
        elif 'count' in attr_lower or 'quantity' in attr_lower:
            return random.randint(1, 10)
        elif 'method' in attr_lower:
            return random.choice(['credit_card', 'paypal', 'apple_pay', 'google_pay'])
        elif 'status' in attr_lower:
            return random.choice(['success', 'pending', 'failed'])
        elif 'type' in attr_lower:
            return random.choice(['standard', 'express', 'premium'])
        elif 'url' in attr_lower:
            return self.fake.url()
        elif 'user' in attr_lower:
            return f"user_{random.randint(1, 1000)}"
        else:
            return self.fake.word()
    
    def generate_custom_span(self, span_config: Dict[str, Any], parent_span=None):
        """Generate a custom span with attributes"""
        with start_span(
            op=span_config['op'],
            description=span_config['name']
        ) as span:
            # Add custom attributes
            for attr in span_config['attributes']:
                value = self.generate_attribute_value(attr, span_config['pii'])
                span.set_tag(attr, value)
            
            # Simulate work
            time.sleep(random.uniform(0.01, 0.1))
            
            return span


class FrontendDataGenerator(DataGenerator):
    """Generate frontend traces"""
    
    def generate_page_view(self, route: str):
        """Simulate a page view with custom instrumentation"""
        with start_transaction(op="pageload", name=route) as transaction:
            transaction.set_tag("transaction.type", "pageload")
            
            # Generate frontend spans
            for span_config in FRONTEND_SPANS:
                try:
                    self.generate_custom_span(span_config)
                except Exception as e:
                    print(f"Error generating span {span_config['name']}: {e}")
            
            # Simulate page load time
            time.sleep(random.uniform(0.1, 0.5))
    
    def generate_user_interaction(self, action: str):
        """Simulate user interaction"""
        with start_transaction(op="ui.action", name=action) as transaction:
            transaction.set_tag("action.type", action)
            
            # Add some frontend spans
            for span_config in random.sample(FRONTEND_SPANS, min(2, len(FRONTEND_SPANS))):
                self.generate_custom_span(span_config)
            
            time.sleep(random.uniform(0.05, 0.2))
    
    def generate_error(self):
        """Generate a frontend error"""
        errors = [
            "TypeError: Cannot read property 'value' of null",
            "NetworkError: Failed to fetch",
            "ReferenceError: validateForm is not defined",
            "Error: Payment validation failed",
        ]
        
        try:
            raise Exception(random.choice(errors))
        except Exception as e:
            sentry_sdk.capture_exception(e)


class BackendDataGenerator(DataGenerator):
    """Generate backend traces"""
    
    def generate_api_call(self, endpoint: str, method: str = "GET"):
        """Simulate an API call with custom instrumentation"""
        with start_transaction(op="http.server", name=f"{method} {endpoint}") as transaction:
            transaction.set_tag("http.method", method)
            transaction.set_tag("http.route", endpoint)
            
            # Generate backend spans
            for span_config in BACKEND_SPANS:
                try:
                    self.generate_custom_span(span_config)
                except Exception as e:
                    print(f"Error generating span {span_config['name']}: {e}")
            
            # Simulate processing time
            time.sleep(random.uniform(0.05, 0.3))
            
            # Occasionally simulate slow response
            if random.random() < 0.1:
                time.sleep(random.uniform(1.0, 2.0))
    
    def generate_database_query(self):
        """Simulate database query"""
        queries = [
            "SELECT * FROM products WHERE id = ?",
            "INSERT INTO orders (user_id, total) VALUES (?, ?)",
            "UPDATE cart SET quantity = ? WHERE id = ?",
            "DELETE FROM sessions WHERE expired_at < ?",
        ]
        
        with start_span(op="db.query", description=random.choice(queries)) as span:
            span.set_tag("db.system", "postgresql")
            time.sleep(random.uniform(0.01, 0.05))
    
    def generate_error(self):
        """Generate a backend error"""
        errors = [
            "DatabaseError: Connection timeout",
            "ValidationError: Invalid cart items",
            "PaymentError: Payment gateway unavailable",
            "AuthenticationError: Invalid token",
        ]
        
        try:
            raise Exception(random.choice(errors))
        except Exception as e:
            sentry_sdk.capture_exception(e)


def main():
    """Main data generation function"""
    print(f"🚀 Starting data generation for ${project.project.name}")
    print(f"📊 Generating {NUM_TRACES} traces and {NUM_ERRORS} errors")
    
    # Initialize generators
    if FRONTEND_DSN:
        print("\\n🎨 Generating frontend data...")
        frontend = FrontendDataGenerator(FRONTEND_DSN, 'development')
        
        routes = ['/', '/products', '/cart', '/checkout', '/order/123']
        actions = ['Add to Cart', 'Submit Checkout', 'Apply Promo Code', 'Update Quantity']
        
        for i in range(NUM_TRACES // 2):
            if i % 10 == 0:
                print(f"  Progress: {i}/{NUM_TRACES // 2}")
            
            # Generate page views
            frontend.generate_page_view(random.choice(routes))
            
            # Generate user interactions
            if random.random() < 0.5:
                frontend.generate_user_interaction(random.choice(actions))
        
        # Generate frontend errors
        for i in range(NUM_ERRORS // 2):
            frontend.generate_error()
            time.sleep(0.1)
        
        print(f"✅ Generated {NUM_TRACES // 2} frontend traces and {NUM_ERRORS // 2} errors")
    
    if BACKEND_DSN:
        print("\\n⚙️  Generating backend data...")
        backend = BackendDataGenerator(BACKEND_DSN, 'development')
        
        endpoints = [
            '/api/products',
            '/api/cart/add',
            '/api/checkout',
            '/api/order/123',
            '/api/user/profile'
        ]
        methods = ['GET', 'POST', 'PUT', 'DELETE']
        
        for i in range(NUM_TRACES // 2):
            if i % 10 == 0:
                print(f"  Progress: {i}/{NUM_TRACES // 2}")
            
            # Generate API calls
            endpoint = random.choice(endpoints)
            method = 'GET' if '/api/products' in endpoint else random.choice(methods)
            backend.generate_api_call(endpoint, method)
            
            # Add database queries
            if random.random() < 0.7:
                backend.generate_database_query()
        
        # Generate backend errors
        for i in range(NUM_ERRORS // 2):
            backend.generate_error()
            time.sleep(0.1)
        
        print(f"✅ Generated {NUM_TRACES // 2} backend traces and {NUM_ERRORS // 2} errors")
    
    # Flush remaining events
    sentry_sdk.flush()
    
    print("\\n🎉 Data generation complete!")
    print("📊 Check your Sentry dashboard for the data")


if __name__ == '__main__':
    if not FRONTEND_DSN and not BACKEND_DSN:
        print("❌ Error: No Sentry DSN configured!")
        print("Please set SENTRY_DSN_FRONTEND and/or SENTRY_DSN_BACKEND in your .env file")
        exit(1)
    
    main()
`;
  }

  // ============================================
  // React Native / Mobile Generation Methods
  // ============================================

  private createMobileDirectoryStructure(appPath: string): void {
    const dirs = [
      appPath,
      path.join(appPath, 'mobile'),
      path.join(appPath, 'mobile', 'screens'),
      path.join(appPath, 'mobile', 'components'),
      path.join(appPath, 'mobile', 'services'),
      path.join(appPath, 'mobile', 'navigation'),
      path.join(appPath, 'backend'),
      path.join(appPath, 'backend', 'src'),
      path.join(appPath, 'backend', 'src', 'routes'),
      path.join(appPath, 'backend', 'src', 'middleware'),
      path.join(appPath, 'backend', 'src', 'utils')
    ];

    dirs.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  private async generateReactNativeApp(appPath: string, project: EngagementSpec): Promise<void> {
    console.log('🤖 Using LLM to generate custom mobile app based on project requirements...');
    const mobilePath = path.join(appPath, 'mobile');

    // Generate static config files (these don't need LLM)
    this.generateReactNativePackageJson(mobilePath, project);
    this.generateReactNativeAppJson(mobilePath, project);
    this.generateReactNativeBabelConfig(mobilePath);
    this.generateReactNativeSentryConfig(mobilePath, project);
    this.generateReactNativeAppTsx(mobilePath, project);

    // Use LLM to generate custom screens based on project notes and instrumentation plan
    try {
      console.log('📝 Generating screens with LLM...');
      const { screens } = await this.llm.generateMobileScreens(project);
      console.log(`✅ LLM generated ${screens.length} custom screens`);
      
      // Write generated screens
      const screensPath = path.join(mobilePath, 'screens');
      fs.mkdirSync(screensPath, { recursive: true });
      
      for (const screen of screens) {
        fs.writeFileSync(path.join(screensPath, screen.filename), screen.code);
        console.log(`  - ${screen.filename}: ${screen.description}`);
      }

      // Generate navigation that includes all the LLM-generated screens
      this.generateReactNativeNavigationFromScreens(mobilePath, project, screens);
    } catch (error) {
      console.error('❌ LLM screen generation failed, falling back to templates:', error);
      // Fallback to template-based generation
      this.generateReactNativeScreens(mobilePath, project);
      this.generateReactNativeNavigation(mobilePath, project);
    }

    // Use LLM to generate API service with mock data fallback
    try {
      console.log('📝 Generating API service with LLM...');
      const { code } = await this.llm.generateApiService(project);
      console.log('✅ LLM generated API service with mock data support');
      
      const servicesPath = path.join(mobilePath, 'services');
      fs.mkdirSync(servicesPath, { recursive: true });
      fs.writeFileSync(path.join(servicesPath, 'api.ts'), code);
    } catch (error) {
      console.error('❌ LLM API service generation failed, using fallback:', error);
      // Fallback to template-based generation
      this.generateReactNativeServices(mobilePath, project);
    }
  }

  private generateReactNativePackageJson(mobilePath: string, project: EngagementSpec): void {
    const packageJson = {
      name: `${project.project.slug}-mobile`,
      version: "1.0.0",
      main: "node_modules/expo/AppEntry.js",
      scripts: {
        start: "expo start",
        android: "expo start --android",
        ios: "expo start --ios",
        web: "expo start --web"
      },
      dependencies: {
        "expo": "~50.0.0",
        "expo-status-bar": "~1.11.1",
        "react": "18.2.0",
        "react-native": "0.73.6",
        "@react-navigation/native": "^6.1.9",
        "@react-navigation/stack": "^6.3.20",
        "react-native-screens": "~3.29.0",
        "react-native-safe-area-context": "4.8.2",
        "react-native-gesture-handler": "~2.14.0",
        "@sentry/react-native": "~5.20.0",
        "axios": "^1.6.2"
      },
      devDependencies: {
        "@babel/core": "^7.23.5",
        "@types/react": "~18.2.45",
        "typescript": "^5.3.3"
      },
      private: true
    };

    fs.writeFileSync(
      path.join(mobilePath, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );
  }

  private generateReactNativeAppJson(mobilePath: string, project: EngagementSpec): void {
    const appJson = {
      expo: {
        name: project.project.name,
        slug: project.project.slug,
        version: "1.0.0",
        orientation: "portrait",
        icon: "./assets/icon.png",
        userInterfaceStyle: "light",
        splash: {
          image: "./assets/splash.png",
          resizeMode: "contain",
          backgroundColor: "#ffffff"
        },
        assetBundlePatterns: ["**/*"],
        ios: {
          supportsTablet: true,
          bundleIdentifier: `com.${project.project.slug}.app`
        },
        android: {
          adaptiveIcon: {
            foregroundImage: "./assets/adaptive-icon.png",
            backgroundColor: "#ffffff"
          },
          package: `com.${project.project.slug}.app`
        },
        web: {
          favicon: "./assets/favicon.png"
        },
        plugins: [
          "@sentry/react-native/expo"
        ],
        hooks: {
          postPublish: [
            {
              file: "sentry-expo/upload-sourcemaps",
              config: {
                organization: "your-org",
                project: project.project.slug
              }
            }
          ]
        }
      }
    };

    fs.writeFileSync(
      path.join(mobilePath, 'app.json'),
      JSON.stringify(appJson, null, 2)
    );
  }

  private generateReactNativeBabelConfig(mobilePath: string): void {
    const babelConfig = `module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
`;

    fs.writeFileSync(path.join(mobilePath, 'babel.config.js'), babelConfig);
  }

  private generateReactNativeSentryConfig(mobilePath: string, project: EngagementSpec): void {
    const sentryConfig = `import * as Sentry from '@sentry/react-native';

Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || 'development',
  tracesSampleRate: 1.0,
  enableAutoSessionTracking: true,
  sessionTrackingIntervalMillis: 10000,
  integrations: [
    new Sentry.ReactNativeTracing({
      routingInstrumentation: Sentry.reactNavigationIntegration,
    }),
  ],
});

export default Sentry;
`;

    fs.writeFileSync(path.join(mobilePath, 'sentry.config.ts'), sentryConfig);
  }

  private generateReactNativeAppTsx(mobilePath: string, project: EngagementSpec): void {
    const appTsx = `import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import * as Sentry from '@sentry/react-native';
import AppNavigator from './navigation/AppNavigator';

// Initialize Sentry
Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN || '',
  environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || 'development',
  tracesSampleRate: 1.0,
  enableAutoSessionTracking: true,
  sessionTrackingIntervalMillis: 10000,
  integrations: [
    new Sentry.ReactNativeTracing({
      routingInstrumentation: Sentry.reactNavigationIntegration,
    }),
  ],
});

export default function App() {
  return (
    <NavigationContainer>
      <AppNavigator />
    </NavigationContainer>
  );
}
`;

    fs.writeFileSync(path.join(mobilePath, 'App.tsx'), appTsx);
  }

  private generateReactNativeScreens(mobilePath: string, project: EngagementSpec): void {
    const screensPath = path.join(mobilePath, 'screens');

    // TODO: In the future, use LLM to generate custom screens based on project.project.notes
    // For now, generate generic screens

    // Home Screen
    const homeScreen = `import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator
} from 'react-native';
import * as Sentry from '@sentry/react-native';
import { apiService } from '../services/api';

export default function HomeScreen({ navigation }: any) {
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProducts();
  }, []);

  const loadProducts = async () => {
    const transaction = Sentry.startTransaction({
      name: 'HomeScreen.loadProducts',
      op: 'navigation.screen_load',
    });

    try {
      const data = await apiService.getProducts();
      setProducts(data);
    } catch (error) {
      Sentry.captureException(error);
    } finally {
      setLoading(false);
      transaction.finish();
    }
  };

  const handleProductPress = (product: any) => {
    const span = Sentry.startInactiveSpan({
      name: 'ui.button_press',
      op: 'ui.action',
    });
    span?.setData('product_id', product.id);
    span?.finish();

    navigation.navigate('ProductDetail', { product });
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
      <Text style={styles.title}>Products</Text>
      <FlatList
        data={products}
        keyExtractor={(item) => item.id.toString()}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.card}
            onPress={() => handleProductPress(item)}
          >
            <Text style={styles.emoji}>{item.image}</Text>
            <View style={styles.info}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.description}>{item.description}</Text>
              <Text style={styles.price}>$\{item.price.toFixed(2)}</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
    padding: 16,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 16,
    color: '#111827',
  },
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
  emoji: {
    fontSize: 48,
    marginRight: 16,
  },
  info: {
    flex: 1,
  },
  name: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
  description: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 8,
  },
  price: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#6366f1',
  },
});
`;

    // Product Detail Screen
    const productDetailScreen = `import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native';
import * as Sentry from '@sentry/react-native';
import { apiService } from '../services/api';

export default function ProductDetailScreen({ route, navigation }: any) {
  const { product } = route.params;
  const [addingToCart, setAddingToCart] = useState(false);

  const handleAddToCart = async () => {
    setAddingToCart(true);
    const transaction = Sentry.startTransaction({
      name: 'cart.addProduct',
      op: 'ui.action',
    });

    transaction.setData('product_id', product.id);
    transaction.setData('product_name', product.name);
    transaction.setData('price', product.price);

    try {
      await apiService.addToCart(product.id);
      Alert.alert(
        'Success!',
        \`\${product.name} has been added to your cart.\`,
        [
          { text: 'Continue Shopping', onPress: () => navigation.goBack() },
          { text: 'OK' },
        ]
      );
    } catch (error) {
      Alert.alert('Error', 'Failed to add item to cart. Please try again.');
      Sentry.captureException(error);
    } finally {
      setAddingToCart(false);
      transaction.finish();
    }
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.imageContainer}>
          <Text style={styles.emoji}>{product.image}</Text>
        </View>
        
        <View style={styles.infoCard}>
          <Text style={styles.name}>{product.name}</Text>
          <Text style={styles.description}>{product.description}</Text>
          
          <View style={styles.priceRow}>
            <Text style={styles.priceLabel}>Price:</Text>
            <Text style={styles.price}>$\{product.price.toFixed(2)}</Text>
          </View>

          <View style={styles.features}>
            <Text style={styles.featuresTitle}>Features:</Text>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>✓</Text>
              <Text style={styles.featureText}>High quality product</Text>
            </View>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>✓</Text>
              <Text style={styles.featureText}>Fast shipping available</Text>
            </View>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>✓</Text>
              <Text style={styles.featureText}>30-day money-back guarantee</Text>
            </View>
          </View>
        </View>

        <TouchableOpacity 
          style={[styles.button, addingToCart && styles.buttonDisabled]} 
          onPress={handleAddToCart}
          disabled={addingToCart}
        >
          <Text style={styles.buttonText}>
            {addingToCart ? 'Adding to Cart...' : '🛒 Add to Cart'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={() => navigation.goBack()}
        >
          <Text style={[styles.buttonText, styles.secondaryButtonText]}>
            ← Back to Products
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  content: {
    padding: 20,
  },
  imageContainer: {
    alignItems: 'center',
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 32,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  emoji: {
    fontSize: 120,
  },
  infoCard: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  name: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 12,
  },
  description: {
    fontSize: 16,
    color: '#6b7280',
    lineHeight: 24,
    marginBottom: 20,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    marginBottom: 20,
  },
  priceLabel: {
    fontSize: 18,
    color: '#6b7280',
  },
  price: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#6366f1',
  },
  features: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 16,
  },
  featuresTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 12,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  featureBullet: {
    fontSize: 16,
    color: '#10b981',
    marginRight: 8,
    fontWeight: 'bold',
  },
  featureText: {
    fontSize: 15,
    color: '#4b5563',
  },
  button: {
    backgroundColor: '#6366f1',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    marginBottom: 12,
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  buttonDisabled: {
    backgroundColor: '#9ca3af',
    shadowOpacity: 0.1,
  },
  buttonText: {
    color: 'white',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  secondaryButton: {
    backgroundColor: 'white',
    borderWidth: 2,
    borderColor: '#6366f1',
    shadowColor: '#000',
    shadowOpacity: 0.1,
  },
  secondaryButtonText: {
    color: '#6366f1',
  },
});
`;

    fs.writeFileSync(path.join(screensPath, 'HomeScreen.tsx'), homeScreen);
    fs.writeFileSync(path.join(screensPath, 'ProductDetailScreen.tsx'), productDetailScreen);
  }

  private generateReactNativeNavigation(mobilePath: string, project: EngagementSpec): void {
    const navigationPath = path.join(mobilePath, 'navigation');

    const appNavigator = `import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import HomeScreen from '../screens/HomeScreen';
import ProductDetailScreen from '../screens/ProductDetailScreen';

const Stack = createStackNavigator();

export default function AppNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="Home"
      screenOptions={{
        headerStyle: {
          backgroundColor: '#6366f1',
        },
        headerTintColor: '#fff',
        headerTitleStyle: {
          fontWeight: 'bold',
        },
      }}
    >
      <Stack.Screen
        name="Home"
        component={HomeScreen}
        options={{ title: '${project.project.name}' }}
      />
      <Stack.Screen
        name="ProductDetail"
        component={ProductDetailScreen}
        options={{ title: 'Product Details' }}
      />
    </Stack.Navigator>
  );
}
`;

    fs.writeFileSync(path.join(navigationPath, 'AppNavigator.tsx'), appNavigator);
  }

  private generateReactNativeNavigationFromScreens(
    mobilePath: string,
    project: EngagementSpec,
    screens: Array<{ name: string; filename: string }>
  ): void {
    const navigationPath = path.join(mobilePath, 'navigation');
    fs.mkdirSync(navigationPath, { recursive: true });

    // Generate imports for all screens
    const imports = screens.map(screen => 
      `import ${screen.name} from '../screens/${screen.filename.replace('.tsx', '')}';`
    ).join('\n');

    // Generate Stack.Screen components
    const screenComponents = screens.map((screen, index) => {
      const screenName = screen.name.replace('Screen', ''); // Remove 'Screen' suffix for route name
      const isFirst = index === 0;
      const title = screenName.replace(/([A-Z])/g, ' $1').trim(); // Convert camelCase to Title Case
      
      return `      <Stack.Screen
        name="${screenName}"
        component=${screen.name}
        options={{ title: '${title}' }}
      />`;
    }).join('\n');

    const firstScreenName = screens[0]?.name.replace('Screen', '') || 'Home';

    const appNavigator = `import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
${imports}

const Stack = createStackNavigator();

export default function AppNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="${firstScreenName}"
      screenOptions={{
        headerStyle: {
          backgroundColor: '#6366f1',
        },
        headerTintColor: '#fff',
        headerTitleStyle: {
          fontWeight: 'bold',
        },
      }}
    >
${screenComponents}
    </Stack.Navigator>
  );
}
`;

    fs.writeFileSync(path.join(navigationPath, 'AppNavigator.tsx'), appNavigator);
    console.log('✅ Generated navigation with LLM screens');
  }

  private generateReactNativeServices(mobilePath: string, project: EngagementSpec): void {
    const servicesPath = path.join(mobilePath, 'services');

    const apiService = `import axios from 'axios';
import * as Sentry from '@sentry/react-native';

// Configure your backend URL
// For local development: http://localhost:3001
// For production: your deployed backend URL
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';

// Mock data for demo purposes (used when backend is unavailable)
const MOCK_PRODUCTS = [
  {
    id: 1,
    name: 'Premium Headphones',
    description: 'High-quality wireless headphones with noise cancellation',
    price: 299.99,
    image: '🎧',
  },
  {
    id: 2,
    name: 'Smart Watch',
    description: 'Fitness tracker with heart rate monitor and GPS',
    price: 399.99,
    image: '⌚',
  },
  {
    id: 3,
    name: 'Laptop',
    description: 'Powerful laptop for work and entertainment',
    price: 1299.99,
    image: '💻',
  },
  {
    id: 4,
    name: 'Wireless Mouse',
    description: 'Ergonomic mouse with customizable buttons',
    price: 49.99,
    image: '🖱️',
  },
  {
    id: 5,
    name: 'Mechanical Keyboard',
    description: 'RGB backlit keyboard with cherry MX switches',
    price: 149.99,
    image: '⌨️',
  },
  {
    id: 6,
    name: 'USB-C Hub',
    description: 'Multi-port adapter with HDMI, USB 3.0, and card reader',
    price: 59.99,
    image: '🔌',
  },
  {
    id: 7,
    name: 'External SSD',
    description: '1TB portable solid state drive with fast transfer speeds',
    price: 179.99,
    image: '💾',
  },
  {
    id: 8,
    name: 'Webcam',
    description: '4K webcam with auto-focus and built-in microphone',
    price: 129.99,
    image: '📹',
  },
];

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const apiService = {
  async getProducts() {
    const span = Sentry.startInactiveSpan({
      name: 'api.fetch_products',
      op: 'http.client',
    });

    try {
      const response = await apiClient.get('/api/products');
      span?.setData('product_count', response.data.length);
      span?.setData('data_source', 'backend');
      return response.data;
    } catch (error) {
      console.log('Backend unavailable, using mock data');
      span?.setData('product_count', MOCK_PRODUCTS.length);
      span?.setData('data_source', 'mock');
      // Return mock data when backend is unavailable (e.g., in Expo Snack)
      return MOCK_PRODUCTS;
    } finally {
      span?.finish();
    }
  },

  async addToCart(productId: number) {
    const span = Sentry.startInactiveSpan({
      name: 'cart.add',
      op: 'http.client',
    });

    span?.setData('product_id', productId);

    try {
      const response = await apiClient.post('/api/cart/add', { productId });
      span?.setData('data_source', 'backend');
      return response.data;
    } catch (error) {
      console.log('Backend unavailable, simulating cart add');
      span?.setData('data_source', 'mock');
      // Simulate success when backend is unavailable
      return { success: true, message: 'Added to cart (mock)' };
    } finally {
      span?.finish();
    }
  },
};
`;

    fs.writeFileSync(path.join(servicesPath, 'api.ts'), apiService);

    // Generate .env.example
    const envExample = `# Backend API URL
EXPO_PUBLIC_API_URL=http://localhost:3001

# Sentry DSN
EXPO_PUBLIC_SENTRY_DSN=your_sentry_dsn_here

# Environment
EXPO_PUBLIC_SENTRY_ENVIRONMENT=development
`;

    fs.writeFileSync(path.join(mobilePath, '.env.example'), envExample);

    // Generate README
    const readme = `# ${project.project.name} - Mobile App

React Native mobile app built with Expo and instrumented with Sentry.

## Project Notes

${project.project.notes || 'No additional notes provided.'}

## Getting Started

### Prerequisites

- Node.js 18+
- Expo CLI
- Expo Go app (for testing on device)

### Installation

\`\`\`bash
cd mobile
npm install
\`\`\`

### Configuration

1. Copy \`.env.example\` to \`.env\`
2. Update \`EXPO_PUBLIC_SENTRY_DSN\` with your Sentry DSN
3. Update \`EXPO_PUBLIC_API_URL\` with your backend URL

### Running the App

\`\`\`bash
npm start
\`\`\`

This will start the Expo development server. You can:
- Scan the QR code with Expo Go app
- Press 'i' for iOS Simulator
- Press 'a' for Android Emulator
- Press 'w' for web browser

## Sentry Instrumentation

This app includes custom Sentry instrumentation:

${project.instrumentation.spans
  .filter(s => s.layer === 'frontend')
  .map(s => `- **${s.name}**: ${s.description}`)
  .join('\n')}

## TODO

Implement custom features based on project requirements:
${project.project.notes || '- Add your custom features here'}

See \`IMPLEMENTATION_GUIDE.md\` for detailed instructions.
`;

    fs.writeFileSync(path.join(mobilePath, 'README.md'), readme);
  }

  /**
   * Read all generated files from a project for refinement
   */
  readGeneratedFiles(projectId: string): Record<string, string> {
    const outputPath = this.storage.getOutputPath(projectId);
    const appPath = path.join(outputPath, 'reference-app');
    const files: Record<string, string> = {};

    const project = this.storage.getProject(projectId);
    const isMobile = project.stack.type === 'mobile';
    
    const basePath = isMobile 
      ? path.join(appPath, 'mobile')
      : path.join(appPath, 'frontend', 'app');

    if (!fs.existsSync(basePath)) {
      console.warn('Generated app not found at:', basePath);
      return files;
    }

    try {
      // Read screens/pages
      if (isMobile) {
        const screensPath = path.join(appPath, 'mobile', 'screens');
        if (fs.existsSync(screensPath)) {
          const screenFiles = fs.readdirSync(screensPath);
          for (const file of screenFiles) {
            if (file.endsWith('.tsx') || file.endsWith('.ts')) {
              const filePath = path.join(screensPath, file);
              files[`screens/${file}`] = fs.readFileSync(filePath, 'utf-8');
            }
          }
        }

        // Read API service
        const apiFile = path.join(appPath, 'mobile', 'services', 'api.ts');
        if (fs.existsSync(apiFile)) {
          files['services/api.ts'] = fs.readFileSync(apiFile, 'utf-8');
        }

        // Read navigation
        const navFile = path.join(appPath, 'mobile', 'navigation', 'AppNavigator.tsx');
        if (fs.existsSync(navFile)) {
          files['navigation/AppNavigator.tsx'] = fs.readFileSync(navFile, 'utf-8');
        }
      } else {
        // Web app - read Next.js pages
        const pagesPath = path.join(appPath, 'frontend', 'app');
        if (fs.existsSync(pagesPath)) {
          const readDirRecursive = (dir: string, prefix: string = '') => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
              
              if (entry.isDirectory()) {
                readDirRecursive(fullPath, relativePath);
              } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
                files[relativePath] = fs.readFileSync(fullPath, 'utf-8');
              }
            }
          };
          readDirRecursive(pagesPath);
        }
      }

      console.log(`✅ Read ${Object.keys(files).length} files for refinement`);
    } catch (error) {
      console.error('Error reading generated files:', error);
    }

    return files;
  }

  /**
   * Update a specific file with refined code
   */
  updateGeneratedFile(
    projectId: string,
    relativePath: string,
    newCode: string
  ): void {
    const outputPath = this.storage.getOutputPath(projectId);
    const project = this.storage.getProject(projectId);
    const isMobile = project.stack.type === 'mobile';
    
    const basePath = isMobile
      ? path.join(outputPath, 'reference-app', 'mobile')
      : path.join(outputPath, 'reference-app', 'frontend', 'app');
    
    const fullPath = path.join(basePath, relativePath);
    
    // Create backup directory if it doesn't exist
    const backupDir = path.join(outputPath, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    
    // Backup original file with timestamp
    if (fs.existsSync(fullPath)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFileName = `${relativePath.replace(/\//g, '_')}.${timestamp}.backup`;
      const backupPath = path.join(backupDir, backupFileName);
      fs.copyFileSync(fullPath, backupPath);
      console.log(`📦 Backed up to: ${backupFileName}`);
    }
    
    // Write new code
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, newCode);
    console.log(`✅ Updated ${relativePath}`);
  }

  // ============================================
  // Python Backend Generation Methods
  // ============================================

  private createPythonDirectoryStructure(appPath: string): void {
    const dirs = [
      appPath,
      path.join(appPath, 'app'),
      path.join(appPath, 'app', 'routes'),
      path.join(appPath, 'app', 'models'),
      path.join(appPath, 'app', 'services'),
      path.join(appPath, 'app', 'utils')
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private generatePythonBackend(appPath: string, project: EngagementSpec): void {
    if (project.stack.backend === 'fastapi') {
      this.generateFastAPI(appPath, project);
    } else {
      this.generateFlask(appPath, project);
    }
  }

  private generateFastAPI(appPath: string, project: EngagementSpec): void {
    // requirements.txt
    const requirements = `fastapi==0.109.0
uvicorn[standard]==0.27.0
pydantic==2.5.3
python-dotenv==1.0.0
sentry-sdk==1.40.0
`;
    fs.writeFileSync(path.join(appPath, 'requirements.txt'), requirements);

    // .env.example
    const envExample = `SENTRY_DSN=your_sentry_dsn_here
ENVIRONMENT=development
`;
    fs.writeFileSync(path.join(appPath, '.env.example'), envExample);

    // sentry_config.py
    const sentryConfig = `import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration
import os
from dotenv import load_dotenv

load_dotenv()

def init_sentry():
    sentry_sdk.init(
        dsn=os.getenv("SENTRY_DSN"),
        environment=os.getenv("ENVIRONMENT", "development"),
        traces_sample_rate=1.0,
        profiles_sample_rate=1.0,
        integrations=[
            FastApiIntegration(),
            StarletteIntegration(),
        ],
    )
`;
    fs.writeFileSync(path.join(appPath, 'sentry_config.py'), sentryConfig);

    // app/__init__.py
    fs.writeFileSync(path.join(appPath, 'app', '__init__.py'), '');

    // app/instrumentation.py - Custom Sentry instrumentation
    const backendSpans = project.instrumentation.spans.filter(s => s.layer === 'backend');
    const instrumentationCode = this.generatePythonInstrumentation(backendSpans);
    fs.writeFileSync(path.join(appPath, 'app', 'instrumentation.py'), instrumentationCode);

    // app/models.py
    const modelsCode = `from pydantic import BaseModel
from typing import Optional, List

class Product(BaseModel):
    id: str
    name: str
    price: float
    description: Optional[str] = None
    image_url: Optional[str] = None

class CartItem(BaseModel):
    product_id: str
    quantity: int

class Order(BaseModel):
    id: str
    items: List[CartItem]
    total: float
    user_email: str
    status: str = "pending"
`;
    fs.writeFileSync(path.join(appPath, 'app', 'models.py'), modelsCode);

    // app/routes/api.py
    const apiRoutes = this.generateFastAPIRoutes(project);
    fs.writeFileSync(path.join(appPath, 'app', 'routes', 'api.py'), apiRoutes);
    fs.writeFileSync(path.join(appPath, 'app', 'routes', '__init__.py'), '');

    // main.py
    const mainCode = `import sentry_config
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import api

# Initialize Sentry
sentry_config.init_sentry()

app = FastAPI(
    title="${project.project.name} API",
    description="Backend API for ${project.project.name}",
    version="1.0.0"
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(api.router, prefix="/api")

@app.get("/")
def read_root():
    return {"message": "Welcome to ${project.project.name} API", "status": "healthy"}

@app.get("/health")
def health_check():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
`;
    fs.writeFileSync(path.join(appPath, 'main.py'), mainCode);

    // README.md
    const readme = this.generatePythonREADME(project, 'FastAPI');
    fs.writeFileSync(path.join(appPath, 'README.md'), readme);
  }

  private generateFlask(appPath: string, project: EngagementSpec): void {
    // requirements.txt
    const requirements = `Flask==3.0.0
Flask-CORS==4.0.0
python-dotenv==1.0.0
sentry-sdk[flask]==1.40.0
`;
    fs.writeFileSync(path.join(appPath, 'requirements.txt'), requirements);

    // .env.example
    const envExample = `SENTRY_DSN=your_sentry_dsn_here
ENVIRONMENT=development
FLASK_ENV=development
`;
    fs.writeFileSync(path.join(appPath, '.env.example'), envExample);

    // sentry_config.py
    const sentryConfig = `import sentry_sdk
from sentry_sdk.integrations.flask import FlaskIntegration
import os
from dotenv import load_dotenv

load_dotenv()

def init_sentry():
    sentry_sdk.init(
        dsn=os.getenv("SENTRY_DSN"),
        environment=os.getenv("ENVIRONMENT", "development"),
        traces_sample_rate=1.0,
        profiles_sample_rate=1.0,
        integrations=[FlaskIntegration()],
    )
`;
    fs.writeFileSync(path.join(appPath, 'sentry_config.py'), sentryConfig);

    // app/__init__.py
    const appInit = `from flask import Flask
from flask_cors import CORS
import sentry_config

def create_app():
    app = Flask(__name__)
    CORS(app)
    
    # Initialize Sentry
    sentry_config.init_sentry()
    
    # Register blueprints
    from app.routes.api import api_bp
    app.register_blueprint(api_bp, url_prefix='/api')
    
    @app.route('/')
    def index():
        return {'message': 'Welcome to ${project.project.name} API', 'status': 'healthy'}
    
    @app.route('/health')
    def health():
        return {'status': 'ok'}
    
    return app
`;
    fs.writeFileSync(path.join(appPath, 'app', '__init__.py'), appInit);

    // app/instrumentation.py
    const backendSpans = project.instrumentation.spans.filter(s => s.layer === 'backend');
    const instrumentationCode = this.generatePythonInstrumentation(backendSpans);
    fs.writeFileSync(path.join(appPath, 'app', 'instrumentation.py'), instrumentationCode);

    // app/routes/__init__.py
    fs.writeFileSync(path.join(appPath, 'app', 'routes', '__init__.py'), '');

    // app/routes/api.py
    const apiRoutes = this.generateFlaskRoutes(project);
    fs.writeFileSync(path.join(appPath, 'app', 'routes', 'api.py'), apiRoutes);

    // run.py
    const runCode = `from app import create_app
import os

app = create_app()

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
`;
    fs.writeFileSync(path.join(appPath, 'run.py'), runCode);

    // README.md
    const readme = this.generatePythonREADME(project, 'Flask');
    fs.writeFileSync(path.join(appPath, 'README.md'), readme);
  }

  private generatePythonInstrumentation(spans: SpanDefinition[]): string {
    const spanFunctions = spans.map(span => {
      const funcName = span.name.replace(/\./g, '_');
      const attributes = Object.keys(span.attributes)
        .map(key => `        "${key}": ${key}`)
        .join(',\n');

      return `def trace_${funcName}(${Object.keys(span.attributes).join(', ')}):
    """${span.description || `Traces ${span.name} operation`}"""
    with sentry_sdk.start_span(op="${span.op}", description="${span.name}") as span:
${attributes ? `        span.set_data("attributes", {\n${attributes}\n        })` : '        pass'}
        # Add your business logic here
        pass
`;
    }).join('\n\n');

    return `"""
Custom Sentry instrumentation for ${spans.length} backend operations.
Auto-generated from engagement spec.
"""

import sentry_sdk
from functools import wraps

${spanFunctions}

# Example decorator for automatic span creation
def trace_operation(op_name: str):
    """Decorator to automatically create Sentry spans for functions"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            with sentry_sdk.start_span(op=op_name, description=func.__name__):
                return func(*args, **kwargs)
        return wrapper
    return decorator
`;
  }

  private generateFastAPIRoutes(project: EngagementSpec): string {
    return `from fastapi import APIRouter, HTTPException
from app.models import Product, CartItem, Order
from app.instrumentation import trace_operation
import sentry_sdk
from typing import List
import uuid

router = APIRouter()

# Sample data
PRODUCTS = [
    {"id": "1", "name": "Product 1", "price": 29.99, "description": "Sample product 1", "image_url": "/product1.jpg"},
    {"id": "2", "name": "Product 2", "price": 49.99, "description": "Sample product 2", "image_url": "/product2.jpg"},
    {"id": "3", "name": "Product 3", "price": 19.99, "description": "Sample product 3", "image_url": "/product3.jpg"},
]

@router.get("/products", response_model=List[Product])
@trace_operation("api.get_products")
async def get_products():
    """Get all products"""
    return PRODUCTS

@router.get("/products/{product_id}", response_model=Product)
@trace_operation("api.get_product")
async def get_product(product_id: str):
    """Get a single product by ID"""
    product = next((p for p in PRODUCTS if p["id"] == product_id), None)
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    return product

@router.post("/checkout")
@trace_operation("api.checkout")
async def checkout(items: List[CartItem], user_email: str):
    """Process checkout"""
    with sentry_sdk.start_span(op="checkout.validate", description="Validate cart items"):
        total = sum(
            item.quantity * next((p["price"] for p in PRODUCTS if p["id"] == item.product_id), 0)
            for item in items
        )
    
    with sentry_sdk.start_span(op="checkout.create_order", description="Create order"):
        order_id = str(uuid.uuid4())
        order = {
            "id": order_id,
            "items": [item.dict() for item in items],
            "total": total,
            "user_email": user_email,
            "status": "completed"
        }
    
    # TODO: Add custom instrumentation based on project notes
    # ${project.project.notes ? `# Project notes: ${project.project.notes}` : ''}
    
    return order

@router.post("/cart/add")
@trace_operation("api.add_to_cart")
async def add_to_cart(item: CartItem):
    """Add item to cart"""
    product = next((p for p in PRODUCTS if p["id"] == item.product_id), None)
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    return {"message": "Item added to cart", "item": item.dict()}
`;
  }

  private generateFlaskRoutes(project: EngagementSpec): string {
    return `from flask import Blueprint, request, jsonify
from app.instrumentation import trace_operation
import sentry_sdk
import uuid

api_bp = Blueprint('api', __name__)

# Sample data
PRODUCTS = [
    {"id": "1", "name": "Product 1", "price": 29.99, "description": "Sample product 1", "image_url": "/product1.jpg"},
    {"id": "2", "name": "Product 2", "price": 49.99, "description": "Sample product 2", "image_url": "/product2.jpg"},
    {"id": "3", "name": "Product 3", "price": 19.99, "description": "Sample product 3", "image_url": "/product3.jpg"},
]

@api_bp.route('/products', methods=['GET'])
@trace_operation("api.get_products")
def get_products():
    """Get all products"""
    return jsonify(PRODUCTS)

@api_bp.route('/products/<product_id>', methods=['GET'])
@trace_operation("api.get_product")
def get_product(product_id):
    """Get a single product by ID"""
    product = next((p for p in PRODUCTS if p["id"] == product_id), None)
    if not product:
        return jsonify({"error": "Product not found"}), 404
    return jsonify(product)

@api_bp.route('/checkout', methods=['POST'])
@trace_operation("api.checkout")
def checkout():
    """Process checkout"""
    data = request.get_json()
    items = data.get('items', [])
    user_email = data.get('user_email')
    
    with sentry_sdk.start_span(op="checkout.validate", description="Validate cart items"):
        total = sum(
            item['quantity'] * next((p['price'] for p in PRODUCTS if p['id'] == item['product_id']), 0)
            for item in items
        )
    
    with sentry_sdk.start_span(op="checkout.create_order", description="Create order"):
        order_id = str(uuid.uuid4())
        order = {
            "id": order_id,
            "items": items,
            "total": total,
            "user_email": user_email,
            "status": "completed"
        }
    
    # TODO: Add custom instrumentation based on project notes
    # ${project.project.notes ? `# Project notes: ${project.project.notes}` : ''}
    
    return jsonify(order)

@api_bp.route('/cart/add', methods=['POST'])
@trace_operation("api.add_to_cart")
def add_to_cart():
    """Add item to cart"""
    data = request.get_json()
    product_id = data.get('product_id')
    quantity = data.get('quantity', 1)
    
    product = next((p for p in PRODUCTS if p["id"] == product_id), None)
    if not product:
        return jsonify({"error": "Product not found"}), 404
    
    return jsonify({"message": "Item added to cart", "item": {"product_id": product_id, "quantity": quantity}})
`;
  }

  private generatePythonREADME(project: EngagementSpec, framework: string): string {
    const port = framework === 'FastAPI' ? '8000' : '5000';
    const runCommand = framework === 'FastAPI' 
      ? 'uvicorn main:app --reload' 
      : 'python run.py';

    return `# ${project.project.name} - ${framework} Backend

Backend API for ${project.project.name} (${project.project.vertical} demo).

## Tech Stack

- **Framework**: ${framework}
- **Language**: Python 3.9+
- **Observability**: Sentry SDK

## Setup

1. Create a virtual environment:
\`\`\`bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\\Scripts\\activate
\`\`\`

2. Install dependencies:
\`\`\`bash
pip install -r requirements.txt
\`\`\`

3. Configure environment:
\`\`\`bash
cp .env.example .env
# Edit .env and add your Sentry DSN
\`\`\`

## Running the Application

\`\`\`bash
${runCommand}
\`\`\`

The API will be available at http://localhost:${port}

${framework === 'FastAPI' ? '\nAuto-generated API documentation: http://localhost:8000/docs' : ''}

## API Endpoints

- \`GET /\` - Health check
- \`GET /api/products\` - Get all products
- \`GET /api/products/{id}\` - Get product by ID
- \`POST /api/checkout\` - Process checkout
- \`POST /api/cart/add\` - Add item to cart

## Custom Instrumentation

This app includes ${project.instrumentation.spans.filter(s => s.layer === 'backend').length} custom Sentry spans:

${project.instrumentation.spans.filter(s => s.layer === 'backend').map(span => 
  `- **${span.name}**: ${span.description || 'Custom span'}`
).join('\n')}

## Project Notes

${project.project.notes || 'No additional notes'}

## Sentry Dashboard

Import the generated \`sentry-dashboard.json\` to your Sentry organization to visualize the instrumented data.
`;
  }
}
