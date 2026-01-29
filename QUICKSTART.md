# SE Copilot - Quick Start Guide

Get up and running with SE Copilot in 5 minutes.

## Installation

```bash
# Clone/navigate to the project
cd "SE Copilot"

# Install dependencies
pnpm install

# Start the app
pnpm dev
```

The Electron app will launch automatically.

## Initial Setup

### 1. Configure LLM (Required)

1. Click **⚙️ Settings** in the sidebar
2. Add your LLM configuration:
   - **API Base URL**: `https://api.openai.com/v1`
   - **API Key**: Your OpenAI API key (starts with `sk-...`)
   - **Model**: `gpt-4-turbo-preview`
3. Click **Save Settings**

> **Note**: You can use any OpenAI-compatible endpoint (Azure OpenAI, local LLMs, etc.)

### 2. Configure GitHub (Optional)

To publish generated apps to GitHub:

1. Go to https://github.com/settings/tokens/new
2. Create a token with `repo` scope
3. Copy the token
4. Paste in Settings under "GitHub Personal Access Token"
5. Click **Save Settings**

## Create Your First Project

### Step 1: New Project

1. Click **➕ New Project**
2. Fill in:
   - **Name**: "My First Demo"
   - **Vertical**: Select "E-commerce"
   - **Notes**: "Testing SE Copilot"
3. Click **Create Project**

### Step 2: Generate Instrumentation Plan

1. In the **Planning** page, click **✨ Generate Plan with AI**
2. Wait 10-30 seconds for AI to generate spans
3. Review the generated spans in the right panel
4. Click **🔒 Lock Plan** to proceed

### Step 3: Generate Artifacts

1. Navigate to **Generate** page
2. Click **🚀 Generate All**
3. Wait for all three artifacts to be created:
   - ✅ Reference Application
   - ✅ Implementation Guide
   - ✅ Dashboard JSON

### Step 4: View Output

The generated files are in your Documents folder:

```bash
cd ~/Documents/SE-Copilot-Output/my-first-demo/

# View the reference app
cd reference-app/
ls -la

# Read the implementation guide
cat ../IMPLEMENTATION_GUIDE.md

# Check the dashboard config
cat ../sentry-dashboard.json

# Or open in Finder
open ~/Documents/SE-Copilot-Output/my-first-demo/
```

### Step 5: Run the Reference App

```bash
# Install frontend dependencies
cd frontend/
npm install

# Install backend dependencies
cd ../backend/
npm install

# Start backend (terminal 1)
npm run dev

# Start frontend (terminal 2)
cd ../frontend/
npm run dev
```

Open http://localhost:3000 to see your reference app!

## Next Steps

### Add Sentry DSN

1. Create a project in Sentry.io
2. Copy your DSN
3. Add to the reference app:

```bash
# Backend
cd ~/Documents/SE-Copilot-Output/my-first-demo/reference-app/backend/
cp .env.example .env
# Edit .env and add your SENTRY_DSN

# Frontend
cd ../frontend/
# Add NEXT_PUBLIC_SENTRY_DSN to .env.local
```

### Import Dashboard

1. Go to your Sentry project
2. Navigate to Dashboards
3. Click "Create Dashboard"
4. Use "Import from JSON"
5. Upload `output/my-first-demo/sentry-dashboard.json`

### Publish to GitHub

1. Go to **Publish** page in SE Copilot
2. Ensure GitHub is connected
3. Enter repository name
4. Click **🚀 Publish to GitHub**
5. Share the GitHub link with your customer!

## Tips

- **Fast iteration**: Edit spans in Planning page, regenerate artifacts
- **Custom attributes**: Click "Edit" on any span to add attributes
- **PII handling**: Add sensitive keys to the PII list for automatic redaction
- **Chat for help**: Ask questions like "How should I instrument a payment flow?"

## Troubleshooting

### App won't start

```bash
# Clear build cache
rm -rf apps/desktop/dist-electron/

# Reinstall dependencies
pnpm install

# Try again
pnpm dev
```

### "LLM not configured" error

Make sure you've added your API key in Settings.

### Generation fails

- Ensure you've locked the plan
- Check you have at least one span defined
- Verify output directory permissions

## Learn More

- [User Guide](./docs/USER_GUIDE.md) - Detailed usage instructions
- [Development Guide](./docs/DEVELOPMENT.md) - Technical architecture
- [README](./README.md) - Project overview

## Example Project Ideas

Try creating these common demo scenarios:

1. **E-commerce Checkout**
   - Spans: product_view, add_to_cart, checkout_submit, payment_process
   - Attributes: cart_value, item_count, payment_method

2. **SaaS Onboarding**
   - Spans: signup_form, email_verification, profile_setup, first_project
   - Attributes: user_tier, onboarding_step, completion_time

3. **FinTech Transaction**
   - Spans: transaction_validate, fraud_check, balance_update, notification_send
   - Attributes: amount, currency, transaction_type, risk_score
   - PII: account_number, user_email, ip_address

Happy demoing! 🎉
