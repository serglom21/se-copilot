# Contributing to SE Copilot

Thank you for your interest in contributing to SE Copilot! This document provides guidelines and instructions for contributing.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/se-copilot.git
   cd se-copilot
   ```
3. **Install dependencies**:
   ```bash
   pnpm install
   ```
4. **Run the development server**:
   ```bash
   pnpm dev
   ```

## Development Workflow

### Making Changes

1. **Create a new branch** for your feature or bug fix:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Make your changes** following our coding standards

3. **Test your changes** thoroughly:
   - Run the app: `pnpm dev`
   - Test affected features
   - Ensure no console errors

4. **Commit your changes** with a clear commit message:
   ```bash
   git commit -m "feat: add new feature description"
   # or
   git commit -m "fix: resolve issue with X"
   ```

### Commit Message Format

We follow conventional commits:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

### Pull Request Process

1. **Push your branch** to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Open a Pull Request** on GitHub:
   - Provide a clear title and description
   - Reference any related issues
   - Include screenshots if UI changes are involved

3. **Address review feedback** if requested

4. **Merge** - Once approved, your PR will be merged

## Code Standards

### TypeScript

- Use TypeScript for all new code
- Prefer types over `any`
- Use interfaces for object shapes
- Add JSDoc comments for public APIs

### React

- Use functional components with hooks
- Keep components focused and single-purpose
- Use TypeScript for props
- Follow React best practices

### Styling

- Use Tailwind CSS for styling
- Keep styling consistent with existing UI
- Avoid inline styles unless necessary

## Project Structure

```
se-copilot/
├── apps/desktop/          # Electron desktop app
│   ├── electron/          # Main process code
│   │   └── services/      # Backend services (LLM, storage, deployment)
│   └── src/               # Renderer process (React UI)
│       ├── components/    # Reusable UI components
│       ├── pages/         # Page components
│       └── store/         # State management
├── docs/                  # Documentation
└── pnpm-workspace.yaml    # Monorepo config
```

## Adding New Features

### Adding a New Tech Stack

1. Update `spec.ts` schema
2. Add UI option in `NewProjectPage.tsx`
3. Update LLM prompts in `llm.ts`
4. Create generator methods in `generator.ts`
5. Update deployment service if needed
6. Add documentation

### Adding New Services

1. Create service class in `apps/desktop/electron/services/`
2. Register service in `main.ts`
3. Add IPC handlers if needed
4. Update `preload.ts` with type-safe APIs
5. Document the service

## Testing

Currently, SE Copilot uses manual testing. When contributing:

- Test your changes in the actual Electron app
- Test with different project configurations (web, mobile, Python)
- Test error scenarios
- Verify no regressions in existing features

## Documentation

- Update relevant documentation in `/docs`
- Add code comments for complex logic
- Update README if adding major features
- Keep QUICKSTART.md current

## Getting Help

- Check existing [documentation](./docs/)
- Review [START_HERE.md](./START_HERE.md) for project overview
- Open an issue for questions or bugs

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow
- Follow GitHub's Community Guidelines

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

Thank you for contributing to SE Copilot! 🚀
