# ✈ Bon Voyage — AI Landmark Explorer

> Point your camera at any landmark. Instantly discover its history, location, and nearby spots — powered entirely by Google Cloud AI.

---

## Features

### Camera & Image Input
- **Live camera feed** — streams directly from the device rear camera (defaults to `environment` mode)
- **Front/rear camera flip** — toggle between front and rear cameras mid-session
- **Capture photo** — tap the shutter button to freeze a frame from the live feed
- **Gallery upload** — pick any existing image from the device file system
- **Retake** — discard the captured photo and return to live camera without losing state

### Landmark Identification (Google Cloud Vision API)
- Sends the captured image to Google Cloud Vision's **landmark detection** endpoint
- Returns the **top landmark name** with a **confidence score** (0–100%)
- Extracts **GPS coordinates** (lat/lng) directly from the Vision API response
- Shows up to **3 alternative matches** for ambiguous images
- Gracefully rejects non-landmark images with a user-facing error

### Historical Facts (Gemini 1.5 Flash)
- Sends the identified landmark name to **Gemini 1.5 Flash** with a structured prompt
- Generates **5 historical facts**, each ~3 sentences, in a friendly travel-guide tone
- Parses Gemini's response as a JSON array; falls back to numbered-list parsing if needed
- Facts animate in sequentially with staggered delay for a polished reveal

### Interactive Map (Google Maps JavaScript API)
- Renders a **dark-themed Google Map** centred on the landmark's GPS coordinates
- Drops an animated **location pin** on the exact spot
- Map API key is loaded **dynamically at runtime** from the backend (`/api/config`) — the key is never bundled in frontend source

### Nearby Places (Google Places API)
- On-demand: tap **"Discover Nearby Spots"** to fetch places within 1 km
- Fetches **top 3 tourist attractions** and **top 2 restaurants** in parallel
- Each place card shows: name, star rating, category icon, and a **photo thumbnail**
- Places are fetched in the background so the results screen appears without waiting

### Loading Experience
- Three-step animated progress indicator:
  1. Landmark Detection (Vision API)
  2. Generating Facts (Gemini)
  3. Loading Map
- Each step transitions from idle → active → done (with a checkmark) as it completes

### Security & Performance (Backend)
- **Rate limiting** — 60 requests/min per IP via `express-rate-limit`
- **Helmet** — sets secure HTTP headers on all responses
- **CORS allowlist** — configurable via `ALLOWED_ORIGINS` environment variable
- **10 MB upload cap** — enforced by both Multer (multipart) and Express JSON body parser
- **Image-only filter** — Multer rejects non-image MIME types before hitting the API
- **Mock mode** — set `MOCK_MODE=true` to run the entire API stack with fixture data (no API keys needed), ideal for demos and local development

### Deployment & CI/CD
- **Frontend** hosted on **Firebase Hosting** with long-term cache headers for JS/CSS assets
- **Backend** containerised with Docker and deployed to **Google Cloud Run**
- **GitHub Actions** workflows:
  - `deploy.yml` — builds & deploys backend to Cloud Run, then deploys frontend to Firebase on push to `main`
  - `preview.yml` — spins up a Firebase preview channel for every pull request
- Security headers set at the Firebase Hosting layer: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (camera allowed)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML5 / CSS3 / JavaScript |
| Backend | Node.js + Express (Cloud Run) |
| Landmark Detection | Google Cloud Vision API |
| AI Facts | Google Gemini 1.5 Flash |
| Maps | Google Maps JavaScript API |
| Nearby Places | Google Places API (Nearby Search) |
| Hosting | Firebase Hosting |
| CI/CD | GitHub Actions |

---

## Project Structure

```
├── .github/workflows/
│   ├── deploy.yml        # Production deploy (Cloud Run + Firebase)
│   └── preview.yml       # PR preview channel
├── backend/
│   ├── server.js         # Express API: /identify, /facts, /nearby, /config
│   ├── Dockerfile        # Container image
│   ├── package.json
│   └── .env.example      # Required environment variables
├── public/
│   ├── index.html        # App shell & UI structure
│   ├── app.js            # Camera logic, API calls, map rendering
│   └── styles.css        # Glassmorphism dark-mode design
├── firebase.json         # Hosting config + security headers
└── .firebaserc           # Firebase project binding
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/identify` | Detect landmark from image (multipart or base64 JSON) |
| `POST` | `/api/facts` | Generate 5 historical facts for a named landmark |
| `POST` | `/api/nearby` | Fetch top attractions & restaurants near a lat/lng |
| `GET` | `/api/config` | Return the Maps API key for frontend use |
| `GET` | `/health` | Health check |

---

## Setup

### 1. Enable Google Cloud APIs
In your GCP project, enable:
- Cloud Vision API
- Generative Language API (Gemini)
- Google Maps JavaScript API
- Places API

### 2. Backend environment variables
Create `backend/.env` (see `backend/.env.example`):
```env
GEMINI_API_KEY=your_gemini_key
GOOGLE_MAPS_API_KEY=your_maps_key
GCP_PROJECT_ID=your_project_id
ALLOWED_ORIGINS=https://your-firebase-app.web.app
# Optional: MOCK_MODE=true for demo without API keys
```

### 3. GitHub Secrets (for CI/CD)
| Secret | Value |
|---|---|
| `GCP_PROJECT_ID` | Your GCP project ID |
| `GCP_SA_KEY` | Service account JSON with Cloud Run + Artifact Registry roles |
| `FIREBASE_SERVICE_ACCOUNT_*` | Firebase CI token (`firebase login:ci`) |
| `GEMINI_API_KEY` | Gemini API key |
| `GOOGLE_MAPS_API_KEY` | Maps API key |

### 4. Run locally
```bash
# Backend (with mock data — no API keys needed)
cd backend
MOCK_MODE=true node server.js

# Frontend — open public/index.html via any local static server
npx serve public
```

---

## Usage

1. Open the app on a mobile device (HTTPS required for camera access).
2. Grant camera permissions when prompted.
3. Point the camera at a famous landmark and tap the shutter.
4. The app identifies the landmark, streams historical facts from Gemini, and pins it on the map.
5. Tap **"Discover Nearby Spots"** to surface top attractions and restaurants within 1 km.
