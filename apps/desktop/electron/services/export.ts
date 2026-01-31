import fs from 'fs';
import path from 'path';
import { StorageService } from './storage';
import { EngagementSpec } from '../../src/types/spec';

export class ExportService {
  private storage: StorageService;

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  async generateDemoPackage(
    projectId: string
  ): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      const project = this.storage.getProject(projectId);
      const outputPath = this.storage.getOutputPath(projectId);
      const packagePath = path.join(outputPath, 'DEMO_PACKAGE.md');

      const content = this.buildDemoPackage(project);
      fs.writeFileSync(packagePath, content);

      return { success: true, outputPath: packagePath };
    } catch (error) {
      console.error('Error generating demo package:', error);
      return { success: false, error: String(error) };
    }
  }

  private buildDemoPackage(project: EngagementSpec): string {
    const date = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    let content = `# ${project.project.name} - Demo Package\n\n`;
    content += `**Generated:** ${date}\n\n`;
    content += `---\n\n`;

    // Quick Links Section
    content += `## 📋 Quick Links\n\n`;
    if (project.project.githubRepoUrl) {
      content += `- **GitHub Repository:** [${project.project.githubRepoName}](${project.project.githubRepoUrl})\n`;
    }
    if (project.project.customerWebsite) {
      content += `- **Customer Website:** [${new URL(project.project.customerWebsite).hostname}](${project.project.customerWebsite})\n`;
    }
    content += `\n`;

    // Project Overview
    content += `## 🎯 Project Overview\n\n`;
    content += `- **Vertical:** ${project.project.vertical}\n`;
    content += `- **Stack:** ${this.getStackDescription(project)}\n`;
    content += `- **Custom Spans:** ${project.instrumentation.spans.length}\n`;
    content += `- **Status:** ${project.status}\n`;
    if (project.project.notes) {
      content += `\n**Notes:** ${project.project.notes}\n`;
    }
    content += `\n`;

    // Quick Start Section
    content += `## 🚀 Quick Start\n\n`;
    content += `### Prerequisites\n\n`;
    content += `- Node.js 18+\n`;
    content += `- Python 3.7+ (for data generation)\n`;
    content += `- Sentry Account ([sign up here](https://sentry.io/signup/))\n\n`;

    content += `### Setup Instructions\n\n`;
    if (project.project.githubRepoUrl) {
      content += `1. **Clone the repository**\n\n`;
      content += `   \`\`\`bash\n`;
      content += `   git clone ${project.project.githubRepoUrl}\n`;
      content += `   cd ${project.project.githubRepoName}\n`;
      content += `   \`\`\`\n\n`;
    }

    content += `2. **Install dependencies**\n\n`;
    content += `   Frontend:\n`;
    content += `   \`\`\`bash\n`;
    content += `   cd frontend\n`;
    content += `   npm install\n`;
    content += `   \`\`\`\n\n`;
    content += `   Backend:\n`;
    content += `   \`\`\`bash\n`;
    content += `   cd backend\n`;
    content += `   npm install  # or: pip install -r requirements.txt\n`;
    content += `   \`\`\`\n\n`;

    content += `3. **Configure Sentry**\n\n`;
    content += `   - Create a new project in Sentry\n`;
    content += `   - Copy your DSN\n`;
    content += `   - Update \`.env\` files:\n\n`;
    content += `   Frontend (\`frontend/.env.local\`):\n`;
    content += `   \`\`\`\n`;
    content += `   NEXT_PUBLIC_SENTRY_DSN=your-frontend-dsn\n`;
    content += `   \`\`\`\n\n`;
    content += `   Backend (\`backend/.env\`):\n`;
    content += `   \`\`\`\n`;
    content += `   SENTRY_DSN=your-backend-dsn\n`;
    content += `   \`\`\`\n\n`;

    content += `4. **Run the application**\n\n`;
    content += `   Frontend:\n`;
    content += `   \`\`\`bash\n`;
    content += `   cd frontend\n`;
    content += `   npm run dev\n`;
    content += `   \`\`\`\n\n`;
    content += `   Backend:\n`;
    content += `   \`\`\`bash\n`;
    content += `   cd backend\n`;
    content += `   npm start  # or: python app.py\n`;
    content += `   \`\`\`\n\n`;

    // Custom Instrumentation
    content += `## 🔧 Custom Instrumentation\n\n`;
    content += `This demo includes ${project.instrumentation.spans.length} custom spans for detailed performance monitoring:\n\n`;

    // Group spans by layer
    const frontendSpans = project.instrumentation.spans.filter(s => s.layer === 'frontend');
    const backendSpans = project.instrumentation.spans.filter(s => s.layer === 'backend');

    if (frontendSpans.length > 0) {
      content += `### Frontend Spans\n\n`;
      frontendSpans.forEach(span => {
        content += `- **\`${span.name}\`** (${span.op})\n`;
        if (span.description) {
          content += `  - ${span.description}\n`;
        }
        if (Object.keys(span.attributes).length > 0) {
          content += `  - Attributes: ${Object.keys(span.attributes).join(', ')}\n`;
        }
      });
      content += `\n`;
    }

    if (backendSpans.length > 0) {
      content += `### Backend Spans\n\n`;
      backendSpans.forEach(span => {
        content += `- **\`${span.name}\`** (${span.op})\n`;
        if (span.description) {
          content += `  - ${span.description}\n`;
        }
        if (Object.keys(span.attributes).length > 0) {
          content += `  - Attributes: ${Object.keys(span.attributes).join(', ')}\n`;
        }
      });
      content += `\n`;
    }

    // Dashboard Section
    content += `## 📊 Sentry Dashboard\n\n`;
    content += `A pre-configured Sentry dashboard is included in \`sentry-dashboard.json\`.\n\n`;
    content += `**To import:**\n\n`;
    content += `1. Go to your Sentry project's Dashboards page\n`;
    content += `2. Click "Create Dashboard"\n`;
    content += `3. Import the \`sentry-dashboard.json\` file\n\n`;
    content += `The dashboard includes widgets for:\n`;
    content += `- Custom span performance metrics\n`;
    content += `- Error rates and trends\n`;
    content += `- Transaction throughput\n`;
    content += `- Performance degradation alerts\n\n`;

    // Data Generation
    content += `## 🎲 Data Generation\n\n`;
    content += `To populate Sentry with realistic demo data:\n\n`;
    content += `\`\`\`bash\n`;
    content += `python generate_data.py\n`;
    content += `\`\`\`\n\n`;
    content += `This script will:\n`;
    content += `- Generate realistic transactions and spans\n`;
    content += `- Create performance data with variance\n`;
    content += `- Simulate user interactions\n`;
    content += `- Include custom attributes\n\n`;

    // Demo Scenario
    content += `## 🎬 Demo Scenario\n\n`;
    content += `### Suggested Demo Flow\n\n`;
    content += `1. **Introduction (2 min)**\n`;
    content += `   - Overview of the ${project.project.vertical} application\n`;
    content += `   - Key business challenges being monitored\n\n`;
    content += `2. **Custom Instrumentation (5 min)**\n`;
    content += `   - Walk through custom spans in the code\n`;
    content += `   - Explain why each span matters for this use case\n`;
    content += `   - Show how attributes provide business context\n\n`;
    content += `3. **Live Dashboard (8 min)**\n`;
    content += `   - Open Sentry dashboard\n`;
    content += `   - Highlight key metrics and trends\n`;
    content += `   - Show how custom spans appear in traces\n`;
    content += `   - Demonstrate performance insights\n\n`;
    content += `4. **Issue Detection (5 min)**\n`;
    content += `   - Show how errors are captured with context\n`;
    content += `   - Demonstrate breadcrumbs and user feedback\n`;
    content += `   - Explain alerting and notification setup\n\n`;
    content += `5. **Q&A and Next Steps (5 min)**\n\n`;

    // Key Talking Points
    content += `### Key Talking Points\n\n`;
    project.instrumentation.spans.slice(0, 5).forEach(span => {
      content += `- **${span.name}:** ${span.description || 'Critical operation for business success'}\n`;
    });
    content += `\n`;

    // Troubleshooting
    content += `## 🔍 Troubleshooting\n\n`;
    content += `### Common Issues\n\n`;
    content += `**Sentry not receiving events:**\n`;
    content += `- Verify DSN is correctly configured\n`;
    content += `- Check that Sentry SDK is initialized before any operations\n`;
    content += `- Ensure network connectivity to sentry.io\n\n`;
    content += `**Custom spans not appearing:**\n`;
    content += `- Verify Sentry tracing is enabled (\`tracesSampleRate\` > 0)\n`;
    content += `- Check that transactions are being created\n`;
    content += `- Ensure span naming follows Sentry conventions\n\n`;
    content += `**Performance issues:**\n`;
    content += `- Adjust \`tracesSampleRate\` for production (e.g., 0.1 for 10%)\n`;
    content += `- Use performance monitoring wisely to avoid overhead\n\n`;

    // Footer
    content += `---\n\n`;
    content += `*Generated with SE Copilot 2.0*\n`;
    content += `*For questions or support, contact your Sentry Sales Engineer*\n`;

    return content;
  }

  private getStackDescription(project: EngagementSpec): string {
    const { stackType, frontendFramework, backendFramework } = project.stack;

    if (stackType === 'web') {
      const frontend = frontendFramework === 'nextjs' ? 'Next.js' :
                      frontendFramework === 'react' ? 'React' : 'Frontend';
      const backend = backendFramework === 'express' ? 'Express' :
                     backendFramework === 'flask' ? 'Flask' :
                     backendFramework === 'fastapi' ? 'FastAPI' : 'Backend';
      return `${frontend} + ${backend}`;
    } else if (stackType === 'mobile') {
      return 'React Native';
    } else {
      return backendFramework === 'express' ? 'Express (Backend Only)' :
             backendFramework === 'flask' ? 'Flask (Backend Only)' :
             backendFramework === 'fastapi' ? 'FastAPI (Backend Only)' : 'Backend';
    }
  }
}
