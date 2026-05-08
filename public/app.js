/**
 * Bon Voyage — Frontend Logic
 * Point. Discover. Explore.
 */

'use strict';

// ─── Constants & State ───────────────────────────────────────
const API_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://localhost:8080/api'
  : '/api';
let stream = null;
let currentFacingMode = 'environment'; // Default to rear camera
let mapsLoaded = false;
let mapInstance = null;
let googleMapsApiKey = null;
let activeTab = 'scan';
let exploreMapInstance = null;
let currentUserLocation = null;

// DOM Elements
const els = {
  video: document.getElementById('camera-feed'),
  canvas: document.getElementById('snapshot-canvas'),
  photoPreviewWrapper: document.getElementById('photo-preview-wrapper'),
  capturedPhoto: document.getElementById('captured-photo'),
  videoWrapper: document.getElementById('video-wrapper'),
  cameraControls: document.getElementById('camera-controls'),
  
  // Sections
  cameraSection: document.getElementById('camera-section'),
  loadingSection: document.getElementById('loading-section'),
  resultsSection: document.getElementById('results-section'),
  errorSection: document.getElementById('error-section'),
  
  // Buttons
  captureBtn: document.getElementById('capture-btn'),
  retakeBtn: document.getElementById('retake-btn'),
  identifyBtn: document.getElementById('identify-btn'),
  uploadBtn: document.getElementById('upload-btn'),
  flipBtn: document.getElementById('flip-btn'),
  fileInput: document.getElementById('file-input'),
  nearbyBtn: document.getElementById('nearby-btn'),
  resetBtn: document.getElementById('reset-btn'),
  errorRetryBtn: document.getElementById('error-retry-btn'),
  
  // Results UI
  landmarkName: document.getElementById('landmark-name'),
  confidenceText: document.getElementById('confidence-text'),
  resultThumbnail: document.getElementById('result-thumbnail'),
  factsGrid: document.getElementById('facts-grid'),
  nearbyGrid: document.getElementById('nearby-grid'),
  
  // Loading Steps
  stepVision: document.getElementById('step-vision'),
  stepGemini: document.getElementById('step-gemini'),
  stepMaps: document.getElementById('step-maps'),
};

// ─── Initialization ──────────────────────────────────────────
async function init() {
  // Fetch config non-blocking — camera works even if backend is down
  fetchJson(`${API_BASE}/config`)
    .then(config => { googleMapsApiKey = config.mapsApiKey; })
    .catch(err => console.warn('Config fetch failed (Maps may not work):', err.message));

  try {
    await startCamera();
    bindEvents();
  } catch (err) {
    showError('Initialization Failed', 'Please ensure camera permissions are granted and try again.');
    console.error('Init error:', err);
  }
}

function bindEvents() {
  els.captureBtn.onclick = capturePhoto;
  els.retakeBtn.onclick = () => switchMode('camera');
  els.identifyBtn.onclick = processLandmark;
  els.uploadBtn.onclick = () => els.fileInput.click();
  els.fileInput.onchange = handleFileUpload;
  els.flipBtn.onclick = flipCamera;
  els.nearbyBtn.onclick = toggleNearby;
  els.resetBtn.onclick = resetApp;
  els.errorRetryBtn.onclick = resetApp;

  document.getElementById('tab-scan').onclick = () => switchTab('scan');
  document.getElementById('tab-explore').onclick = () => switchTab('explore');
  document.getElementById('locate-btn').onclick = locateAndExplore;
  document.getElementById('refresh-location-btn').onclick = locateAndExplore;

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const filter = btn.dataset.filter;
      document.querySelectorAll('.explore-card').forEach(card => {
        card.classList.toggle('hidden', filter !== 'all' && card.dataset.category !== filter);
      });
    };
  });
}

// ─── Camera Logic ───────────────────────────────────────────
async function startCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }

  try {
    // Try requested facing mode first, fall back to any camera (desktop has no rear camera)
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: currentFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    els.video.srcObject = stream;
    switchMode('camera');
  } catch (err) {
    console.error('Camera access denied:', err);
    showError('Camera Error', 'Could not access your camera. Please check permissions.');
  }
}

function flipCamera() {
  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  startCamera();
}

