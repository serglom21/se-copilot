# Mobile Tech Stack Implementation Summary

## Overview

SE Copilot now supports both **Web** and **Mobile** tech stacks. Users can choose between:
- **Web**: Next.js + Express (deployed locally)
- **Mobile**: React Native (Expo) + Express (deployed to Expo Snack)

## Implementation Details

### 1. Schema Updates (`apps/desktop/src/types/spec.ts`)

**Updated `StackConfigSchema`:**
```typescript
export const StackConfigSchema = z.object({
  type: z.enum(['web', 'mobile']).default('web'),
  frontend: z.string(), // 'nextjs' or 'react-native'
  backend: z.literal('express'),
  mobile_framework: z.enum(['react-native']).optional()
});
```

**Updated `EngagementSpecSchema`:**
- Added `snackUrl?: string` - Expo Snack URL for mobile projects
- Added `snackId?: string` - Expo Snack ID for updates

### 2. UI Updates

#### New Project Wizard (`apps/desktop/src/pages/NewProjectPage.tsx`)
- Added tech stack dropdown with options:
  - 🌐 Web App (Next.js + Express)
  - 📱 Mobile App (React Native + Express)
- Shows stack-specific info cards with deployment details
- Automatically sets `stack.type`, `stack.frontend`, and `stack.mobile_framework` based on selection

#### Deploy Page (`apps/desktop/src/pages/DeployPage.tsx`)
- **Conditional Rendering** based on `stack.type`:
  - **Web**: Shows local deployment UI (frontend/backend status, ports, URLs)
  - **Mobile**: Shows Expo Snack UI (create/update snack, embedded simulator)
- **Mobile Features**:
  - "📱 Create Expo Snack" button
  - Embedded Expo Snack simulator (iframe)
  - "🔄 Update Snack" to sync code changes
  - "🔗 Open in New Tab" to open full Snack in browser
  - Console output for deployment logs
  - AI troubleshooting chat support

### 3. LLM Service Updates (`apps/desktop/electron/services/llm.ts`)

**New Method: `generateCustomFeatures`**
- Generates custom code snippets based on project notes
- Parameters:
  - `project: EngagementSpec`
  - `componentType: 'screen' | 'api-endpoint' | 'component'`
- Returns: `Array<{ code: string; description: string }>`
- **Use Case**: Generate app-specific screens/components based on user requirements

**Updated `buildSystemPrompt`**
- Now stack-aware (web vs mobile)
- Suggests mobile-specific span operations:
  - `navigation.screen_load`
  - `ui.button_press`
  - `api.fetch`
  - `sensor.camera`, `sensor.location`

**Updated `generateInstrumentationPlan`**
- Generates mobile-appropriate instrumentation
- Adjusts examples and suggestions based on stack type

### 4. Generator Service Updates (`apps/desktop/electron/services/generator.ts`)

**Updated `generateReferenceApp`**
- Checks `project.stack.type`
- Routes to appropriate generator:
  - Web: `generateFrontend()` + `generateBackend()`
  - Mobile: `generateReactNativeApp()` + `generateBackend()`

**New Methods for React Native Generation:**

1. `createMobileDirectoryStructure(appPath)` - Creates folder structure
2. `generateReactNativeApp(appPath, project)` - Main orchestrator
3. `generateReactNativePackageJson(mobilePath, project)` - Dependencies
4. `generateReactNativeAppJson(mobilePath, project)` - Expo config
5. `generateReactNativeBabelConfig(mobilePath)` - Babel setup
6. `generateReactNativeSentryConfig(mobilePath, project)` - Sentry init
7. `generateReactNativeAppTsx(mobilePath, project)` - Root App.tsx
8. `generateReactNativeScreens(mobilePath, project)` - Home & Product screens
9. `generateReactNativeNavigation(mobilePath, project)` - React Navigation setup
10. `generateReactNativeServices(mobilePath, project)` - API client

**Generated React Native Structure:**
```
mobile/
├── App.tsx                       # Root with Navigation
├── package.json                  # Expo + Sentry dependencies
├── app.json                      # Expo config
├── babel.config.js               # Babel + Sentry
├── sentry.config.ts              # Sentry initialization
├── .env.example                  # Environment variables
├── README.md                     # Project documentation
├── screens/
│   ├── HomeScreen.tsx            # Product list
│   └── ProductDetailScreen.tsx  # Product details
├── navigation/
│   └── AppNavigator.tsx          # Stack navigator
└── services/
    └── api.ts                    # Backend API client
```

**Key Features of Generated Mobile App:**
- Full Sentry instrumentation with custom spans
- React Navigation with Stack Navigator
- Styled with React Native StyleSheet
- API integration with Express backend
- TODO comments for custom feature implementation
- Project notes embedded in code and README

### 5. Expo Deploy Service (`apps/desktop/electron/services/expo-deploy.ts`)

**New Service** - Handles Expo Snack integration

**Methods:**
- `createSnack(projectId)` - Uploads code to Expo Snack API
- `updateSnack(projectId)` - Updates existing Snack
- `getSnackStatus(projectId)` - Checks if Snack exists

**Expo Snack API Integration:**
- Endpoint: `https://snack.expo.dev/--/api/v2/snacks`
- Method: POST (create), PUT (update)
- Payload: Files + dependencies + SDK version
- Response: Snack ID + URL + Embed URL

**Files Uploaded to Snack:**
- App.tsx
- sentry.config.ts
- app.json
- package.json
- All screens
- Navigation
- Services

### 6. IPC Handlers (`apps/desktop/electron/main.ts`)

