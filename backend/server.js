'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const axios = require('axios');
const vision = require('@google-cloud/vision');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');

// ─── Named Constants ─────────────────────────────────────────
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_IMAGE_DECODED_BYTES = 7 * 1024 * 1024;
const NEARBY_RADIUS_DEFAULT = 1000;
const FACTS_COUNT = 5;
const MAX_LANDMARK_LENGTH = 300;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const FACTS_CACHE_TTL_MS = 60 * 60 * 1000;

// ─── In-memory facts cache ────────────────────────────────────
const factsCache = new Map();

// ─── Init ────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 8080;

let visionClient = null;
const getVisionClient = () => {
  if (!visionClient) visionClient = new vision.ImageAnnotatorClient();
  return visionClient;
};
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Gemini 1.5 Flash — cheapest + smart
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// ─── Middleware ──────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl) or matching origins
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));

// Attach a unique request ID to every response
app.use((req, res, next) => {
  res.setHeader('X-Request-ID', crypto.randomUUID());
  next();
});

// Rate limiting — 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', limiter);

// Disable browser/proxy caching for all API responses
app.use('/api/', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// Multer for multipart image uploads (in-memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are accepted'));
  },
});

// ─── Health check ────────────────────────────────────────────
/**
 * GET /health
 * Simple liveness probe — returns service name and status.
 */
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'bon-voyage-backend' }));

// ─── POST /api/identify ──────────────────────────────────────
/**
 * POST /api/identify
 * Accepts a multipart "image" field or JSON { imageBase64 }.
 * Calls Google Cloud Vision landmark detection and returns the top match.
 * @returns {{ landmark, lat, lng, confidence, allMatches }}
 */
app.post('/api/identify', upload.single('image'), async (req, res) => {
  if (process.env.MOCK_MODE === 'true') {
    return res.json({
      landmark: 'Eiffel Tower',
      lat: 48.8584,
      lng: 2.2945,
      confidence: 99.8,
      allMatches: [{ name: 'Eiffel Tower', confidence: 99.8 }]
    });
  }

  try {
    let imageBuffer;

    if (req.file) {
      imageBuffer = req.file.buffer;
    } else if (req.body?.imageBase64) {
      // Strip data URI prefix if present
      const base64 = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      imageBuffer = Buffer.from(base64, 'base64');
    } else {
      return res.status(400).json({ error: 'No image provided. Send multipart "image" field or JSON "imageBase64".' });
    }

    if (imageBuffer.length > MAX_IMAGE_DECODED_BYTES) {
      return res.status(400).json({ error: 'Image too large. Maximum decoded size is 7MB.' });
    }

    const [result] = await getVisionClient().landmarkDetection({ image: { content: imageBuffer } });
    const landmarks = result.landmarkAnnotations || [];

    if (landmarks.length === 0) {
      return res.status(422).json({
        error: 'No landmark detected in this image. Try a clearer photo of a famous landmark.',
      });
    }

    const top = landmarks[0];
    const location = top.locations?.[0]?.latLng || {};

    return res.json({
      landmark: top.description,
      lat: location.latitude ?? null,
      lng: location.longitude ?? null,
      confidence: parseFloat((top.score * 100).toFixed(1)),
      allMatches: landmarks.slice(0, 3).map(l => ({
        name: l.description,
        confidence: parseFloat((l.score * 100).toFixed(1)),
      })),
    });
  } catch (err) {
    console.error('[/api/identify]', err.message);
    return res.status(500).json({ error: 'Landmark detection failed.', detail: err.message });
  }
});

// ─── POST /api/facts ─────────────────────────────────────────
/**
 * POST /api/facts
 * Accepts: JSON { landmark }
 * Generates 5 interesting historical facts via Gemini.
 * Results are cached in-memory for FACTS_CACHE_TTL_MS.
 * @returns {{ facts: string[], landmark: string, cached?: boolean }}
 */
