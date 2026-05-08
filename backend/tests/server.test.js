'use strict';

process.env.NODE_ENV = 'test';
process.env.MOCK_MODE = 'true';

const request = require('supertest');
const app = require('../server');

describe('Bon Voyage API', () => {
  test('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('POST /api/identify — no body returns 400', async () => {
    const res = await request(app).post('/api/identify').send({});
    expect(res.status).toBe(400);
  });

  test('POST /api/facts — no landmark returns 400', async () => {
    const res = await request(app).post('/api/facts').send({});
    expect(res.status).toBe(400);
  });

  test('POST /api/facts — empty landmark returns 400', async () => {
    const res = await request(app).post('/api/facts').send({ landmark: '   ' });
    expect(res.status).toBe(400);
  });

  test('POST /api/facts — landmark too long returns 400', async () => {
    const res = await request(app).post('/api/facts').send({ landmark: 'a'.repeat(301) });
    expect(res.status).toBe(400);
  });

  test('POST /api/facts — valid landmark in MOCK_MODE returns 5 facts', async () => {
    const res = await request(app).post('/api/facts').send({ landmark: 'Eiffel Tower' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.facts)).toBe(true);
    expect(res.body.facts.length).toBe(5);
  });

  test('POST /api/nearby — missing lat/lng returns 400', async () => {
    const res = await request(app).post('/api/nearby').send({});
    expect(res.status).toBe(400);
  });

  test('POST /api/nearby — lat out of range returns 400', async () => {
    const res = await request(app).post('/api/nearby').send({ lat: 200, lng: 0 });
    expect(res.status).toBe(400);
  });

  test('POST /api/nearby — lng out of range returns 400', async () => {
    const res = await request(app).post('/api/nearby').send({ lat: 0, lng: 200 });
    expect(res.status).toBe(400);
  });

  test('GET /api/config returns mapsApiKey field', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mapsApiKey');
  });
});
