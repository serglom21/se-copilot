# SE Copilot

SE Copilot is a desktop application for Sentry Sales Engineers to streamline the creation of instrumentation plans, reference applications, and demo dashboards.

## Features

- 🎯 **Chat-driven instrumentation planning** - Define custom spans and attributes with AI assistance
- 🏗️ **Multi-stack support** - Generate apps with your choice of stack:
  - **Web Apps**: Next.js frontend + Express backend
  - **Mobile Apps**: React Native (Expo) + Express backend
  - **Python Backends**: FastAPI or Flask REST APIs (NEW!)
- 📱 **Mobile deployment** - Deploy React Native apps to Expo Snack for browser-based testing
- 🐍 **Python backend generation** - Create production-ready FastAPI or Flask APIs with full Sentry instrumentation
- 🎲 **Test data generation** - Automated Python script to populate dashboards with realistic traces
- 🖥️ **Local deployment** - One-click deploy & run reference apps locally for demos
- 🤖 **AI troubleshooting** - Built-in assistant to help fix deployment and data generation issues
- 📝 **Implementation guides** - Auto-generate documentation for customers
- 📊 **Dashboard JSON export** - Create Sentry dashboards based on your instrumentation plan
- 🚀 **GitHub integration** - Push generated apps directly to GitHub
- 🔄 **Iterative refinement** - AI-powered code improvements and modifications

## Prerequisites

- Node.js 18+ 
- pnpm 8+
- Python 3.9+ (for Python backend projects and data generation)
- Git (for GitHub integration)

## Quick Start

```bash
# Install dependencies
pnpm install

# Start the desktop app in development mode
pnpm dev

# Build for production
pnpm build
```

## Project Structure

```
se-copilot/
├── apps/
│   └── desktop/          # Electron desktop app
├── templates/
│   └── reference-app/    # Reference app templates
└── docs/                 # Developer documentation

Generated outputs: ~/Documents/SE-Copilot-Output/
```

## Configuration

On first launch, configure:
1. **LLM Settings** - Add your OpenAI-compatible API endpoint and key
2. **GitHub Auth** - Sign in via device flow to enable repository creation

## Development

See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) for detailed development instructions.

## License

Private - Sentry Internal Use
