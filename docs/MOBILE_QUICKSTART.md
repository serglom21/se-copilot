# Mobile Tech Stack - Quick Start Guide

## What's New? 📱

SE Copilot now supports **React Native mobile apps** in addition to web apps! You can now:
- Choose between Web (Next.js) or Mobile (React Native) when creating a project
- Generate React Native + Expo apps with Sentry instrumentation
- Deploy to **Expo Snack** for browser-based testing (no Xcode/Android Studio needed!)
- Test on your actual phone using the Expo Go app

## How to Try It

### 1. Start the App

```bash
cd /Users/sergiolombana/Documents/SE\ Copilot
pnpm dev
```

### 2. Create a Mobile Project

1. Click **"➕ New Project"**
2. Fill in:
   - **Project Name**: "Mobile Demo App"
   - **Customer Vertical**: Choose any (e.g., "E-commerce")
   - **Tech Stack**: Select **"📱 Mobile App (React Native + Express)"** ← NEW!
   - **Notes**: "A mobile shopping app with product browsing and cart"
3. Click **"Create Project"**

### 3. Plan Instrumentation

1. In the **Planning** tab, chat with the AI:
   - "Help me plan instrumentation for a mobile shopping app"
   - AI will suggest mobile-specific spans like:
     - `navigation.screen_load`
     - `ui.button_press`
     - `api.fetch_products`
2. Review spans in the right panel
3. Click **"Lock Plan"** when ready

### 4. Generate the App

1. Go to **"📦 Generate"** tab
2. Click:
   - **"Generate Reference App"** ← Creates React Native code!
   - **"Generate Implementation Guide"**
   - **"Generate Dashboard JSON"**
3. Wait for generation to complete

### 5. Deploy to Expo Snack

1. Go to **"🖥️ Deploy"** tab (should now show **"📱 Mobile Deployment"**)
2. Click **"📱 Create Expo Snack"**
3. Wait ~10 seconds for upload
4. The **Expo Snack simulator** will appear on the right side!
5. You can now:
   - **Test in browser**: Use the embedded simulator
   - **Test on phone**: Scan the QR code with Expo Go app
   - **Share**: Click "🔗 Open in New Tab" to get a shareable link

### 6. Test on Your Phone (Optional)

1. Install **Expo Go** from your app store:
   - iOS: App Store
   - Android: Google Play Store
2. Open Expo Go
3. Scan the QR code from the Snack simulator
4. Your app runs on your real device! 🎉

## What Gets Generated?

Your mobile app will be generated at:
```
~/Documents/SE-Copilot-Output/mobile-demo-app/reference-app/mobile/
```

**Structure:**
```
mobile/
├── App.tsx                       # Root app with navigation
├── package.json                  # Dependencies
├── app.json                      # Expo config
├── sentry.config.ts              # Sentry initialization
├── screens/
│   ├── HomeScreen.tsx            # Product list
│   └── ProductDetailScreen.tsx  # Product detail
├── navigation/
│   └── AppNavigator.tsx          # React Navigation
└── services/
    └── api.ts                    # Backend API client
```

**Features:**
- ✅ Full Sentry instrumentation
- ✅ Custom spans from your plan
- ✅ React Navigation
- ✅ Styled UI components
- ✅ API integration
- ✅ TODO comments for customization

## Troubleshooting

### "Create Expo Snack" Button Not Working?

- Make sure you've clicked **"Generate Reference App"** first
- Check the console output for errors
- Click **"🤖 Ask AI for Help"** to troubleshoot

### Simulator Not Loading?

- Wait a few seconds - Expo Snack can be slow to load
- Try clicking **"🔄 Update Snack"** to refresh
- Check your internet connection

### Want to Update the Code?

1. Modify files in `~/Documents/SE-Copilot-Output/your-project/reference-app/mobile/`
2. Click **"🔄 Update Snack"** in the Deploy tab
3. The simulator will reload with your changes

### Testing with Backend

The mobile app needs a running backend. You can:
1. Run the backend locally: `cd backend && npm run dev`
2. Update `mobile/.env` with `EXPO_PUBLIC_API_URL=http://your-backend-url`
3. Deploy backend to a cloud service (Heroku, Railway, etc.)

## Differences from Web Projects

| Feature | Web (Next.js) | Mobile (React Native) |
|---------|---------------|----------------------|
| **Deployment** | Local servers (ports 3000/3001) | Expo Snack (browser simulator) |
| **Testing** | Browser only | Browser + Real device |
| **Spans** | Web-specific (checkout, payment) | Mobile-specific (navigation, UI, sensors) |
| **Development** | `npm run dev` locally | Expo Snack or Expo CLI |
| **Backend** | Auto-deployed locally | Backend URL must be configured |

## Next Steps

### For Web Projects (Existing Flow)

Everything works exactly as before! Select **"🌐 Web App"** when creating a project.

### For Mobile Projects

1. Try different verticals (SaaS, Gaming, Healthcare)
2. Add custom features to the generated code
3. Test with real data by using **"Run Data"** tab
4. Share the Expo Snack link for demos
5. Deploy to App Store / Play Store (requires ejecting from Expo)

## What's Under the Hood?

- **Expo**: React Native framework for easy development
- **Expo Snack**: Cloud-based RN playground
- **React Navigation**: Screen navigation
- **@sentry/react-native**: Sentry SDK for mobile
- **Axios**: HTTP client for API calls

All code is generated with:
- Custom Sentry spans from your instrumentation plan
- TODO comments indicating where to add custom features
- Project notes embedded in comments and README

## Feedback Welcome!

Test the mobile flow and report any issues. The AI troubleshooting chat is available if you encounter errors!

---

**Ready to build mobile apps with Sentry? Click "New Project" and select Mobile! 📱**
