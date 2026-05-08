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
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

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

// Rate limiting — 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', limiter);

// Multer for multipart image uploads (in-memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are accepted'));
  },
});

// ─── Health check ────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'bon-voyage-backend' }));

// ─── POST /api/identify ──────────────────────────────────────
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
// Accepts: JSON { landmark }
// Returns: { facts: string[] }   — 5 facts, each ~3 sentences
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

  const prompt = `You are a friendly travel guide. Tell me 5 interesting historical facts about ${landmark.trim()} in 3 sentences each. Keep it engaging and conversational. Return ONLY a valid JSON array of 5 strings, where each string is one fact (3 sentences). No markdown fences, no extra keys — just the raw JSON array.`;

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
        .slice(0, 5);
    }

    return res.json({ facts: facts.slice(0, 5), landmark: landmark.trim() });
  } catch (err) {
    console.error('[/api/facts]', err.message);
    return res.status(500).json({ error: 'Failed to generate facts.', detail: err.message });
  }
});

// ─── POST /api/nearby ────────────────────────────────────────
// Accepts: JSON { lat, lng, radius? }
// Returns: { places: [ { name, rating, type, photoUrl, placeId, vicinity } ] }
app.post('/api/nearby', async (req, res) => {
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

  const { lat, lng, radius = 1000 } = req.body || {};
  if (lat == null || lng == null) {
    return res.status(400).json({ error: 'Missing lat/lng fields.' });
  }

  const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!MAPS_KEY) {
    return res.status(500).json({ error: 'Maps API key not configured on server.' });
  }

  try {
    // Fetch tourist attractions
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
// Returns safe-to-expose config for the frontend (Maps embed key only)
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
app.listen(PORT, () => {
  console.log(`🚀 Bon Voyage backend running on port ${PORT}`);
  console.log(`   Gemini model : gemini-1.5-flash`);
  console.log(`   Vision client: lazy (ADC)`);
});