app.post('/api/facts', async (req, res) => {
  if (process.env.MOCK_MODE === 'true') {
    return res.json({
      landmark: 'Eiffel Tower',
      facts: [
        "The Eiffel Tower was originally built as a temporary entrance arch for the 1889 World's Fair, but it was so popular that it became a permanent fixture of Paris.",
        "Standing at 330 meters, it was the world's tallest man-made structure for 41 years until the Chrysler Building was completed in 1930.",
        "The tower actually grows and shrinks by about 15 centimeters depending on the temperature, due to the thermal expansion of the iron structure.",
        "It was almost demolished in 1909, but was saved because it proved useful for radio transmissions during the early days of telecommunication.",
        "Over 250 million people have visited the Eiffel Tower since it opened, making it the most-visited paid monument in the entire world."
      ]
    });
  }

  const { landmark } = req.body || {};
  if (!landmark || typeof landmark !== 'string' || landmark.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or invalid "landmark" field.' });
  }

  if (landmark.trim().length > MAX_LANDMARK_LENGTH) {
    return res.status(400).json({ error: `Landmark name too long. Maximum ${MAX_LANDMARK_LENGTH} characters.` });
  }

  // Strip HTML tags to prevent injection into prompts
  const safeLandmark = landmark.trim().replace(/<[^>]*>/g, '');

  // Return cached result if still fresh
  const cacheKey = safeLandmark.toLowerCase();
  const cached = factsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FACTS_CACHE_TTL_MS) {
    return res.json({ facts: cached.facts, landmark: safeLandmark, cached: true });
  }

  const prompt = `You are a friendly travel guide. Tell me 5 interesting historical facts about ${safeLandmark} in 3 sentences each. Keep it engaging and conversational. Return ONLY a valid JSON array of 5 strings, where each string is one fact (3 sentences). No markdown fences, no extra keys — just the raw JSON array.`;

  try {
    const result = await geminiModel.generateContent(prompt);
    const text = result.response.text().trim();

    // Parse JSON array from Gemini response
    let facts;
    try {
      // Handle potential markdown code fences
      const cleaned = text.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
      facts = JSON.parse(cleaned);
      if (!Array.isArray(facts) || facts.length === 0) throw new Error('Invalid shape');
    } catch {
      // Fallback: split by numbered list pattern
      facts = text
        .split(/\n(?=\d+[\.\)])/g)
        .map(s => s.replace(/^\d+[\.\)]\s*/, '').trim())
        .filter(Boolean)
        .slice(0, FACTS_COUNT);
    }

    factsCache.set(cacheKey, { facts: facts.slice(0, FACTS_COUNT), ts: Date.now() });

    return res.json({ facts: facts.slice(0, FACTS_COUNT), landmark: safeLandmark });
  } catch (err) {
    console.error('[/api/facts]', err.message);
    return res.status(500).json({ error: 'Failed to generate facts.', detail: err.message });
  }
});

/**
 * POST /api/translate
 * Translates a fact into the requested language using Gemini.
 */
app.post('/api/translate', async (req, res) => {
  const { fact, language } = req.body || {};
  if (!fact || typeof fact !== 'string' || fact.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or invalid "fact" field.' });
  }
  if (!language || typeof language !== 'string' || language.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or invalid "language" field.' });
  }
  if (process.env.MOCK_MODE === 'true') {
    return res.json({ translated: `${fact.trim()} (translated to ${language.trim()})` });
  }
  const safeFact = fact.trim().replace(/<[^>]*>/g, '').slice(0, 2000);
  const safeLang = language.trim().replace(/<[^>]*>/g, '').slice(0, 50);
  try {
    const result = await geminiModel.generateContent(
      `Translate the following text to ${safeLang}. Return ONLY the translated text, nothing else:\n\n${safeFact}`
    );
    return res.json({ translated: result.response.text().trim() });
  } catch (err) {
    console.error('[/api/translate]', err.message);
    return res.status(500).json({ error: 'Translation failed.', detail: err.message });
  }
});

// ─── POST /api/nearby ────────────────────────────────────────
/**
 * POST /api/nearby
 * Accepts: JSON { lat, lng, radius? }
 * Fetches nearby tourist attractions and restaurants via Google Places API.
 * @returns {{ places: Array<{ name, rating, category, photoUrl, placeId, vicinity, lat, lng }>, count: number }}
 */
