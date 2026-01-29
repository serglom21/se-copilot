# SE Copilot User Guide

## Overview

SE Copilot helps Sentry Sales Engineers quickly create demo projects with proper instrumentation, reference applications, and dashboards.

## Getting Started

### First Launch

1. **Configure LLM Settings**
   - Go to Settings (⚙️)
   - Add your OpenAI API key (or compatible provider)
   - Base URL: `https://api.openai.com/v1`
   - Model: `gpt-4-turbo-preview` (recommended)

2. **Configure GitHub** (optional, for publishing)
   - Create a Personal Access Token at https://github.com/settings/tokens/new
   - Grant `repo` scope
   - Paste token in Settings

## Creating a Project

### Step 1: Project Wizard

Click **➕ New Project** and fill in:

- **Project Name**: Customer/demo name (e.g., "Acme Corp Demo")
- **Vertical**: Select customer industry
- **Notes**: Additional context for AI planning

### Step 2: Planning

The Planning page has two panels:

#### Left Panel: Chat

- Ask questions about instrumentation best practices
- Discuss specific use cases
- Get guidance on what spans/attributes to capture

**Tips:**
- Be specific: "What spans should I add for checkout flow?"
- Mention key features: "We need to track abandoned carts"
- Ask for examples: "Show me attributes for payment processing"

#### Right Panel: Spec Editor

View and edit your instrumentation plan:

- **Add Span**: Manual span creation
- **Generate Plan**: AI generates spans from project context
- **Lock Plan**: Finalize and move to generation

**Span Fields:**
- **Name**: Unique identifier (e.g., `checkout.validate_cart`)
- **Operation**: Category (e.g., `checkout`, `db`, `http`)
- **Layer**: Frontend or Backend
- **Description**: What this span measures
- **Attributes**: Key-value pairs to capture
- **PII Keys**: Attributes to redact (email, credit card, etc.)

### Step 3: Generation

Generate four artifacts:

1. **Reference Application**
   - Full Next.js + Express app
   - Sentry SDK pre-configured
   - Custom spans implemented
   - Docker Compose for easy deployment

2. **Implementation Guide**
   - Markdown documentation
   - Explains each span and attribute
   - Validation steps for Sentry
   - Links to relevant code

3. **Dashboard JSON**
   - Sentry dashboard configuration
   - Widgets based on your spans
   - Ready to import

4. **Data Generation Script**
   - Python script to generate test data
   - Creates realistic traces and errors
   - Populates your Sentry dashboard
   - Configurable via environment variables

**Tip:** Generate all at once with "🚀 Generate All"

### Step 4: Run Data (Optional but Recommended)

Populate your Sentry dashboard with realistic test data:

1. **Configure DSNs**
   - Enter your Sentry Frontend DSN
   - Enter your Sentry Backend DSN
   - Set number of traces (default: 50)
   - Set number of errors (default: 10)

2. **Run Generator**
   - Click "🚀 Run Data Generator"
   - Dependencies install automatically
   - Watch real-time output
   - Data appears in Sentry within seconds

The script generates:
- Realistic e-commerce transactions
- Custom spans matching your instrumentation plan
- Error scenarios (4xx, 5xx, exceptions)
- Varied latencies and outcomes

**Why run this?**
- Dashboard widgets need data to display
- Quickly demo instrumentation without manual testing
- Show variety of scenarios and edge cases

### Step 5: Deploy (Demo Locally)

Run the reference app locally for testing and demos:

1. **Start Deployment**
   - Click "🚀 Deploy & Run"
   - npm dependencies install automatically
   - Backend starts on port 3001
   - Frontend starts on port 3000
   - Browser opens automatically

2. **Demo the App**
   - Browse products
   - Add items to cart
   - Complete checkout
   - View Sentry data in real-time

3. **Stop When Done**
   - Click "🛑 Stop Servers"
   - Frees up ports
   - Cleans up processes

