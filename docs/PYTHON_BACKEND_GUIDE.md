# Python Backend Support Guide

SE Copilot now supports creating backend-only Python API projects using Flask or FastAPI frameworks.

## Overview

The Python backend option allows you to generate production-ready API backends with:
- **FastAPI** - Modern, high-performance async framework with auto-generated docs
- **Flask** - Lightweight, simple framework perfect for smaller APIs

Both frameworks come with:
- Full Sentry instrumentation and error tracking
- Custom span definitions based on your engagement plan
- Sample endpoints for common operations
- Auto-generated API documentation (FastAPI)
- Local deployment with one click

## Creating a Python Backend Project

### 1. New Project Setup

1. Click **"New Project"** from the home screen
2. Fill in the project details:
   - **Project Name**: Your demo project name
   - **Vertical**: Choose the industry vertical (e-commerce, fintech, etc.)
   - **Tech Stack**: Select **"🐍 Backend Only (Python API)"**
   - **Python Framework**: Choose between:
     - **FastAPI**: For modern async APIs with auto-docs
     - **Flask**: For simple, lightweight APIs
   - **Notes**: Add any custom requirements or features

### 2. Planning & Instrumentation

Navigate to the **Planning** tab to:
- Chat with the AI about instrumentation requirements
- Define custom spans for your API operations
- Specify attributes and PII fields
- The AI will suggest relevant backend spans like:
  - `db.query` - Database operations
  - `cache.get` - Cache operations
  - `payment.process` - Payment processing
  - `external.http_call` - External API calls
  - `email.send` - Email operations

### 3. Code Generation

Click **"Generate Code"** to create:
- Complete Python backend with your chosen framework
- `requirements.txt` with all dependencies
- Sentry configuration and initialization
- Custom instrumentation based on your plan
- Sample API endpoints (products, checkout, cart)
- README with setup instructions

**Generated Structure:**
```
reference-app/
├── main.py (FastAPI) or run.py (Flask)
├── requirements.txt
├── sentry_config.py
├── .env.example
├── app/
│   ├── __init__.py
│   ├── models.py
│   ├── instrumentation.py
│   └── routes/
│       ├── __init__.py
│       └── api.py
└── README.md
```

### 4. Local Deployment

Navigate to the **Deploy** tab:
1. Click **"🚀 Deploy & Run"**
2. The app will:
   - Check Python installation
   - Create virtual environment (recommended)
   - Install dependencies via pip
   - Start the server
   - Auto-open the API in your browser

**Default Ports:**
- **FastAPI**: http://localhost:8000
  - API Docs: http://localhost:8000/docs (auto-generated)
  - ReDoc: http://localhost:8000/redoc
- **Flask**: http://localhost:5000

### 5. Testing Your API

**FastAPI Projects:**
- Visit `/docs` for interactive Swagger UI
- Visit `/redoc` for alternative documentation
- Test endpoints directly in the browser

**Flask Projects:**
- Use tools like Postman or curl
- Visit the root endpoint for health check

**Sample Endpoints:**
```
GET  /                     - Health check
GET  /api/products         - List all products
GET  /api/products/{id}    - Get single product
POST /api/checkout         - Process checkout
POST /api/cart/add         - Add item to cart
```

## Framework Comparison

### FastAPI
**Best for:**
- Modern async applications
- High-performance requirements
- Auto-generated API documentation
- Type validation with Pydantic

**Features:**
- Automatic OpenAPI/Swagger docs at `/docs`
- High performance (comparable to Node.js)
- Modern Python 3.9+ features
- Dependency injection
- WebSocket support

### Flask
**Best for:**
- Simple APIs
- Quick prototypes
- Familiarity with traditional frameworks
- Smaller projects

**Features:**
- Lightweight and minimal
- Easy to understand
- Large ecosystem
- Flexible and unopinionated

## Sentry Integration

Both frameworks include:
- Automatic error tracking
- Performance monitoring
- Custom instrumentation from your plan
- Transaction tracking for all endpoints
- Context data for debugging

**Custom Spans:**
All spans defined in your instrumentation plan are automatically generated as reusable functions in `app/instrumentation.py`:

```python
def trace_payment_process(amount, method):
    with sentry_sdk.start_span(op="payment", description="payment.process") as span:
        span.set_data("attributes", {
            "amount": amount,
            "method": method
        })
        # Your business logic here
```

## Data Generation

The generated Python data script works seamlessly with Python backends:
1. Go to **"Run Data"** tab
2. Enter your backend's Sentry DSN
3. Generate test data with realistic transactions
4. View the data in your Sentry dashboard

## Troubleshooting

### Python Not Found
- Install Python 3.9 or higher
- Ensure `python3` (or `python`) is in your PATH
- On Windows, install from python.org
- On macOS: `brew install python3`
- On Linux: `sudo apt install python3 python3-pip`

### Port Already in Use
- FastAPI default: 8000
- Flask default: 5000
- Stop any existing servers on these ports
- Or modify the port in the generated code

### Dependencies Installation Failed
- Ensure pip is up to date: `python3 -m pip install --upgrade pip`
- Check internet connection
- Try installing manually: `cd reference-app && pip install -r requirements.txt`

### Server Won't Start
- Check Python version: `python3 --version`
- Verify all dependencies installed
- Check console output for specific errors
- Use the **"🤖 Ask AI for Help"** button

## Advanced Usage

### Virtual Environments
It's recommended to use a virtual environment:

```bash
cd reference-app
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### Custom Configuration
Edit `.env` to configure:
- `SENTRY_DSN`: Your Sentry project DSN
- `ENVIRONMENT`: development, staging, production
- `PORT`: Server port (Flask only)

### Adding Custom Endpoints
Add new routes in `app/routes/api.py`:

**FastAPI:**
```python
@router.get("/api/custom")
async def custom_endpoint():
    return {"message": "Custom endpoint"}
```

**Flask:**
```python
@api_bp.route('/custom', methods=['GET'])
def custom_endpoint():
    return jsonify({"message": "Custom endpoint"})
```

## Best Practices

1. **Use Virtual Environments**: Isolate dependencies
2. **Set Environment Variables**: Never commit `.env` files
3. **Test Instrumentation**: Verify spans appear in Sentry
4. **Use Type Hints**: Especially with FastAPI for better docs
5. **Handle Errors**: Wrap operations in try/except for better Sentry context
6. **Document Your API**: Add docstrings to all endpoints

## Next Steps

After deploying your Python backend:
1. Test all endpoints
2. Verify Sentry instrumentation is working
3. Generate test data to populate your dashboard
4. Refine the code using the **"Refine"** tab
5. Push to GitHub for easy sharing

## Resources

- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Flask Documentation](https://flask.palletsprojects.com/)
- [Sentry Python SDK](https://docs.sentry.io/platforms/python/)
- [Python Virtual Environments](https://docs.python.org/3/library/venv.html)
