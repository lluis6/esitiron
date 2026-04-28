/**
 * metrics.js — Servidor de métricas Prometheus (puerto interno 9090)
 *
 * Levantar este módulo al final de server.js:
 *   require('./metrics');
 *
 * ⚠ Este servidor NUNCA debe exponerse al exterior.
 *   El puerto 9090 no tiene `ports:` en docker-compose.yml.
 */

'use strict';

const http    = require('http');
const client  = require('prom-client');

// ── Registro y métricas por defecto de Node.js ───────────────
// Incluye: CPU (process_cpu_seconds_total), RAM (process_resident_memory_bytes),
// Event Loop lag (nodejs_eventloop_lag_seconds), handles, GC, etc.
const register = new client.Registry();

client.collectDefaultMetrics({
  register,
  prefix: 'esitiron_',   // prefijo para distinguir métricas en Grafana
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// ── Métricas custom opcionales ────────────────────────────────

// Contador de tiquets procesados (incrementar desde server.js si se desea)
const tiquetsCounter = new client.Counter({
  name:    'esitiron_tiquets_procesados_total',
  help:    'Número total de tiquets procesados correctamente',
  registers: [register],
});

// Histograma de duración del OCR
const ocrDuration = new client.Histogram({
  name:    'esitiron_ocr_duration_seconds',
  help:    'Duración de las llamadas al servicio OCR',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 90],
  registers: [register],
});

// Gauge de usuarios activos en sesión (aproximado)
const sesionesActivas = new client.Gauge({
  name:    'esitiron_sesiones_activas',
  help:    'Número aproximado de sesiones activas',
  registers: [register],
});

// ── Servidor HTTP exclusivo para /metrics ────────────────────
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9090', 10);

const metricsServer = http.createServer(async (req, res) => {
  // Solo responde a GET /metrics — cualquier otra ruta devuelve 404
  if (req.method === 'GET' && req.url === '/metrics') {
    try {
      const metrics = await register.metrics();
      res.setHeader('Content-Type', register.contentType);
      res.writeHead(200);
      res.end(metrics);
    } catch (err) {
      res.writeHead(500);
      res.end(`Error generando métricas: ${err.message}`);
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

metricsServer.listen(METRICS_PORT, '0.0.0.0', () => {
  console.log(`[Metrics] Servidor Prometheus escoltant al port ${METRICS_PORT} (intern)`);
});

// Exportar helpers para usar desde server.js
module.exports = { tiquetsCounter, ocrDuration, sesionesActivas };
