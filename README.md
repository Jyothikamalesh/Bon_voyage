# ✈ Bon Voyage — Landmark Explorer

A premium landmark explorer POC built with 100% Google Cloud & AI tools. Point your camera at a landmark, and instantly get historical facts from Gemini and a map of nearby tourist spots.

## 🚀 Tech Stack

- **Frontend**: Vanilla HTML5/CSS3/JS (Firebase Hosting)
- **Backend**: Node.js Express (Cloud Run)
- **AI/ML**: 
  - **Google Cloud Vision API**: Landmark detection & geolocation
  - **Gemini 1.5 Flash**: Historical fact generation
- **Maps**: 
  - **Google Maps JS API**: Interactive maps
  - **Google Places API**: Nearby attractions & restaurants
- **CI/CD**: GitHub Actions

## 🛠 Setup Instructions

### 1. Google Cloud Project
1. Create a project on [GCP Console](https://console.cloud.google.com/).
2. Enable the following APIs:
   - Cloud Vision API
   - Cloud Run Admin API
   - Artifact Registry API
   - Google Maps JavaScript API
   - Places API (New)
   - Generative Language API (for Gemini)

### 2. Firebase Setup
1. Initialize Firebase in the project: `firebase init hosting`
2. Link to your GCP project: `firebase use bonvoyage-45fce`

### 3. Environment Variables (Backend)
Create a `backend/.env` file (see `backend/.env.example`):
```env
GEMINI_API_KEY=your_key
GOOGLE_MAPS_API_KEY=your_key
GCP_PROJECT_ID=bonvoyage-45fce
```

### 4. GitHub Secrets
Add these secrets to your GitHub repository for CI/CD:
- `GCP_PROJECT_ID`: `bonvoyage-45fce`
- `GCP_SA_KEY`: JSON key of a Service Account with `Cloud Run Admin`, `Storage Admin`, and `Artifact Registry Administrator` roles.
- `FIREBASE_SERVICE_ACCOUNT_BONVOYAGE_45FCE`: Firebase CI token (get via `firebase login:ci`).
- `GEMINI_API_KEY`: Your Gemini API key.
- `GOOGLE_MAPS_API_KEY`: Your Google Maps API key.

## 📂 Project Structure

```text
├── .github/workflows/    # CI/CD (Deploy & Preview)
├── backend/              # Node.js Cloud Run service
│   ├── server.js         # Vision + Gemini + Places logic
│   └── Dockerfile        # Container config
├── public/               # Frontend Assets
│   ├── index.html        # UI Structure
│   ├── styles.css        # Premium Glassmorphism Design
│   └── app.js            # Camera & API Integration
├── firebase.json         # Hosting + Cloud Run rewrites
└── .firebaserc           # Firebase project config
```

## 📸 Usage
1. Open the app on a mobile device (requires HTTPS).
2. Allow camera permissions.
3. Take a photo of a famous landmark.
4. Watch as the AI identifies the place and Gemini tells you its history!