function capturePhoto() {
  const context = els.canvas.getContext('2d');
  els.canvas.width = els.video.videoWidth;
  els.canvas.height = els.video.videoHeight;
  context.drawImage(els.video, 0, 0);
  
  const dataUrl = els.canvas.toDataURL('image/jpeg');
  els.capturedPhoto.src = dataUrl;
  switchMode('preview');
}

function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    els.capturedPhoto.src = event.target.result;
    switchMode('preview');
  };
  reader.readAsDataURL(file);
}

// ─── API Interaction ────────────────────────────────────────
async function processLandmark() {
  const imageBase64 = els.capturedPhoto.src;
  
  switchMode('loading');
  setStep('vision', 'active');
  
  try {
    // 1. Identify Landmark (Cloud Vision)
    const idResult = await fetchJson(`${API_BASE}/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64 })
    });

    if (idResult.error) throw new Error(idResult.error);

    setStep('vision', 'done');
    setStep('gemini', 'active');

    // 2. Get Facts (Gemini)
    const factsResult = await fetchJson(`${API_BASE}/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ landmark: idResult.landmark })
    });

    setStep('gemini', 'done');
    setStep('maps', 'active');

    // 3. Load Map & Nearby
    await renderResults(idResult, factsResult);
    
    setStep('maps', 'done');
    switchMode('results');

  } catch (err) {
    console.error('Processing error:', err);
    showError('Identification Failed', err.message || 'Something went wrong.');
  }
}

async function renderResults(id, factsData) {
  // Update Landmark Header
  els.landmarkName.textContent = id.landmark;
  els.confidenceText.textContent = `${id.confidence}% confidence`;
  els.resultThumbnail.src = els.capturedPhoto.src;

  // Render Facts
  els.factsGrid.innerHTML = '';
  factsData.facts.forEach((fact, i) => {
    const card = document.createElement('div');
    card.className = 'fact-card';
    card.style.animationDelay = `${i * 0.15}s`;
    card.innerHTML = `<p>${fact}</p>`;
    els.factsGrid.appendChild(card);
  });

  // Load Maps API if not loaded
  if (!mapsLoaded) {
    await loadGoogleMaps();
  }

  // Initialize Map
  const position = { lat: id.lat, lng: id.lng };
  mapInstance = new google.maps.Map(document.getElementById('google-map'), {
    center: position,
    zoom: 15,
    styles: darkMapStyle,
    disableDefaultUI: true
  });

  new google.maps.Marker({
    position,
    map: mapInstance,
    title: id.landmark,
    animation: google.maps.Animation.DROP
  });

  // Fetch Nearby Spots (Don't await, let it load in background)
  fetchNearby(id.lat, id.lng);
}

async function fetchNearby(lat, lng) {
  try {
    const data = await fetchJson(`${API_BASE}/nearby`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng })
    });

    els.nearbyGrid.innerHTML = '';
    data.places.forEach((place, i) => {
      const card = document.createElement('div');
      card.className = 'place-card';
      card.style.animation = `slideUp 0.5s ease-out ${i * 0.1}s both`;
      
      const photo = place.photoUrl || 'https://via.placeholder.com/400x400/1a1a2e/ffffff?text=No+Photo';
      
      card.innerHTML = `
        <img src="${photo}" class="place-img" alt="${place.name}">
        <div class="place-info">
          <div class="place-name">${place.name}</div>
          <div class="place-meta">
            <span class="rating-star">★</span> ${place.rating || 'N/A'}
            • ${place.category === 'attraction' ? '🏛️' : '🍴'}
          </div>
        </div>
      `;
      els.nearbyGrid.appendChild(card);
    });
  } catch (err) {
    console.error('Nearby error:', err);
  }
}

function toggleNearby() {
  const isHidden = els.nearbyGrid.style.display === 'none';
  els.nearbyGrid.style.display = isHidden ? 'grid' : 'none';
  if (isHidden) {
    els.nearbyGrid.scrollIntoView({ behavior: 'smooth' });
  }
}

// ─── Tab Switcher ───────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tab-scan').classList.toggle('active', tab === 'scan');
  document.getElementById('tab-explore').classList.toggle('active', tab === 'explore');
  const exploreSection = document.getElementById('explore-section');

  if (tab === 'explore') {
    els.cameraSection.style.display = 'none';
    els.loadingSection.style.display = 'none';
    els.resultsSection.style.display = 'none';
    els.errorSection.style.display = 'none';
    exploreSection.style.display = 'block';
  } else {
    exploreSection.style.display = 'none';
    switchMode('camera');
  }
}

