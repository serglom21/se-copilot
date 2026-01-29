# Development Guide

## Architecture

SE Copilot is an Electron desktop application built with:

- **Main Process**: Node.js orchestrator handling IPC, storage, and service coordination
- **Renderer Process**: React + Vite + Tailwind UI
- **State Management**: Zustand for client-side state
- **Storage**: JSON-based project storage in user data directory
- **Services**: LLM, Generator, GitHub integration

## Project Structure

```
apps/desktop/
├── electron/              # Main process code
│   ├── main.ts           # Electron entry point
│   ├── preload.ts        # IPC bridge
│   └── services/         # Backend services
│       ├── storage.ts    # Project & settings storage
│       ├── llm.ts        # LLM integration
│       ├── generator.ts  # Code generation
│       └── github.ts     # GitHub integration
├── src/                  # Renderer process (React)
│   ├── components/       # Reusable UI components
│   ├── pages/           # Route pages
│   ├── store/           # Zustand stores
│   └── types/           # TypeScript types & Zod schemas
└── templates/           # Reference app templates
```

## Setup

### Prerequisites

- Node.js 18+
- pnpm 8+

### Installation

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Build for production
pnpm build
```

## Key Concepts

### Engagement Spec

The `EngagementSpec` is the source of truth for each project. It contains:

- Project metadata (name, vertical, notes)
- Stack configuration (fixed to Next.js + Express for MVP)
- Instrumentation plan (transactions, custom spans, attributes)
- Dashboard configuration
- Chat history
- Status tracking

Schema defined in `src/types/spec.ts` with Zod validation.

### Storage Layer

Projects are stored as JSON files in the user data directory:

- macOS: `~/Library/Application Support/se-copilot/data/projects/`
- Windows: `%APPDATA%/se-copilot/data/projects/`
- Linux: `~/.config/se-copilot/data/projects/`

Settings are stored in `settings.json` in the same directory.

### Code Generation

The `GeneratorService` creates three artifacts:

1. **Reference App**: Full Next.js + Express application with Sentry SDK
2. **Implementation Guide**: Markdown documentation
3. **Dashboard JSON**: Sentry dashboard configuration

Output directory: `~/Documents/SE-Copilot-Output/<project-slug>/`

### LLM Integration

The `LLMService` provides:

- Chat interface for instrumentation planning
- Automated plan generation from project context
- OpenAI-compatible API client (configurable endpoint)

### GitHub Integration

For MVP, uses Personal Access Tokens instead of full OAuth device flow:

1. User creates PAT at https://github.com/settings/tokens/new
2. Token stored in settings
3. `simple-git` used for local operations
4. GitHub API used for repo creation

## Development Workflow

### Adding a New Feature

1. **Define types**: Update `src/types/spec.ts` if schema changes
2. **Add service method**: Implement in `electron/services/`
3. **Add IPC handler**: Register in `electron/main.ts`
4. **Update preload**: Add to `electron/preload.ts`
5. **Update store**: Add action to `src/store/project-store.ts`
6. **Update UI**: Add components/pages as needed

### Testing

```bash
# Run unit tests
pnpm test

# Run tests in watch mode
pnpm test -- --watch
```

### Debugging

- Main process: Check terminal output when running `pnpm dev`
- Renderer process: DevTools open automatically in development
- Storage: Inspect JSON files in user data directory

## Common Tasks

### Adding a New Vertical

Update `VerticalSchema` in `src/types/spec.ts`:

```typescript
export const VerticalSchema = z.enum([
  'ecommerce',
  'fintech',
  // ... add new vertical
]);
```

### Customizing Reference App Templates

Edit generation logic in `electron/services/generator.ts`:

- `generateFrontend()` - Next.js pages and components
- `generateBackend()` - Express routes and middleware
- `generateFrontendInstrumentation()` - Custom span helpers
- `buildDashboard()` - Dashboard widget generation

### Changing LLM Provider

Update settings to use a different OpenAI-compatible endpoint:

- **OpenAI**: `https://api.openai.com/v1`
- **Azure OpenAI**: `https://<resource>.openai.azure.com/openai/deployments/<deployment>`
- **Local LLM**: `http://localhost:1234/v1` (LM Studio, Ollama, etc.)

## Troubleshooting

### Electron app won't start

- Clear `dist-electron/` directory
- Run `pnpm install` again
- Check for TypeScript errors

### IPC errors

- Ensure handler is registered in `electron/main.ts`
- Verify method exists in `electron/preload.ts`
- Check browser console for renderer errors

### Generation fails

- Verify project has locked instrumentation plan
- Check output directory permissions
- Review main process logs for detailed errors

## Release Process

```bash
# Build production app
pnpm build

# Outputs will be in apps/desktop/release/
# - macOS: .dmg and .zip
# - Windows: .exe installer
# - Linux: .AppImage and .deb
```

## Future Enhancements

Ideas for post-MVP:

- [ ] Support multiple tech stacks (React SPA, Python/Django, etc.)
- [ ] Visual span editor with drag-and-drop
- [ ] Import existing instrumentation from Sentry
- [ ] Collaborative planning (shared specs)
- [ ] AI-powered query builder for dashboards
- [ ] Mobile app generation
- [ ] Integration with Sentry Projects API