**New Handlers:**
- `expo:create-snack` - Creates Expo Snack
- `expo:update-snack` - Updates existing Snack
- `expo:get-status` - Gets Snack status
- `expo:open-url` - Opens URL in external browser

**Preload API (`apps/desktop/electron/preload.ts`):**
- `createExpoSnack(projectId)`
- `updateExpoSnack(projectId)`
- `getExpoSnackStatus(projectId)`
- `openExpoUrl(url)`

## User Flow

### Creating a Mobile Project

1. **New Project** → Select "📱 Mobile App (React Native + Express)"
2. **Planning** → Chat with AI to define instrumentation plan
   - AI suggests mobile-specific spans (navigation, UI events, sensors)
   - Spans auto-added to right panel
3. **Generate** → Click "Generate Reference App"
   - Creates React Native + Expo app
   - Generates Express backend
   - Creates implementation guide
   - Creates dashboard JSON
4. **Deploy** → Click "📱 Create Expo Snack"
   - Uploads code to Expo Snack
   - Displays embedded simulator
   - Provides shareable link
5. **Test** → 
   - Use browser simulator
   - Scan QR code with Expo Go app on phone
   - Open in new tab for fullscreen

### Testing Mobile App on Device

1. Install **Expo Go** app from App Store / Play Store
2. Click "Create Expo Snack" in Deploy tab
3. In the Expo Snack simulator, find the QR code
4. Scan with Expo Go app
5. App runs on your physical device!

## Architecture

```
User Input (Mobile Stack)
    ↓
New Project Wizard
    ↓
Project Created (stack.type = 'mobile')
    ↓
Planning Phase (LLM suggests mobile spans)
    ↓
Generate Phase
    ├→ React Native App (Expo)
    │   ├─ Screens
    │   ├─ Navigation
    │   ├─ Services
    │   └─ Sentry Config
    └→ Express Backend (same as web)
    ↓
Deploy Phase
    ├→ Read mobile files
    ├→ Upload to Expo Snack API
    ├→ Get Snack URL & Embed URL
    └→ Display in iframe simulator
    ↓
Test in Browser / Device
```

## Key Design Decisions

1. **Minimal Template + LLM Enhancement**
   - Generator creates boilerplate (navigation, Sentry, API)
   - LLM method available for custom feature injection (future)
   - TODO comments guide developers on customization

2. **Expo Snack for Deployment**
   - No local Xcode/Android Studio required
   - Works in browser
   - Shareable links for demos
   - QR code for device testing
   - Free tier: 100 snacks/month

3. **Shared Backend**
   - Mobile apps use same Express backend as web
   - Reduces code duplication
   - Consistent API

4. **Progressive Enhancement**
   - Web deployment unchanged
   - Mobile is additive feature
   - Backward compatible

5. **Stack-Aware LLM**
   - Different suggestions for web vs mobile
   - Mobile-specific span operations
   - Context-appropriate examples

## Testing Checklist

- [x] Schema validation (web and mobile projects)
- [x] New Project wizard (stack selection)
- [x] LLM suggestions (mobile-specific spans)
- [x] React Native code generation
- [x] Expo Snack deployment
- [ ] End-to-end: Create mobile project → Generate → Deploy to Snack
- [ ] Verify Snack simulator loads
- [ ] Test on physical device with Expo Go
- [ ] Update Snack after code changes
- [ ] AI troubleshooting chat for mobile errors

## Future Enhancements

1. **LLM-Driven Custom Features**
   - Use `generateCustomFeatures()` to inject custom screens based on notes
   - Replace hardcoded e-commerce flow with dynamic generation

2. **More Mobile Frameworks**
   - Native Swift for iOS
   - Native Kotlin for Android
   - Flutter

3. **Alternative Deployment Options**
   - Appetize.io (premium simulator)
   - React Native Web (PWA)
   - Local iOS Simulator / Android Emulator

4. **Enhanced Mobile Features**
   - Camera integration
   - Geolocation
   - Push notifications
   - Biometric auth
   - Deep linking

5. **Mobile-Specific Dashboards**
   - App launch metrics
   - Screen view analytics
   - Crash reporting
   - Performance vitals

## Known Limitations

1. **Expo Snack API Limits**
   - Free tier: 100 snacks/month
   - File size limits
   - Some native modules not supported in Snack

2. **No Automatic Custom Feature Generation**
   - `generateCustomFeatures()` implemented but not yet called
   - Apps use generic e-commerce template
   - Developers must implement project-specific features manually

3. **Backend Not Deployed for Mobile**
   - Backend must be deployed separately or run locally
   - Mobile app needs backend URL configured in `.env`

4. **Limited Styling**
   - Basic React Native StyleSheet
   - No advanced UI libraries (NativeBase, React Native Paper)

## Dependencies

**No new dependencies added!**
- Uses built-in `fetch` API (Node.js 18+)
- Expo Snack uses their public API
- All existing dependencies support both stacks

## Files Modified

1. `apps/desktop/src/types/spec.ts` - Schema updates
2. `apps/desktop/src/pages/NewProjectPage.tsx` - Stack selection
3. `apps/desktop/src/pages/DeployPage.tsx` - Mobile deployment UI
4. `apps/desktop/electron/main.ts` - IPC handlers
5. `apps/desktop/electron/preload.ts` - API exposure
6. `apps/desktop/electron/services/llm.ts` - Stack-aware LLM
7. `apps/desktop/electron/services/generator.ts` - React Native generation
8. `apps/desktop/electron/services/expo-deploy.ts` - **NEW** Expo integration

## Documentation

- This file: Implementation details
- `README.md`: Updated with mobile features
- `docs/USER_GUIDE.md`: Should be updated with mobile workflow
- Generated `mobile/README.md`: Project-specific instructions