// ─── UI Utilities ───────────────────────────────────────────
function switchMode(mode) {
  // Hide all sections
  document.getElementById('explore-section').style.display = 'none';
  els.videoWrapper.style.display = 'none';
  els.photoPreviewWrapper.style.display = 'none';
  els.cameraControls.style.display = 'none';
  els.cameraSection.style.display = 'none';
  els.loadingSection.style.display = 'none';
  els.resultsSection.style.display = 'none';
  els.errorSection.style.display = 'none';

  switch (mode) {
    case 'camera':
      els.cameraSection.style.display = 'block';
      els.videoWrapper.style.display = 'block';
      els.cameraControls.style.display = 'flex';
      break;
    case 'preview':
      els.cameraSection.style.display = 'block';
      els.photoPreviewWrapper.style.display = 'block';
      break;
    case 'loading':
      els.loadingSection.style.display = 'flex';
      resetSteps();
      break;
    case 'results':
      els.resultsSection.style.display = 'block';
      break;
    case 'error':
      els.errorSection.style.display = 'block';
      break;
  }
}

function setStep(stepId, state) {
  const el = els[`step${stepId.charAt(0).toUpperCase() + stepId.slice(1)}`];
  if (!el) return;
  
  el.classList.remove('active', 'done');
  if (state === 'active') el.classList.add('active');
  if (state === 'done') {
    el.classList.add('active');
    el.querySelector('.step-dot').innerHTML = '✓';
    el.querySelector('.step-dot').style.background = 'var(--success)';
  }
}

function resetSteps() {
  ['Vision', 'Gemini', 'Maps'].forEach(s => {
    const el = els[`step${s}`];
    el.classList.remove('active', 'done');
    el.querySelector('.step-dot').innerHTML = '';
    el.querySelector('.step-dot').style.background = '';
  });
}

function showError(title, message) {
  document.getElementById('error-title').textContent = title;
  document.getElementById('error-message').textContent = message;
  switchMode('error');
}

function resetApp() {
  els.nearbyGrid.style.display = 'none';
  switchMode('camera');
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown Error' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function loadGoogleMaps() {
  return new Promise((resolve, reject) => {
    if (mapsLoaded) return resolve();
    
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${googleMapsApiKey}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      mapsLoaded = true;
      resolve();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

const darkMapStyle = [
  { "elementType": "geometry", "stylers": [{ "color": "#242f3e" }] },
  { "elementType": "labels.text.stroke", "stylers": [{ "color": "#242f3e" }] },
  { "elementType": "labels.text.fill", "stylers": [{ "color": "#746855" }] },
  {
    "featureType": "administrative.locality",
    "elementType": "labels.text.fill",
    "stylers": [{ "color": "#d59563" }]
  },
  {
    "featureType": "poi",
    "elementType": "labels.text.fill",
    "stylers": [{ "color": "#d59563" }]
  },
  {
    "featureType": "poi.park",
    "elementType": "geometry",
    "stylers": [{ "color": "#263c3f" }]
  },
  {
    "featureType": "poi.park",
    "elementType": "labels.text.fill",
    "stylers": [{ "color": "#6b9a76" }]
  },
  {
    "featureType": "road",
    "elementType": "geometry",
    "stylers": [{ "color": "#38414e" }]
  },
  {
    "featureType": "road",
    "elementType": "geometry.stroke",
    "stylers": [{ "color": "#212a37" }]
  },
  {
    "featureType": "road",
    "elementType": "labels.text.fill",
    "stylers": [{ "color": "#9ca5b3" }]
  },
  {
    "featureType": "road.highway",
    "elementType": "geometry",
    "stylers": [{ "color": "#746855" }]
  },
  {
    "featureType": "road.highway",
    "elementType": "geometry.stroke",
    "stylers": [{ "color": "#1f2835" }]
  },
  {
    "featureType": "road.highway",
    "elementType": "labels.text.fill",
    "stylers": [{ "color": "#f3d19c" }]
  },
  {
    "featureType": "water",
    "elementType": "geometry",
    "stylers": [{ "color": "#17263c" }]
  },
  {
    "featureType": "water",
    "elementType": "labels.text.fill",
    "stylers": [{ "color": "#515c6d" }]
  },
  {
    "featureType": "water",
    "elementType": "labels.text.stroke",
    "stylers": [{ "color": "#17263c" }]
  }
];

// ─── Explore Nearby Logic ───────────────────────────────────
async function locateAndExplore() {
  const prompt = document.getElementById('explore-prompt');
  const loading = document.getElementById('explore-loading');
  const loaded = document.getElementById('explore-loaded');

  prompt.style.display = 'none';
  loading.style.display = 'block';
  loaded.style.display = 'none';

  try {
    const position = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 })
    );

    const { latitude: lat, longitude: lng } = position.coords;
    currentUserLocation = { lat, lng };

    if (!mapsLoaded) await loadGoogleMaps();

    const [nearbyData] = await Promise.all([
      fetchJson(`${API_BASE}/nearby`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng, radius: 1500 })
      })
    ]);

    loading.style.display = 'none';
    loaded.style.display = 'block';

    // Reset filter to "All"
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.filter-btn[data-filter="all"]').classList.add('active');

    renderExploreMap(lat, lng, nearbyData.places);
    renderExplorePlaces(nearbyData.places);

  } catch (err) {
    console.error('Explore error:', err);
    loading.style.display = 'none';
    prompt.style.display = 'block';
    prompt.querySelector('.explore-prompt-desc').textContent =
      err.code === 1
        ? 'Location access denied. Please allow location in your browser settings.'
        : 'Could not get your location. Please try again.';
  }
}