**Console Output** shows:
- Installation progress
- Server startup logs
- Real-time application logs
- Error messages (if any)

### Step 6: Publish

Push your reference app to GitHub:

1. Connect GitHub (if not already connected)
2. Choose repository name
3. Select public/private
4. Click "🚀 Publish to GitHub"

The repository will include:
- Complete source code
- IMPLEMENTATION_GUIDE.md
- sentry-dashboard.json
- README with setup instructions

## Best Practices

### Instrumentation Planning

**Do:**
- ✅ Focus on business-critical flows (checkout, payment, signup)
- ✅ Capture meaningful attributes (cart_value, payment_method, user_tier)
- ✅ Mark PII for redaction (email, IP, credit card)
- ✅ Use consistent naming (e.g., `<operation>.<action>`)

**Don't:**
- ❌ Instrument every single function
- ❌ Capture sensitive data without masking
- ❌ Use vague span names ("process", "handle")

### Chat Tips

Be specific with your requests:

❌ Bad: "Add instrumentation"
✅ Good: "Add spans for an e-commerce checkout flow: product selection, cart, payment, confirmation"

❌ Bad: "What should I track?"
✅ Good: "For a SaaS product, what metrics should I track during user onboarding?"

### Dashboard Design

The generated dashboard includes:
- Transaction volume by route
- P95 latency trends
- Error rates
- Custom span operations

You can import the JSON into Sentry and customize further.

## Common Workflows

### Demo for E-commerce Customer

1. Create project with "E-commerce" vertical
2. Chat: "Generate instrumentation for product browse, cart, checkout, and order completion"
3. Review generated spans, add attributes like `cart_value`, `promo_code`, `payment_method`
4. Mark PII: `email`, `credit_card_last4`, `shipping_address`
5. Generate all artifacts
6. Run data generator to populate dashboard
7. Deploy locally and demo live app
8. Publish to GitHub, share with customer

### Internal Training Demo

1. Create project with simple flow
2. Manually add 2-3 key spans
3. Add detailed descriptions for learning
4. Generate app and guide
5. Use in training session

### Quick POC for Sales Call

1. Create project during discovery call
2. Use AI to generate initial plan from notes
3. Lock and generate immediately
4. Run data generator for instant dashboard data
5. Deploy and screenshare the running app
6. Publish to GitHub, share repo link before call ends

## Output Structure

Generated files in `~/Documents/SE-Copilot-Output/<project-slug>/`:

```
~/Documents/SE-Copilot-Output/my-demo/
├── engagement-spec.json       # Your instrumentation plan
├── IMPLEMENTATION_GUIDE.md    # Documentation
├── sentry-dashboard.json      # Dashboard config
├── generate_data.py          # Python data generator
├── requirements.txt          # Python dependencies
├── .env.example              # Environment template
└── reference-app/            # Application code
    ├── frontend/             # Next.js app
    ├── backend/              # Express API
    ├── docker-compose.yml
    └── README.md
```

## AI Troubleshooting Assistant

### Overview

The **🤖 Ask AI for Help** feature provides intelligent troubleshooting assistance when things go wrong during deployment or data generation. It uses your configured LLM (Groq) to analyze errors and suggest fixes.

### When to Use It

The "Ask AI for Help" button appears automatically on:
- **Deploy Page** - When deployment errors occur
- **Data Generator Page** - When data generation fails

### How It Works

1. **Auto-Context**: The AI automatically sees:
   - Recent console output (last 20 lines)
   - All error messages
   - Current phase (deployment/data-generation)
   - System information

2. **Smart Analysis**: The AI:
   - Identifies the root cause
   - Explains what went wrong in plain English
   - Provides step-by-step fix instructions
   - Suggests commands to run

3. **Interactive**: You can:
   - Ask follow-up questions
   - Request clarification
   - Get alternative solutions
   - Copy commands directly

### Example Interactions

