# 🔧 Iterative Code Refinement Guide

## Overview

The SE Copilot now supports **AI-powered iterative code refinement**! After generating your initial app, you can use AI to:

- Get smart suggestions for improvements
- Refine specific files with natural language requests
- Regenerate artifacts (guide, dashboard) after changes
- Push refined code to GitHub
- Update Expo Snack with changes (mobile apps)

## How It Works

### 1. **Generate Initial App**
First, complete the planning and generation phases as normal:
- Create project with detailed notes
- Chat with AI to define instrumentation
- Generate the reference app

### 2. **Navigate to Refine Page**
Once generated, you'll see a new **🔧 Refine** tab in the sidebar.

### 3. **Get AI Suggestions**
The system automatically analyzes your code and provides:
- **High priority**: Critical improvements
- **Medium priority**: UX enhancements
- **Low priority**: Nice-to-have features

Examples:
- "Add pull-to-refresh functionality to reload products"
- "Improve error messages with user-friendly text"
- "Add loading animations when items are added to cart"

### 4. **Apply Refinements**
Two ways to refine code:

**Option A: Apply a Suggestion**
- Click "Apply →" on any suggestion
- It auto-fills the file and request
- Click "Refine Code with AI"

**Option B: Custom Request**
- Select a file from the dropdown
- Describe your change in natural language
- Click "Refine Code with AI"

### 5. **Review and Deploy**
After refining:
1. **Regenerate Artifacts** - Updates your Implementation Guide and Dashboard JSON
2. **Update Expo Snack** - Pushes changes to the simulator (mobile only)
3. **Push to GitHub** - Commits and pushes all changes to your repo

## Example Refinement Requests

### UX Improvements
```
Add a search bar to filter items by name
Add empty state when no items are found
Add success animation after adding to cart
Improve loading states with skeleton screens
```

### Feature Additions
```
Add authentication check before API calls
Add error retry button when API fails
Add item quantity selector (1-10)
Add item favoriting/bookmarking
```

### Code Quality
```
Add better error messages for network failures
Add input validation with error messages
Add accessibility labels for screen readers
Improve code comments and documentation
```

### Styling
```
Improve color contrast for better readability
Add subtle animations on button presses
Make cards more visually appealing
Add icons to navigation tabs
```

## Key Features

### ✅ Automatic Backups
Every refinement creates a timestamped backup in `/backups`

### ✅ Code Validation
LLM output is validated before writing to disk

### ✅ Smart Context
LLM sees:
- Your original project requirements
- Current file code
- Instrumentation plan
- Your refinement request

### ✅ Preserves Structure
Refinements maintain:
- Existing functionality
- Sentry instrumentation
- Code style and formatting
- Import statements

### ✅ Iterative Process
You can refine the same file multiple times:
1. Add search bar
2. Add search filters
3. Add search history
4. Add search analytics

## Workflow Example

```
1. Generate e-commerce app
   ✓ HomeScreen with product list
   ✓ ProductDetailScreen
   ✓ API service with mock data

2. Refine: "Add search bar to filter products by name"
   ✓ LLM adds search input
   ✓ LLM adds filter logic
   ✓ LLM adds Sentry span for search

3. Refine: "Add pull-to-refresh on home screen"
   ✓ LLM imports RefreshControl
   ✓ LLM adds refresh handler
   ✓ LLM adds loading state

4. Regenerate Artifacts
   ✓ Guide updated with new features
   ✓ Dashboard updated with search spans

5. Update Expo Snack
   ✓ Changes live in simulator

6. Push to GitHub
   ✓ All changes committed and pushed
```

## Tips & Best Practices

### 🎯 Be Specific
**Good**: "Add a search bar with debounced input that filters products by name or description"
**Bad**: "Make it better"

### 🎯 One Change at a Time
Refine incrementally for better results:
- ✅ "Add search bar" → "Add search filters" → "Add search history"
- ❌ "Add search bar with filters and history and analytics"

### 🎯 Review Changes
After each refinement:
- Check the code preview (click "Show Code")
- Test in Expo Snack or local deployment
- Make additional refinements if needed

### 🎯 Backup Safety
All originals are backed up automatically:
- `/backups/screens_HomeScreen.tsx.2026-01-16T18-45-30.backup`

### 🎯 Regenerate Artifacts
Always regenerate after major changes:
- Keeps your Implementation Guide in sync
- Updates Dashboard queries for new spans
- Ensures documentation accuracy

## Architecture

### LLM Integration
- Uses your configured Groq API key
- Temperature: 0.7 (balanced creativity/consistency)
- Max tokens: 4000 (handles large files)
- JSON output validation

### File Management
- Reads generated files from output directory
- Creates timestamped backups before updates
- Validates file paths and permissions
- Supports mobile and web projects

### AI Analysis
- Scans all generated files
- Identifies improvement opportunities
- Prioritizes suggestions by impact
- Context-aware recommendations

## Troubleshooting

### "No Generated Code Found"
→ Go to Generate page and create the reference app first

### "File not found"
→ Ensure you're selecting a valid file from the dropdown

### "LLM settings not configured"
→ Go to Settings and add your Groq API key

### Refinement not working
→ Check that your request is clear and specific
→ Try breaking complex changes into smaller steps

### Changes not showing in Snack
→ Click "Update Expo Snack" after refining
→ Wait 10-15 seconds for Snack to reload

## Future Enhancements

Planned features:
- [ ] Diff viewer to see exact changes
- [ ] Undo/redo refinement history
- [ ] Batch refinements across multiple files
- [ ] Custom prompt templates
- [ ] Refinement suggestions based on Sentry data
- [ ] A/B testing different refinement approaches

---

**Happy Refining! 🚀**

For questions or issues, check the project README or create an issue on GitHub.