function renderExploreMap(lat, lng, places) {
  const center = { lat, lng };
  exploreMapInstance = new google.maps.Map(document.getElementById('explore-map'), {
    center,
    zoom: 15,
    styles: darkMapStyle,
    disableDefaultUI: true,
    zoomControl: true,
  });

  // User location marker
  new google.maps.Marker({
    position: center,
    map: exploreMapInstance,
    title: 'You are here',
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 10,
      fillColor: '#6366f1',
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 2,
    }
  });

  // Place markers
  places.forEach(place => {
    if (!place.lat || !place.lng) return;
    const marker = new google.maps.Marker({
      position: { lat: place.lat, lng: place.lng },
      map: exploreMapInstance,
      title: place.name,
      label: {
        text: place.category === 'restaurant' ? '🍴' : '🏛️',
        fontSize: '16px',
      }
    });

    const infoWindow = new google.maps.InfoWindow({
      content: `<div style="color:#000;font-family:sans-serif;font-size:13px;padding:4px 6px">
        <strong>${place.name}</strong><br>
        ★ ${place.rating || 'N/A'}
      </div>`
    });
    marker.addListener('click', () => infoWindow.open(exploreMapInstance, marker));
  });
}

function renderExplorePlaces(places) {
  const grid = document.getElementById('explore-grid');
  grid.innerHTML = '';

  if (!places.length) {
    grid.innerHTML = '<p style="color:var(--text-muted);grid-column:1/-1;text-align:center;padding:2rem">No places found nearby.</p>';
    return;
  }

  places.forEach((place, i) => {
    const card = document.createElement('div');
    card.className = 'explore-card';
    card.dataset.category = place.category;
    card.style.animationDelay = `${i * 0.08}s`;

    const photo = place.photoUrl || `https://via.placeholder.com/400x220/1a1a2e/6366f1?text=${encodeURIComponent(place.category === 'restaurant' ? '🍴' : '🏛️')}`;
    const rating = place.rating ? `<span class="explore-card-rating">★ ${place.rating}</span>` : '';
    const typeLabel = place.category === 'restaurant' ? '🍴 Restaurant' : '🏛️ Attraction';

    card.innerHTML = `
      <img src="${photo}" class="explore-card-img" alt="${place.name}" loading="lazy" onerror="this.src='https://via.placeholder.com/400x220/1a1a2e/6366f1?text=No+Photo'">
      <div class="explore-card-body">
        <div class="explore-card-name" title="${place.name}">${place.name}</div>
        <div class="explore-card-meta">
          ${rating}
          <span class="explore-card-type">${typeLabel}</span>
        </div>
      </div>
    `;

    if (place.lat && place.lng) {
      card.style.cursor = 'pointer';
      card.onclick = () => {
        exploreMapInstance.panTo({ lat: place.lat, lng: place.lng });
        exploreMapInstance.setZoom(17);
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
    }

    grid.appendChild(card);
  });
}

// Start the app
init();