app.post('/api/nearby', async (req, res) => {
  const { lat, lng, radius = NEARBY_RADIUS_DEFAULT } = req.body || {};
  if (lat == null || lng == null) {
    return res.status(400).json({ error: 'Missing lat/lng fields.' });
  }

  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'lat must be in [-90,90] and lng in [-180,180].' });
  }

  if (process.env.MOCK_MODE === 'true') {
    return res.json({
      places: [
        { name: "Le Jules Verne", rating: 4.6, category: "restaurant", photoUrl: "https://lh5.googleusercontent.com/p/AF1QipN_J5P5zW7vK8T9U1-X5fQ_WnE3Q9uO0yP1Y_jV=w400-h400-k-no" },
        { name: "Champ de Mars", rating: 4.7, category: "attraction", photoUrl: "https://lh5.googleusercontent.com/p/AF1QipO7Q-3n-K0_X-2xP8X-2xP8X-2xP8X-2xP8X-2xP=w400-h400-k-no" },
        { name: "Trocadéro Gardens", rating: 4.8, category: "attraction", photoUrl: "https://lh5.googleusercontent.com/p/AF1QipM7Q-3n-K0_X-2xP8X-2xP8X-2xP8X-2xP8X-2xP=w400-h400-k-no" },
        { name: "Café de l'Homme", rating: 4.2, category: "restaurant", photoUrl: "https://lh5.googleusercontent.com/p/AF1QipL7Q-3n-K0_X-2xP8X-2xP8X-2xP8X-2xP8X-2xP=w400-h400-k-no" },
        { name: "Musée du Quai Branly", rating: 4.5, category: "attraction", photoUrl: "https://lh5.googleusercontent.com/p/AF1QipK7Q-3n-K0_X-2xP8X-2xP8X-2xP8X-2xP8X-2xP=w400-h400-k-no" }
      ]
    });
  }

  const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!MAPS_KEY) {
    return res.status(500).json({ error: 'Maps API key not configured on server.' });
  }

  try {
    // Parallel fetch — attractions and restaurants fetched concurrently
    const [attractionsRes, restaurantsRes] = await Promise.all([
      axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
        params: {
          location: `${lat},${lng}`,
          radius,
          type: 'tourist_attraction',
          key: MAPS_KEY,
          rankby: 'prominence',
        },
      }),
      axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
        params: {
          location: `${lat},${lng}`,
          radius,
          type: 'restaurant',
          key: MAPS_KEY,
          rankby: 'prominence',
        },
      }),
    ]);

    const formatPlace = (p, category) => ({
      placeId: p.place_id,
      name: p.name,
      vicinity: p.vicinity || '',
      rating: p.rating ?? null,
      totalRatings: p.user_ratings_total ?? 0,
      category,
      isOpen: p.opening_hours?.open_now ?? null,
      photoUrl: p.photos?.[0]
        ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${p.photos[0].photo_reference}&key=${MAPS_KEY}`
        : null,
      lat: p.geometry?.location?.lat ?? null,
      lng: p.geometry?.location?.lng ?? null,
    });

    const attractions = (attractionsRes.data.results || []).slice(0, 3).map(p => formatPlace(p, 'attraction'));
    const restaurants = (restaurantsRes.data.results || []).slice(0, 2).map(p => formatPlace(p, 'restaurant'));
    const places = [...attractions, ...restaurants];

    return res.json({ places, count: places.length });
  } catch (err) {
    console.error('[/api/nearby]', err.message);
    return res.status(500).json({ error: 'Failed to fetch nearby places.', detail: err.message });
  }
});

// ─── GET /api/config ─────────────────────────────────────────
/**
 * GET /api/config
 * Returns safe-to-expose config for the frontend (Maps embed key only).
 * @returns {{ mapsApiKey: string }}
 */
app.get('/api/config', (_, res) => {
  res.json({
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  });
});

// ─── Error handler ───────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Unhandled]', err.message);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// ─── Start ───────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`🚀 Bon Voyage backend running on port ${PORT}`);
    console.log(`   Gemini model : gemini-2.5-flash`);
    console.log(`   Vision client: lazy (ADC)`);
  });
}

module.exports = app;
