# Installation Instructions

## Prerequisites

Before installing SE Copilot, ensure you have:

- **Node.js** version 18 or higher ([download](https://nodejs.org/))
- **pnpm** version 8 or higher

### Install pnpm

If you don't have pnpm installed:

```bash
npm install -g pnpm
```

Verify installation:

```bash
node --version  # Should be v18.x.x or higher
pnpm --version  # Should be 8.x.x or higher
```

## Installation Steps

### 1. Navigate to Project Directory

```bash
cd "/Users/sergiolombana/Documents/SE Copilot"
```

### 2. Install Dependencies

```bash
pnpm install
```

This will install all dependencies for the monorepo. First installation may take 2-3 minutes.

### 3. Start the Application

```bash
pnpm dev
```

The Electron application will launch automatically. The first launch may take a bit longer as Vite builds the renderer process.

## Verification

You should see:

1. **Terminal output**:
   ```
   VITE v5.x.x  ready in xxx ms
   ➜  Local:   http://localhost:5173/
   Backend running on port 3001
   ```

2. **Electron window** opens showing the SE Copilot interface

## Initial Configuration

### Configure LLM (Required)

1. Click **⚙️ Settings** in the left sidebar
2. Enter your LLM configuration:
   - **API Base URL**: `https://api.openai.com/v1`
   - **API Key**: Your OpenAI API key
   - **Model**: `gpt-4-turbo-preview` (recommended)
3. Click **Save Settings**

### Configure GitHub (Optional)

For publishing generated apps to GitHub:

1. Visit https://github.com/settings/tokens/new
2. Create a token with `repo` scope
3. Copy the token
4. Paste in SE Copilot Settings → GitHub Personal Access Token
5. Click **Save Settings**

## Building for Production

To create a production build:

```bash
pnpm build
```

The built application will be in `apps/desktop/release/`:

- **macOS**: `.dmg` and `.zip` files
- **Windows**: `.exe` installer
- **Linux**: `.AppImage` and `.deb` packages

## Troubleshooting

### pnpm command not found

Install pnpm globally:

```bash
npm install -g pnpm
```

### Port 5173 already in use

Kill the process using the port:

```bash
# macOS/Linux
lsof -ti:5173 | xargs kill -9

# Windows
netstat -ano | findstr :5173
taskkill /PID <PID> /F
```

### Electron window doesn't open

1. Check terminal for errors
2. Try clearing the cache:
   ```bash
   rm -rf apps/desktop/dist-electron/
   rm -rf node_modules/
   pnpm install
   pnpm dev
   ```

### Module not found errors

Ensure you're in the correct directory and run:

```bash
pnpm install
```

### Permission denied errors

On macOS/Linux, you may need to give execution permissions:

```bash
chmod +x node_modules/.bin/*
```

## Development Mode

When running `pnpm dev`, you get:

- **Hot reload**: Changes to React components reload automatically
- **DevTools**: Browser DevTools open in the Electron window
- **Source maps**: Full TypeScript debugging support
- **Fast refresh**: Preserves component state on reload

## File Locations

After installation, SE Copilot stores data in:

- **macOS**: `~/Library/Application Support/se-copilot/`
- **Windows**: `%APPDATA%/se-copilot/`
- **Linux**: `~/.config/se-copilot/`

This includes:
- `data/projects/` - Your project files
- `data/settings.json` - Application settings

Generated output goes to:
- `<workspace>/output/<project-slug>/`

## Updating

To update SE Copilot:

```bash
cd "/Users/sergiolombana/Documents/SE Copilot"
git pull  # If using Git
pnpm install
pnpm dev
```

## Uninstalling

To completely remove SE Copilot:

1. Delete the project directory
2. Remove application data:
   ```bash
   # macOS
   rm -rf ~/Library/Application\ Support/se-copilot/
   
   # Linux
   rm -rf ~/.config/se-copilot/
   
   # Windows
   rmdir /s "%APPDATA%\se-copilot"
   ```

## Next Steps

Once installed:

1. Read [QUICKSTART.md](./QUICKSTART.md) for a 5-minute tutorial
2. Check [docs/USER_GUIDE.md](./docs/USER_GUIDE.md) for detailed usage
3. Explore [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) if modifying the app

## Support

For issues or questions:

- Check the [Troubleshooting](#troubleshooting) section above
- Review logs in the terminal where you ran `pnpm dev`
- Check DevTools console in the Electron window (View → Toggle Developer Tools)

Happy demoing! 🚀
