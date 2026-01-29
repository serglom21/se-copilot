import fs from 'fs';
import path from 'path';
import { StorageService } from './storage';

interface SnackFile {
  type: 'CODE';
  contents: string;
}

interface SnackFiles {
  [key: string]: SnackFile;
}

interface SnackResponse {
  id: string;
  url: string;
  embedUrl: string;
}

export class ExpoDeployService {
  private storage: StorageService;
  private snackApiUrl = 'https://exp.host/--/api/v2/snack/save';

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  async createSnack(projectId: string): Promise<{ url: string; embedUrl: string; snackId: string }> {
    try {
      const outputPath = this.storage.getOutputPath(projectId);
      const mobilePath = path.join(outputPath, 'reference-app', 'mobile');

      if (!fs.existsSync(mobilePath)) {
        throw new Error('Mobile app not found. Please generate the reference app first.');
      }

      // Read all files from the mobile directory
      const files = this.readMobileFiles(mobilePath);

      // Get project for metadata
      const project = this.storage.getProject(projectId);

      // Create Snack payload - dependencies at top level AND in manifest
      const dependencies = {
        'expo': '~50.0.0',
        'expo-status-bar': '~1.11.1',
        'react': '18.2.0',
        'react-native': '0.73.6',
        '@react-navigation/native': '^6.1.9',
        '@react-navigation/stack': '^6.3.20',
        'react-native-screens': '~3.29.0',
        'react-native-safe-area-context': '4.8.2',
        'react-native-gesture-handler': '~2.14.0',
        '@sentry/react-native': '~5.20.0',
        'axios': '^1.6.2',
      };

      const payload = {
        manifest: {
          name: project.project.name,
          description: project.project.notes || `Mobile demo app for ${project.project.name}`,
          sdkVersion: '50.0.0',
          dependencies,
        },
        code: files,
        dependencies, // Also at top level
      };

      // Make API request to create Snack
      const response = await fetch(this.snackApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Snack-Api-Version': '3.0.0',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create Snack: ${response.status} ${errorText.substring(0, 500)}`);
      }

      const data = await response.json();
      
      console.log('Snack API response:', JSON.stringify(data, null, 2));
      
      // Construct the correct Snack URL - just use the ID directly
      const snackId = data.id || data.hashId;
      const snackUrl = `https://snack.expo.dev/${snackId}`;
      const embedUrl = `https://snack.expo.dev/${snackId}?embed=true&preview=true`;

      // Save Snack info to project
      this.storage.updateProject(projectId, {
        snackUrl: snackUrl,
        snackId: snackId,
      });

      console.log('Constructed Snack URL:', snackUrl);
      console.log('Constructed Embed URL:', embedUrl);

      return {
        url: snackUrl,
        embedUrl: embedUrl,
        snackId: snackId,
      };
    } catch (error) {
      console.error('Error creating Snack:', error);
      throw error;
    }
  }

  async updateSnack(projectId: string): Promise<{ url: string; embedUrl: string }> {
    try {
      const project = this.storage.getProject(projectId);

      if (!project.snackId) {
        throw new Error('No Snack ID found. Please create a Snack first.');
      }

      // For Expo Snack, "updating" means creating a new Snack with the same name
      // The old Snack remains accessible at its URL
      // Just recreate the Snack with updated code
      const result = await this.createSnack(projectId);

      return {
        url: result.url,
        embedUrl: result.embedUrl,
      };
    } catch (error) {
      console.error('Error updating Snack:', error);
      throw error;
    }
  }

  private readMobileFiles(mobilePath: string): Record<string, { type: string; contents: string }> {
    const files: Record<string, { type: string; contents: string }> = {};

    // Read key files - Snack needs "ASSET" type for JSON files
    // Don't include sentry.config.ts since Sentry is initialized in App.tsx
    const filesToRead = [
      { path: 'App.tsx', key: 'App.tsx', type: 'CODE' },
      { path: 'app.json', key: 'app.json', type: 'ASSET' },
      { path: 'package.json', key: 'package.json', type: 'ASSET' },
      { path: 'screens/HomeScreen.tsx', key: 'screens/HomeScreen.tsx', type: 'CODE' },
      { path: 'screens/ProductDetailScreen.tsx', key: 'screens/ProductDetailScreen.tsx', type: 'CODE' },
      { path: 'navigation/AppNavigator.tsx', key: 'navigation/AppNavigator.tsx', type: 'CODE' },
      { path: 'services/api.ts', key: 'services/api.ts', type: 'CODE' },
    ];

    for (const file of filesToRead) {
      const filePath = path.join(mobilePath, file.path);
      if (fs.existsSync(filePath)) {
        files[file.key] = {
          type: file.type,
          contents: fs.readFileSync(filePath, 'utf-8'),
        };
      }
    }

    return files;
  }

  getSnackStatus(projectId: string): { hasSnack: boolean; url?: string; embedUrl?: string } {
    try {
      const project = this.storage.getProject(projectId);
      
      if (project.snackUrl && project.snackId) {
        return {
          hasSnack: true,
          url: project.snackUrl,
          embedUrl: `${project.snackUrl}/embedded`,
        };
      }

      return { hasSnack: false };
    } catch (error) {
      return { hasSnack: false };
    }
  }
}