**Scenario 1: Port Conflict**
```
You: [Error shown automatically]
AI: The error indicates port 3000 is already in use. 
    This usually means another server is running.
    
    To fix:
    1. Find the process: lsof -i :3000
    2. Kill it: kill -9 <PID>
    3. Or use a different port in your .env file
```

**Scenario 2: Python Dependencies**
```
You: [Error shown automatically]  
AI: The Python package 'sentry-sdk' failed to install due to 
    permission issues.
    
    To fix:
    Run: pip3 install --user sentry-sdk faker requests python-dotenv
    
    The --user flag installs to your user directory without 
    needing sudo.
```

**Scenario 3: Missing Sentry Config**
```
You: [Error shown automatically]
AI: The backend is looking for 'sentry.config.js' but it's missing.
    This file should have been generated automatically.
    
    To fix:
    1. Go back to Generate page
    2. Click "Generate All" again
    3. This will recreate the missing file
```

### Tips for Best Results

✅ **Do:**
- Let the AI see the error first (it auto-loads context)
- Be specific: "How do I fix the port conflict?"
- Ask for explanations: "Why did this happen?"
- Request alternatives: "Is there another way?"

❌ **Don't:**
- Clear the console before asking for help
- Ask unrelated questions (use Planning chat for that)
- Expect it to directly modify files (it provides instructions)

### Privacy

The AI assistant sees:
- ✅ Console output and errors
- ✅ Your project configuration
- ❌ Not your actual code files
- ❌ Not your Sentry data

Only the information needed to diagnose the issue is sent to your LLM provider.

## Troubleshooting

### "LLM not configured" error

Go to Settings and add your API key and base URL.

### Chat responses are slow

- GPT-4 can take 10-30 seconds
- Try a faster model like `gpt-3.5-turbo`
- Check your API rate limits

### Generation fails

- Ensure you've locked the plan
- Check that you have at least one span defined
- Verify disk space in output directory

### GitHub publish fails

- Verify your PAT has `repo` scope
- Check repository name isn't already taken
- Ensure reference app was generated first

### Data generator fails

- Python 3.7+ must be installed
- Check internet connection (pip downloads packages)
- Ensure DSNs are valid
- View console output for specific errors
- **NEW: Click "🤖 Ask AI for Help"** to get automated troubleshooting

### Deployment fails

- Port 3000 or 3001 already in use? Stop other servers
- npm/Node.js must be installed
- Check console output for specific errors
- Try stopping and restarting deployment
- **NEW: Click "🤖 Ask AI for Help"** to get automated troubleshooting

## FAQ

**Q: Can I edit generated code?**
A: Yes! The output directory contains standard Next.js and Express code. Edit as needed.

**Q: Can I use a different tech stack?**
A: Not in MVP. Next.js + Express only. Vote for your stack on our roadmap.

**Q: Does the LLM see my customer data?**
A: Only project name, vertical, and notes you provide. No PII is sent.

**Q: Can I export/import projects?**
A: Projects are stored as JSON. Copy `engagement-spec.json` to share with colleagues.

**Q: How do I update an existing project?**
A: Open from home page, edit in Planning, regenerate artifacts.

## Tips & Tricks

- **Save time**: Use "Generate Plan with AI" for initial setup
- **Iterate**: Regenerate artifacts after refining spans
- **Templates**: Create a "template" project for your common use cases
- **Shortcuts**: Hit Enter in chat to send message
- **Data first**: Run data generator before deploying for populated dashboard
- **Demo flow**: Generate → Run Data → Deploy → Demo → Publish
- **Port conflicts**: Stop deployment before running again
- **Quick restart**: Restart dev server to pick up main process changes
- **Dark mode**: Coming soon™

## Support

For questions or issues:
- Check DEVELOPMENT.md for technical details
- Report bugs on internal Slack
- Request features via GitHub Issues

Happy demoing! 🚀
