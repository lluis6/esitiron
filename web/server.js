
'use strict';

const express    = require('express');
const nunjucks   = require('nunjucks');
const multer     = require('multer');
const axios      = require('axios');
const FormData   = require('form-data');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const bcryptjs   = require('bcryptjs');
const mysql      = require('mysql2/promise');
const session    = require('express-session');
const crypto     = require('crypto');

let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('[WARN] sharp no disponible, HEIC/HEIF no se podra convertir');
}
const speakeasy  = require('speakeasy');
const QRCode     = require('qrcode');

const promClient = require('prom-client');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ── Entorno ───────────────────────────────────────────────────
// En producción se espera NODE_ENV=production (o trust proxy activo)
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Si la app está detrás de un reverse proxy (Nginx, Traefik…),
// Express necesita saber que el proxy es de confianza para leer
// el encabezado X-Forwarded-Proto y así marcar correctamente las cookies.
if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

const OCR_URL         = `http://${process.env.OCR_HOST || 'ocr'}:8000/analizar`;
const OFF_SEARCH_URL  = process.env.OFF_SEARCH_URL  || 'https://world.openfoodfacts.org/cgi/search.pl';
const OFF_SECONDARY_URL = process.env.OFF_SECONDARY_URL || 'https://world.openfoodfacts.net/cgi/search.pl';
const OFF_FALLBACK_URL  = process.env.OFF_FALLBACK_URL  || 'http://proxy/api/openfoodfacts/cgi/search.pl';
const OFF_TIMEOUT_MS    = Number.parseInt(process.env.OFF_TIMEOUT_MS || '10000', 10);
const OPF_BASE_URL      = process.env.OPF_BASE_URL      || 'https://world.openfoodfacts.org';
const OPF_LOOKUP_PATH   = process.env.OPF_LOOKUP_PATH   || '/api/v2/product';
const OPF_CREATE_PATH   = process.env.OPF_CREATE_PATH   || '/cgi/product_jqm2.pl';
const OPF_IMAGE_PATH    = process.env.OPF_IMAGE_PATH    || '/cgi/product_image_upload.pl';
const OPF_TIMEOUT_MS    = Number.parseInt(process.env.OPF_TIMEOUT_MS || '12000', 10);
const OPF_USER_ID       = process.env.OPF_USER_ID       || '';
const OPF_PASSWORD      = process.env.OPF_PASSWORD      || '';
const OPF_USER_AGENT    = process.env.OPF_USER_AGENT    || 'Esitiron/1.0 (https://tickets.esitiron.app)';
const OPENFACTS_API_KEY = process.env.OPENFACTS_API_KEY || '';

// ── Prometheus ────────────────────────────────────────────────
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const ticketsSubidosCounter = new promClient.Counter({
  name: 'tickets_subidos_total',
  help: 'Número total de tiquets guardados desde el último reinicio'
});
register.registerMetric(ticketsSubidosCounter);

const ticketsTotalesGauge = new promClient.Gauge({
  name: 'tickets_total_historico',
  help: 'Total histórico de tiquets en base de datos',
  async collect() {
    try {
      const [[row]] = await dbPool.execute('SELECT COUNT(*) AS n FROM tiquets');
      this.set(Number(row.n));  // ← forzar Number por si llega string
    } catch (e) {
      console.error('[Prometheus] Error en gauge tickets_total_historico:', e.message);
      // NO hacer this.set(0) — dejar el valor anterior si falla
    }
  }
});
register.registerMetric(ticketsTotalesGauge);

const ticketsHoyGauge = new promClient.Gauge({
  name: 'tickets_subidos_hoy',
  help: 'Tiquets subidos en las últimas 24 horas',
  async collect() {
    try {
      const [[row]] = await dbPool.execute(
        `SELECT COUNT(*) AS n FROM tiquets WHERE fecha_compra >= NOW() - INTERVAL 24 HOUR`
      );
      this.set(Number(row.n));
    } catch (e) {
      console.error('[Prometheus] Error en gauge tickets_subidos_hoy:', e.message);
    }
  }
});
register.registerMetric(ticketsHoyGauge);

// ── Cifrado AES-256-GCM ───────────────────────────────────────
const REQUIRED_ENV = ['SESSION_SECRET', 'AES_SALT'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key] || process.env[key].trim() === '');
if (missingEnv.length > 0) {
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║  ERROR FATAL — Variables de entorno críticas no definidas   ║');
  console.error('╠══════════════════════════════════════════════════════════════╣');
  missingEnv.forEach((key) => console.error(`║  ✗ ${key.padEnd(58)}║`));
  console.error('╠══════════════════════════════════════════════════════════════╣');
  console.error('║  Genera los valores y añádelos a .env:                      ║');
  console.error('║   SESSION_SECRET → openssl rand -base64 64                  ║');
  console.error('║   AES_SALT       → openssl rand -hex 32                     ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('');
  process.exit(1);
}

const SESSION_SECRET = process.env.SESSION_SECRET;
const AES_SALT = process.env.AES_SALT;
const ENCRYPTION_KEY = crypto.scryptSync(SESSION_SECRET, AES_SALT, 32);
const IV_LENGTH = 16;

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${encrypted}:${authTag}`;
}

function decrypt(text) {
  if (!text) return null;
  const parts = text.split(':');
  if (parts.length !== 3) return text;
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const authTag = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ── Directorios ───────────────────────────────────────────────
const DEFAULT_AVATARS_DIR  = path.join(__dirname, 'public', 'avatars');
const FALLBACK_AVATARS_DIR = path.join(os.tmpdir(), 'esitiron_avatars');

function ensureWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function isReadableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.R_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function resolveAvatarsDir() {
  const envDir = (process.env.AVATARS_DIR || '').trim();
  const candidates = [];
  if (envDir) {
    candidates.push(path.resolve(envDir));
  } else if (IS_PRODUCTION) {
    candidates.push(DEFAULT_AVATARS_DIR, FALLBACK_AVATARS_DIR);
  } else {
    candidates.push(DEFAULT_AVATARS_DIR, FALLBACK_AVATARS_DIR);
  }
  const failures = [];
  for (const dir of candidates) {
    const result = ensureWritableDir(dir);
    if (result.ok) {
      if (dir !== DEFAULT_AVATARS_DIR && failures.length) {
        const details = failures
          .map((failure) => `${failure.dir} (${failure.error.code || failure.error.message})`)
          .join(', ');
        console.warn(`[AVATAR] Usando directorio alternativo: ${dir}. Fallos: ${details}`);
      }
      return dir;
    }
    failures.push({ dir, error: result.error });
  }
  const details = failures
    .map((failure) => `${failure.dir} (${failure.error.code || failure.error.message})`)
    .join(', ');
  console.error(`[AVATAR] No hay directorio de avatares escribible. Fallos: ${details}`);
  process.exit(1);
}

const AVATARS_DIR = resolveAvatarsDir();
console.log(`[AVATAR] Guardando avatares en: ${AVATARS_DIR}`);
const AVATAR_DIRS = [AVATARS_DIR];
if (DEFAULT_AVATARS_DIR !== AVATARS_DIR && isReadableDir(DEFAULT_AVATARS_DIR)) {
  AVATAR_DIRS.push(DEFAULT_AVATARS_DIR);
}

function getAvatarPath(filename, dir = AVATARS_DIR) {
  const base = path.basename(filename || '');
  if (!base || base === '.' || base === '..') return null;
  return path.join(dir, base);
}
const OPF_UPLOADS_DIR = path.join(__dirname, 'private', 'opf_uploads');
if (!fs.existsSync(OPF_UPLOADS_DIR)) fs.mkdirSync(OPF_UPLOADS_DIR, { recursive: true });

// ── Base de datos ─────────────────────────────────────────────
const dbPool = mysql.createPool({
  host:               process.env.DB_HOST     || 'db',
  port:               parseInt(process.env.DB_PORT) || 3306, // <--- AÑADE ESTA LÍNEA
  user:               process.env.DB_USER     || 'user_seguro',
  password:           process.env.DB_PASSWORD || 'password',
  database:           process.env.DB_NAME     || 'tiquets_db',
  charset:            'utf8mb4',
  waitForConnections: true,
  connectionLimit:    10,
  timezone:           '+00:00',
});

if (dbPool.pool && typeof dbPool.pool.on === 'function') {
  dbPool.pool.on('connection', (connection) => {
    connection.query("SET NAMES 'utf8mb4' COLLATE 'utf8mb4_unicode_ci'", (err) => {
      if (err) console.error('[DB] SET NAMES error:', err);
    });
  });
}

let ID_PRODUCTO_DESCUENTO = null;

async function initDB() {
  const [rows] = await dbPool.execute("SELECT id FROM productos_maestros WHERE nombre = 'Descuento' LIMIT 1");
  if (rows.length > 0) {
    ID_PRODUCTO_DESCUENTO = rows[0].id;
  } else {
    const [r] = await dbPool.execute("INSERT INTO productos_maestros (nombre, marca, categoria) VALUES ('Descuento','Sistema','Descuento')");
    ID_PRODUCTO_DESCUENTO = r.insertId;
  }
  console.log(`[DB] ID_PRODUCTO_DESCUENTO=${ID_PRODUCTO_DESCUENTO}`);

  await dbPool.execute(`ALTER TABLE tiquets ADD COLUMN IF NOT EXISTS uuid VARCHAR(36) UNIQUE DEFAULT NULL`).catch(() => {});
  await dbPool.execute(`UPDATE tiquets SET uuid = UUID() WHERE uuid IS NULL`).catch(() => {});
  await dbPool.execute(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS nombre_original VARCHAR(500) DEFAULT NULL`).catch(() => {});
  await dbPool.execute(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS curado TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
  await dbPool.execute(`ALTER TABLE productos_maestros ADD COLUMN IF NOT EXISTS foto_url VARCHAR(500) DEFAULT NULL`).catch(() => {});
  await dbPool.execute(`ALTER TABLE productos_maestros ADD COLUMN IF NOT EXISTS codigo_barras VARCHAR(50) DEFAULT NULL`).catch(() => {});
  await dbPool.execute(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS es_admin TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});

  await dbPool.execute(`
    CREATE TABLE IF NOT EXISTS diccionario_productos (
      id                  INT UNSIGNED    NOT NULL AUTO_INCREMENT,
      nombre_en_tiquet    VARCHAR(500)    NOT NULL,
      id_producto_maestro INT UNSIGNED    NOT NULL,
      usos                INT             NOT NULL DEFAULT 1,
      creado_en           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actualizado_en      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_nombre (nombre_en_tiquet(191)),
      INDEX idx_producto (id_producto_maestro),
      FOREIGN KEY (id_producto_maestro) REFERENCES productos_maestros(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await dbPool.execute(`
    CREATE TABLE IF NOT EXISTS verificaciones_barcode (
      id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
      id_producto     INT UNSIGNED    NOT NULL,
      codigo_barras   VARCHAR(50)     NOT NULL,
      votos_si        INT             NOT NULL DEFAULT 0,
      votos_no        INT             NOT NULL DEFAULT 0,
      estado          ENUM('pendiente','verificado','rechazado') NOT NULL DEFAULT 'pendiente',
      creado_en       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_prod_barcode (id_producto, codigo_barras),
      FOREIGN KEY (id_producto) REFERENCES productos_maestros(id) ON DELETE CASCADE,
      INDEX idx_estado (estado)
    ) ENGINE=InnoDB
  `);

  await dbPool.execute(`
    CREATE TABLE IF NOT EXISTS votos_usuario (
      id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
      id_usuario      INT UNSIGNED    NOT NULL,
      id_verificacion INT UNSIGNED    NOT NULL,
      voto            ENUM('si','no') NOT NULL,
      votado_en       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_usuario_verif (id_usuario, id_verificacion),
      FOREIGN KEY (id_usuario)      REFERENCES usuarios(id)               ON DELETE CASCADE,
      FOREIGN KEY (id_verificacion) REFERENCES verificaciones_barcode(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await dbPool.execute(`
    CREATE TABLE IF NOT EXISTS verificaciones_producto (
      id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
      id_producto     INT UNSIGNED    NOT NULL,
      id_usuario      INT UNSIGNED    NOT NULL,
      motivo          VARCHAR(255)    DEFAULT NULL,
      estado          ENUM('pendiente','rechazado','eliminado','desvinculado') NOT NULL DEFAULT 'pendiente',
      creado_en       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_producto_estado (id_producto, estado),
      FOREIGN KEY (id_producto) REFERENCES productos_maestros(id) ON DELETE CASCADE,
      FOREIGN KEY (id_usuario)  REFERENCES usuarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await dbPool.execute(
    "ALTER TABLE verificaciones_producto MODIFY estado ENUM('pendiente','rechazado','eliminado','desvinculado') NOT NULL DEFAULT 'pendiente'"
  ).catch(() => {});

  await dbPool.execute(`
    CREATE TABLE IF NOT EXISTS opf_drafts (
      id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
      id_usuario     INT UNSIGNED NOT NULL,
      ean            VARCHAR(50)  NOT NULL,
      nombre         VARCHAR(200) NOT NULL,
      marca          VARCHAR(100) NOT NULL,
      foto_path      VARCHAR(255) DEFAULT NULL,
      estado         ENUM('draft','sent','failed') NOT NULL DEFAULT 'draft',
      opf_response   TEXT         DEFAULT NULL,
      error_msg      VARCHAR(500) DEFAULT NULL,
      creado_en      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actualizado_en DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_opf_usuario (id_usuario),
      INDEX idx_opf_ean (ean),
      FOREIGN KEY (id_usuario) REFERENCES usuarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await dbPool.execute(`
    CREATE TABLE IF NOT EXISTS opf_pendientes (
      id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
      id_usuario     INT UNSIGNED NOT NULL,
      ean            VARCHAR(50)  NOT NULL,
      nombre         VARCHAR(200) NOT NULL,
      marca          VARCHAR(100) NOT NULL,
      foto_path      VARCHAR(255) DEFAULT NULL,
      estado         ENUM('pendiente','enviado','rechazado','fallido') NOT NULL DEFAULT 'pendiente',
      opf_response   TEXT         DEFAULT NULL,
      error_msg      VARCHAR(500) DEFAULT NULL,
      creado_en      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actualizado_en DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_opf_pend_usuario (id_usuario),
      INDEX idx_opf_pend_estado  (estado),
      FOREIGN KEY (id_usuario) REFERENCES usuarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await dbPool.execute(`
    UPDATE compras c
    LEFT JOIN productos_maestros pm ON pm.id = c.id_producto
    SET c.id_producto = NULL, c.curado = 0
    WHERE c.id_producto IS NOT NULL AND pm.id IS NULL
  `).catch(() => {});

  await dbPool.execute(`
    DELETE dp FROM diccionario_productos dp
    LEFT JOIN productos_maestros pm ON pm.id = dp.id_producto_maestro
    WHERE pm.id IS NULL
  `).catch(() => {});

  console.log('[DB] Todas las tablas listas');
}

// ── Helpers ───────────────────────────────────────────────────
const TIENDAS_MAP = {
  'MERCADONA':'Mercadona','CONSUM':'Consum','LIDL':'Lidl','ALDI':'Aldi',
  'CARREFOUR':'Carrefour','ALCAMPO':'Alcampo','DIA':'Dia','CAPRABO':'Caprabo',
  'BONPREU':'Bonpreu','EROSKI':'Eroski','SPAR':'Spar',
};
function normalizarTienda(nombre) {
  if (!nombre) return 'Desconocido';
  const up = nombre.toUpperCase();
  for (const [k, v] of Object.entries(TIENDAS_MAP)) if (up.includes(k)) return v;
  return nombre.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function parsearFechaTicket(fechaStr) {
  if (!fechaStr) return null;
  const s = String(fechaStr).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3]), parseInt(m[4]), parseInt(m[5]));
  m = s.match(/^(\d{2})[./](\d{2})[./](\d{4})\s+(\d{2}):(\d{2})/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1]), parseInt(m[4]), parseInt(m[5]));
  m = s.match(/^(\d{2})[./](\d{2})[./](\d{4})/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1]));
  return null;
}

function nowMadrid() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' })); }

function esCategoriaPeso(cat) {
  const normalized = String(cat || '').toLowerCase().replace(/\s+/g, '').replace(/\//g, '');
  return normalized === 'frutaverdura';
}

function esProductoDescuento(producto) {
  if (!producto) return false;
  return producto.es_descuento === true
    || producto.es_descuento === 1
    || producto.es_descuento === '1'
    || String(producto.categoria || '').toLowerCase() === 'descuento';
}

async function verificarConsenso(conn, idVerificacion) {
  const [[verif]] = await conn.execute('SELECT * FROM verificaciones_barcode WHERE id = ?', [idVerificacion]);
  if (!verif) return;
  const total = verif.votos_si + verif.votos_no;
  if (total < 3) return;
  const ratio = verif.votos_si / total;
  if (ratio >= 0.8) {
    await conn.execute("UPDATE verificaciones_barcode SET estado = 'verificado' WHERE id = ?", [idVerificacion]);
    await conn.execute('UPDATE productos_maestros SET codigo_barras = ? WHERE id = ?', [verif.codigo_barras, verif.id_producto]);
    console.log(`[Consenso] Verificación ${idVerificacion} APROBADA`);
  } else if (ratio < 0.3) {
    await conn.execute("UPDATE verificaciones_barcode SET estado = 'rechazado' WHERE id = ?", [idVerificacion]);
    await conn.execute('UPDATE productos_maestros SET codigo_barras = NULL WHERE id = ? AND codigo_barras = ?', [verif.id_producto, verif.codigo_barras]);
    console.log(`[Consenso] Verificación ${idVerificacion} RECHAZADA`);
  }
}

// ── Multer ────────────────────────────────────────────────────
const uploadTiquet = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 }, //limit de 15mb
  fileFilter: (_req, file, cb) => {
    // Normalizar variantes de MIME que mandan algunos móviles
    const mime = (file.mimetype || '').toLowerCase().trim();
    const ALLOWED =[
      'image/jpeg', 'image/jpg',          // Android a veces manda image/jpg
      'image/heic', 'image/heif',          // iOS/Android galeria suele mandar HEIC/HEIF
      'image/png', 'image/webp', 'image/gif',
      'application/pdf',
      'application/octet-stream',          // iOS/Android picker genérico
    ];
    // También aceptar por extensión cuando el MIME llega vacío o genérico
    const ext = path.extname(file.originalname || '').toLowerCase();
    const ALLOWED_EXT =['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf', '.heic', '.heif'];
    if (ALLOWED.includes(mime) || ALLOWED_EXT.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Formato no permitido.'));
    }
  },
});

const uploadAvatar = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AVATARS_DIR),
    filename:    (req, _file, cb) => {
      const ext = path.extname(_file.originalname).toLowerCase() || '.jpg';
      cb(null, `avatar_${req.session.usuario.id}_${Date.now()}${ext}`);
    },
  }),
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Formato de avatar no permitido'));
  },
});

const AVATAR_MAGIC =[
  { ext: '.jpg',  test: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff },
  { ext: '.png',  test: (buf) => buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a },
  { ext: '.gif',  test: (buf) => buf.length >= 6 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') },
  { ext: '.webp', test: (buf) => buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' },
];

async function detectarAvatarPorMagic(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await fd.read(header, 0, header.length, 0);
    const slice = header.slice(0, bytesRead);
    const match = AVATAR_MAGIC.find((rule) => rule.test(slice));
    return match ? match.ext : null;
  } finally {
    await fd.close();
  }
}

const uploadOpf = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed =['image/jpeg','image/png','image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Formato de imagen no permitido'));
  },
});

async function normalizeUploadForOcr(file) {
  const originalName = file.originalname || 'upload';
  const ext = path.extname(originalName).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  const isHeic = mime.includes('heic') || mime.includes('heif') || ext === '.heic' || ext === '.heif';

  if (!isHeic) {
    return { buffer: file.buffer, filename: originalName, mimetype: file.mimetype || 'application/octet-stream' };
  }

  if (!sharp) {
    throw new Error('HEIC/HEIF no soportado en servidor');
  }

  const jpegBuffer = await sharp(file.buffer).jpeg({ quality: 92 }).toBuffer();
  const safeName = originalName.replace(/\.(heic|heif)$/i, '') || 'upload';
  return { buffer: jpegBuffer, filename: `${safeName}.jpg`, mimetype: 'image/jpeg' };
}

// ── Estáticos y middleware ────────────────────────────────────
const PUBLIC_DIR      = path.join(__dirname, 'public');
const CLASS_CSS_DIR   = path.join(PUBLIC_DIR, 'css', 'class');
const LEGACY_CLASS_DIR = path.join(PUBLIC_DIR, 'class');

app.use('/css/class', express.static(CLASS_CSS_DIR));
app.use('/css/class', express.static(LEGACY_CLASS_DIR));
app.use('/class',     express.static(CLASS_CSS_DIR));
app.use('/class',     express.static(LEGACY_CLASS_DIR));
app.use(express.static(PUBLIC_DIR));
app.use('/static', express.static(PUBLIC_DIR));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ══════════════════════════════════════════════════════════════
// SESIÓN SEGURA
// ──────────────────────────────────────────────────────────────
// • secure: true   → la cookie SOLO se envía por HTTPS.
//                    En desarrollo (NODE_ENV != production) se
//                    desactiva para poder usar HTTP en localhost.
// • httpOnly: true → JavaScript del cliente no puede leer la
//                    cookie (protección XSS).
// ══════════════════════════════════════════════════════════════
app.use(session({
  secret:            SESSION_SECRET,
  resave:            true,              // Cambiado a true para forzar guardado
  saveUninitialized: true,              // Cambiado a true para depurar
  proxy:             true,              
  name:              'esitiron_session', // Nombre personalizado para evitar conflictos
  cookie: {
    httpOnly: true,
    sameSite: 'lax',                    // Lax es vital para Tailscale Funnel
    secure:   true,                     // Forzamos true porque Tailscale usa HTTPS
    maxAge:   7 * 24 * 60 * 60 * 1000
  },
}));

// ── Cabeceras de seguridad globales ───────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options',    'nosniff');
  res.setHeader('X-Frame-Options',           'DENY');
  res.setHeader('Referrer-Policy',           'strict-origin-when-cross-origin');
  // Añadida: evita que el navegador guarde caché de páginas privadas
  res.setHeader('Cache-Control',             'no-store');
  next();
});

// ── Middlewares de autenticación ──────────────────────────────
const auth = (req, res, next) => {
  if (!req.session.usuario) return res.redirect('/login?error=Debes+iniciar+sesión');
  next();
};

const adminOnly = (req, res, next) => {
  if (!req.session.usuario?.es_admin) return res.status(403).json({ error: 'No autorizado' });
  next();
};

const adminPageOnly = (req, res, next) => {
  if (!req.session.usuario?.es_admin) return res.redirect('/dashboard?error=No+autorizado');
  next();
};

// ── Endpoints técnicos (sin auth) ────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.get('/debug-charset', async (req, res) => {
  const [[vars]]  = await dbPool.execute("SHOW VARIABLES LIKE 'character_set_client'");
  const [[names]] = await dbPool.execute("SELECT @@character_set_connection AS conn, @@collation_connection AS coll");
  const [[row]]   = await dbPool.execute("SELECT pais, HEX(pais) AS hex_pais FROM tiquets LIMIT 1");
  res.json({ vars, names, row });
});

const http = require('http');

const metricsServer = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    try {
      res.setHeader('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (ex) {
      res.statusCode = 500;
      res.end(String(ex));
    }
  } else {
    res.statusCode = 404;
    res.end();
  }
});

// ── Avatar seguro ─────────────────────────────────────────────
app.get('/avatar/:filename', (req, res) => {
  if (!req.session || !req.session.usuario) {
    console.warn(`[SECURITY] Intento de acceso a avatar sin autenticación desde ${req.ip}`);
    return res.status(403).json({ error: 'No autorizado' });
  }
  const filename = path.basename(req.params.filename || '');
  if (!filename || filename === '.' || filename === '..') {
    return res.status(404).json({ error: 'Avatar no encontrado' });
  }
  let filepath = null;
  for (const dir of AVATAR_DIRS) {
    const candidate = getAvatarPath(filename, dir);
    if (candidate && fs.existsSync(candidate)) { filepath = candidate; break; }
  }
  if (!filepath) return res.status(404).json({ error: 'Avatar no encontrado' });

  fs.stat(filepath, (err, stats) => {
    if (err || !stats.isFile()) return res.status(404).json({ error: 'Avatar no encontrado' });
    const validExtensions =['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    const fileExt = path.extname(filepath).toLowerCase();
    if (!validExtensions.includes(fileExt)) return res.status(403).json({ error: 'Tipo de archivo no permitido' });
    res.set({
      'Cache-Control':             'public, max-age=86400',
      'X-Content-Type-Options':    'nosniff',
      'Content-Security-Policy':   "default-src 'none'",
      'X-Frame-Options':           'DENY',
    });
    res.sendFile(filepath);
  });
});

// ── Nunjucks ──────────────────────────────────────────────────
const env = nunjucks.configure('views', { autoescape: true, express: app, watch: false });
env.addGlobal('url_for', (route, kwargs) => {
  const map = {
    'tiquets.dashboard':      '/dashboard',
    'tiquets.todos_productos':'/productos',
    'auth.login':             '/login',
    'auth.logout':            '/logout',
  };
  if (route === 'static') return '/static/' + (kwargs?.filename || '');
  return map[route] || '/';
});
env.addFilter('format',        v => parseFloat(v || 0).toFixed(2));
env.addFilter('lower',         v => (v || '').toLowerCase());
env.addFilter('upper',         v => (v || '').toUpperCase());
env.addFilter('round',         v => Math.round(parseFloat(v) || 0));
env.addFilter('smartCant', v => {
  const n = parseFloat(v);
  if (isNaN(n)) return v;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/\.?0+$/, '');
});
env.addFilter('unique', (arr, attr) => {
  if (!Array.isArray(arr)) return arr;
  if (attr) {
    const seen = new Set();
    return arr.filter(item => {
      const val = item[attr];
      if (seen.has(val)) return false;
      seen.add(val);
      return true;
    });
  }
  return [...new Set(arr)];
});
env.addFilter('formatDate', v => {
  if (!v) return '—';
  try { return new Date(v).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; }
});
env.addFilter('formatDateShort', v => {
  if (!v) return '—';
  try { return new Date(v).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '—'; }
});

function navLocals(req) {
  return {
    usuario:       req.session.usuario?.username || '',
    usuario_email: req.session.usuario?.email    || '',
    avatar_url:    req.session.usuario?.avatar
      ? '/avatar/' + path.basename(req.session.usuario.avatar)
      : null,
    es_admin: !!req.session.usuario?.es_admin,
  };
}

// ── Consultas BD ──────────────────────────────────────────────
async function getUser(username) {
  const [r] = await dbPool.execute('SELECT * FROM usuarios WHERE username=?', [username]);
  return r[0] || null;
}

async function getTiquets(uid, limit = null) {
  const limitClause = limit ? `LIMIT ${parseInt(limit, 10)}` : '';
  const [rows] = await dbPool.execute(`
    SELECT t.id, t.uuid, t.supermercado, t.fecha_compra, t.total_tiquet,
           COUNT(c.id) AS total_articulos,
           (SELECT COUNT(*) FROM tiquets_grupos tg WHERE tg.tiquet_id = t.id) AS en_grupo,
           (SELECT COUNT(*) FROM tiquets t2 WHERE t2.id_usuario=? AND t2.id<=t.id) AS num_usuario
    FROM tiquets t
    LEFT JOIN compras c ON c.id_tiquet=t.id AND c.es_descuento=0
    WHERE t.id_usuario=?
    GROUP BY t.id ORDER BY t.fecha_compra DESC ${limitClause}
  `, [uid, uid]);
  return rows;
}

async function getTotalesPeriodo(uid) {
  const ahora = nowMadrid();
  const d  = ahora.getDay() || 7;
  const iS = new Date(ahora); iS.setDate(ahora.getDate() - d + 1); iS.setHours(0, 0, 0, 0);
  const iM = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
  const iA = new Date(ahora.getFullYear(), 0, 1);
  const qG  = 'SELECT COALESCE(SUM(total_tiquet),0) AS g, COUNT(*) AS n FROM tiquets WHERE id_usuario=? AND fecha_compra>=?';
  const qGT = 'SELECT COALESCE(SUM(total_tiquet),0) AS g, COUNT(*) AS n FROM tiquets WHERE id_usuario=?';
  const [[sem], [mes], [anyo], [tot]] = await Promise.all([
    dbPool.execute(qG,  [uid, iS]),
    dbPool.execute(qG,[uid, iM]),
    dbPool.execute(qG,  [uid, iA]),
    dbPool.execute(qGT, [uid]),
  ]);
  const fmt = x => parseFloat(x || 0).toFixed(2);
  return {
    semana: fmt(sem[0].g),  mes:  fmt(mes[0].g),  anyo: fmt(anyo[0].g), total: fmt(tot[0].g),
    n_semana: sem[0].n,     n_mes: mes[0].n,       n_anyo: anyo[0].n,   n_total: tot[0].n,
    avg_semana: sem[0].n  ? fmt(sem[0].g  / sem[0].n)  : '0.00',
    avg_mes:    mes[0].n  ? fmt(mes[0].g  / mes[0].n)  : '0.00',
    avg_anyo:   anyo[0].n ? fmt(anyo[0].g / anyo[0].n) : '0.00',
    avg_total:  tot[0].n  ? fmt(tot[0].g  / tot[0].n)  : '0.00',
  };
}

async function getResumen(uid) {
  const [r] = await dbPool.execute(
    'SELECT supermercado, SUM(total_tiquet) AS total_gastado, COUNT(id) AS numero_tiquets FROM tiquets WHERE id_usuario=? GROUP BY supermercado ORDER BY total_gastado DESC',
    [uid]
  );
  return r;
}

async function getTiquetByUUID(uuid, uid) {
  const [[t]] = await dbPool.execute('SELECT * FROM tiquets WHERE uuid=? AND id_usuario=?', [uuid, uid]);
  return t || null;
}

async function getNumTiquet(id, uid) {
  const [[r]] = await dbPool.execute('SELECT COUNT(*) AS n FROM tiquets WHERE id_usuario=? AND id<=?', [uid, id]);
  return r.n;
}

async function getProductosTiquet(idTiquet, uid) {
  const [r] = await dbPool.execute(`
    SELECT pm.nombre AS producto, pm.categoria, pm.foto_url,
           pm.id AS id_producto,
           c.id AS id_compra, c.cantidad,
           c.precio_unitario AS precio, c.es_descuento
    FROM compras c
    JOIN productos_maestros pm ON pm.id=c.id_producto
    WHERE c.id_tiquet=? AND c.id_usuario=? ORDER BY c.id
  `, [idTiquet, uid]);
  return r;
}

async function getProductosUsuario(uid, pais, supermercado) {
  let query = `
    SELECT pm.nombre AS producto, pm.categoria, pm.marca, pm.foto_url,
           pm.id AS id_producto_maestro, pm.codigo_barras,
           t.supermercado AS tienda, COALESCE(t.pais, 'España') AS pais,
           c.cantidad, c.precio_unitario AS precio,
           c.id AS id_compra, c.nombre_original, c.curado
    FROM compras c
    JOIN tiquets t ON t.id = c.id_tiquet
    JOIN productos_maestros pm ON pm.id = c.id_producto
    WHERE c.id_usuario = ? AND c.es_descuento = 0`;
  const params = [uid];
  if (pais)         { query += ' AND t.pais = ?';         params.push(pais); }
  if (supermercado) { query += ' AND t.supermercado = ?'; params.push(supermercado); }
  query += ' ORDER BY t.fecha_compra DESC';
  const [r] = await dbPool.execute(query, params);
  return r;
}

async function guardarTiquet(uid, datos) {
  const super_ = normalizarTienda(datos.supermercado);
  const prods  = datos.productos ||[];
  const productosNormalizados = prods.map(p => {
    const esDescuento = esProductoDescuento(p);
    const categoria   = esDescuento ? 'Descuento' : (p.categoria || 'Otros');
    const esPeso      = !esDescuento && esCategoriaPeso(categoria);
    let cantidad = parseFloat(String(p.cantidad ?? 1).replace(',', '.'));
    if (!Number.isFinite(cantidad)) cantidad = 1;
    cantidad = Math.abs(cantidad);
    if (!esPeso) cantidad = Math.round(cantidad);
    if (esDescuento) cantidad = 1;
    let precio = parseFloat(String(p.precio ?? 0).replace(',', '.'));
    if (!Number.isFinite(precio)) precio = 0;
    precio = esDescuento ? -Math.abs(precio) : Math.abs(precio);
    return { ...p, categoria, es_descuento: esDescuento, cantidad, precio, es_peso: esPeso };
  });
  const total = productosNormalizados.reduce((acc, p) => acc + Math.round(p.cantidad * p.precio * 100), 0) / 100;
  let fecha = datos.fecha_tiquet ? parsearFechaTicket(datos.fecha_tiquet) : nowMadrid();
  if (!fecha) fecha = nowMadrid();

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const tiquetUUID = crypto.randomUUID();
    const [rt] = await conn.execute(
      'INSERT INTO tiquets (id_usuario, supermercado, total_tiquet, fecha_compra, uuid) VALUES (?,?,?,?,?)',[uid, super_, total, fecha, tiquetUUID]
    );
    const idT = rt.insertId;

    for (const p of productosNormalizados) {
      const esD    = p.es_descuento ? 1 : 0;
      const nom    = (p.producto || 'Desconocido').trim().toUpperCase();
      const nomOcr = (p.nombre_ocr || nom).trim().toUpperCase();
      const cat    = p.categoria || 'Otros';
      const cant   = p.cantidad;
      const prec   = p.precio;
      let idP;
      let yaVinculado = 0;

      if (esD) {
        idP = ID_PRODUCTO_DESCUENTO;
      } else {
        const [mapeo] = await conn.execute(
          'SELECT id_producto_maestro FROM diccionario_productos WHERE nombre_en_tiquet = ?', [nomOcr]
        );
        if (mapeo.length > 0) {
          idP = mapeo[0].id_producto_maestro;
          yaVinculado = 1;
          await conn.execute('UPDATE diccionario_productos SET usos = usos + 1 WHERE nombre_en_tiquet = ?',[nomOcr]);
        } else {
          const [ex] = await conn.execute('SELECT id FROM productos_maestros WHERE nombre=?', [nom]);
          if (ex.length) {
            idP = ex[0].id;
            if (cat !== 'Otros') await conn.execute('UPDATE productos_maestros SET categoria=? WHERE id=? AND categoria="Otros"', [cat, idP]);
          } else {
            const [ins] = await conn.execute('INSERT INTO productos_maestros (nombre, categoria) VALUES (?,?)', [nom, cat]);
            idP = ins.insertId;
          }
        }
        if (prec > 0) {
          await conn.execute(
            'INSERT INTO historial_precios (id_producto, supermercado, precio) VALUES (?,?,?)', [idP, super_, prec]
          ).catch(() => {});
        }
      }
      await conn.execute(
        `INSERT INTO compras (id_tiquet, id_usuario, id_producto, cantidad, precio_unitario, es_descuento, nombre_original, curado)
         VALUES (?,?,?,?,?,?,?,?)`,[idT, uid, idP, cant, prec, esD, nomOcr, yaVinculado]
      );
    }
    await conn.commit();
    return { id: idT, uuid: tiquetUUID };
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

// ════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════
app.get('/', (_, res) => res.redirect('/login'));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/login', (req, res) => {
  if (req.session.usuario) return res.redirect('/dashboard');
  const messages = [];
  if (req.query.error)   messages.push(['danger',  decodeURIComponent(req.query.error)]);
  if (req.query.success) messages.push(['success', decodeURIComponent(req.query.success)]);
  res.render('login.html', { messages });
});

app.post('/login', async (req, res) => {
  const { accion, username, password, email } = req.body;
  if (!username || !password) return res.redirect('/login?error=Usuario+y+contraseña+requeridos');
  try {
    if (accion === 'registro') {
      if (!email)               return res.redirect('/login?error=Email+obligatorio');
      if (username.length < 3)  return res.redirect('/login?error=Usuario+mínimo+3+caracteres');
      if (password.length < 8)  return res.redirect('/login?error=Contraseña+mínimo+8+caracteres');
      if (await getUser(username)) return res.redirect('/login?error=Usuario+ya+existe');
      await dbPool.execute(
        'INSERT INTO usuarios (username,email,password_hash,activo) VALUES (?,?,?,1)',[username, email, bcryptjs.hashSync(password, 12)]
      );
      return res.redirect('/login?success=Cuenta+creada');
    }
    const u = await getUser(username);
    if (!u || !bcryptjs.compareSync(password, u.password_hash) || !u.activo)
      return res.redirect('/login?error=Usuario+o+contraseña+incorrectos');
    if (u.totp_enabled) {
      req.session.totp_pending = { id: u.id, username: u.username, email: u.email, avatar: u.avatar || null, es_admin: u.es_admin === 1 };
      return res.redirect('/login/2fa');
    }
    req.session.usuario = { id: u.id, username: u.username, email: u.email, avatar: u.avatar || null, es_admin: u.es_admin === 1 };
    return res.redirect('/dashboard');
  } catch (e) { console.error('[Auth]', e.message); res.redirect('/login?error=Error+servidor'); }
});

app.get('/login/2fa', (req, res) => {
  if (!req.session.totp_pending) return res.redirect('/login');
  const messages =[];
  if (req.query.error) messages.push(['danger', decodeURIComponent(req.query.error)]);
  res.render('login_2fa.html', { messages });
});

app.post('/login/2fa', async (req, res) => {
  const pending = req.session.totp_pending;
  if (!pending) return res.redirect('/login');
  const token = (req.body.token || '').replace(/\s/g, '');
  const [[u]] = await dbPool.execute('SELECT totp_secret FROM usuarios WHERE id=?', [pending.id]);
  let valid = false;
  if (token.length === 6 && /^\d+$/.test(token)) {
    const decryptedSecret = decrypt(u.totp_secret);
    valid = speakeasy.totp.verify({ secret: decryptedSecret, encoding: 'base32', token, window: 1 });
  } else {
    const [codes] = await dbPool.execute('SELECT id, codigo_hash FROM codigos_recuperacion WHERE id_usuario=? AND usado=0', [pending.id]);
    for (const row of codes) {
      if (bcryptjs.compareSync(token, row.codigo_hash)) {
        valid = true;
        await dbPool.execute('UPDATE codigos_recuperacion SET usado=1 WHERE id=?', [row.id]);
        break;
      }
    }
  }
  if (!valid) return res.redirect('/login/2fa?error=Código+incorrecto+o+ya+utilizado');
  delete req.session.totp_pending;
  req.session.usuario = pending;
  return res.redirect('/dashboard');
});

// ════════════════════════════════════════════════════════════
// DASHBOARD Y VISTAS PRINCIPALES
// ════════════════════════════════════════════════════════════
app.get('/dashboard', auth, async (req, res) => {
  try {
    const uid = req.session.usuario.id;
    const[historial, resumen, totales, totalTiquets] = await Promise.all([
      getTiquets(uid, 5),
      getResumen(uid),
      getTotalesPeriodo(uid),
      dbPool.execute('SELECT COUNT(*) AS n FROM tiquets WHERE id_usuario=?', [uid]).then(([r]) => r[0].n),
    ]);
    const messages =[];
    if (req.query.error)   messages.push(['danger',  decodeURIComponent(req.query.error)]);
    if (req.query.success) messages.push(['success', decodeURIComponent(req.query.success)]);
    res.render('dashboard.html', { ...navLocals(req), historial, resumen, totales, total: totales.total, totalTiquets, messages });
  } catch (e) { console.error('[Dashboard]', e.message); res.redirect('/login?error=Error'); }
});

app.get('/tiquets', auth, async (req, res) => {
  try {
    const uid = req.session.usuario.id;
    const [historial, totales] = await Promise.all([getTiquets(uid), getTotalesPeriodo(uid)]);
    const messages =[];
    if (req.query.error)   messages.push(['danger',  decodeURIComponent(req.query.error)]);
    if (req.query.success) messages.push(['success', decodeURIComponent(req.query.success)]);
    res.render('todos_tiquets.html', { ...navLocals(req), historial, totales, total: totales.total, messages });
  } catch (e) { console.error('[Tiquets]', e.message); res.redirect('/dashboard?error=Error'); }
});

// ── OCR / preview / confirmar ─────────────────────────────────
function logUpload(req, file) {
  const ua = req.headers['user-agent'] || 'unknown';
  if (!file) {
    console.warn(`[Upload] sin archivo | ua=${ua}`);
    return;
  }
  console.info(`[Upload] file=${file.originalname} mime=${file.mimetype} size=${file.size} ua=${ua}`);
}

async function handleTiquetUpload(req, res) {
  uploadTiquet.single('foto_tiquet')(req, res, async (err) => {
    if (err) return res.redirect('/dashboard?error=' + encodeURIComponent(err.message));
    logUpload(req, req.file);
    if (!req.file) return res.redirect('/dashboard?error=Sin+archivo');
    try {
      const normalizedFile = await normalizeUploadForOcr(req.file);
      const form = new FormData();
      form.append('file', normalizedFile.buffer, { filename: normalizedFile.filename, contentType: normalizedFile.mimetype });
      const r = await axios.post(OCR_URL, form, { headers: form.getHeaders(), timeout: 90000 });

      if (r.data && Array.isArray(r.data.productos)) {
        r.data.productos = r.data.productos.reduce((acc, current) => {
          const duplicado = acc.find(item =>
            item.producto.toLowerCase().trim() === current.producto.toLowerCase().trim() &&
            item.precio === current.precio
          );
          if (duplicado) { duplicado.cantidad += current.cantidad; }
          else            { acc.push(current); }
          return acc;
        },[]);
      }
      req.session.tiquetPendent = r.data;
      return res.redirect('/preview');
    } catch (e) {
      console.error('[Upload] OCR error:', e.message);
      return res.redirect('/dashboard?error=Error+procesando+imagen');
    }
  });
}

app.post('/subir_tiquet', auth, handleTiquetUpload);
app.post('/subir_tique', auth, handleTiquetUpload);
app.get('/subir_tiquet', auth, (_req, res) => res.redirect('/dashboard'));
app.get('/subir_tique', auth, (_req, res) => res.redirect('/dashboard'));

app.get('/preview', auth, (req, res) => {
  const d = req.session.tiquetPendent;
  if (!d) return res.redirect('/dashboard');
  const sinP = !d.productos || d.productos.length === 0;
  res.render('tiquet_preview.html', {
    ...navLocals(req),
    supermercado: normalizarTienda(d.supermercado || ''),
    productos:    d.productos ||[],
    total:        parseFloat(d.total || 0).toFixed(2),
    fecha_tiquet: d.fecha_tiquet || null,
    hay_error:    d.error || sinP,
    error_msg:    d.error || (sinP ? 'Sin productos' : null),
    messages:[],
  });
});

app.post('/confirmar', auth, async (req, res) => {
  delete req.session.tiquetPendent;
  try {
    const formDatos = {
      supermercado: req.body.supermercado,
      fecha_tiquet: req.body.fecha_tiquet,
      total:        req.body.total,
      productos:[],
    };
    if (req.body.productos) {
      const prodList = Object.values(req.body.productos);
      formDatos.productos = prodList.map(p => ({
        cantidad:    p.cantidad,
        marca:       p.marca,
        producto:    p.producto,
        categoria:   p.categoria,
        precio:      p.precio,
        es_descuento: p.es_descuento === '1',
        nombre_ocr:  p.nombre_ocr || p.producto,
      }));
    }
    await guardarTiquet(req.session.usuario.id, formDatos);
    ticketsSubidosCounter.inc(); // ← esta línea falta en tu código actual
    res.redirect('/dashboard?success=Tiquet+guardado+y+editado+con+éxito');
  } catch (e) {
    console.error('[Confirmar]', e.message);
    res.redirect('/dashboard?error=Error+guardando+las+ediciones');
  }
});

app.post('/rechazar', auth, (req, res) => { delete req.session.tiquetPendent; res.redirect('/dashboard'); });

app.get('/tiquet/:uuid', auth, async (req, res) => {
  try {
    const uid    = req.session.usuario.id;
    const tiquet = await getTiquetByUUID(req.params.uuid, uid);
    if (!tiquet) return res.redirect('/dashboard?error=Tiquet+no+encontrado');
    const [productos, numUsuario] = await Promise.all([
      getProductosTiquet(tiquet.id, uid),
      getNumTiquet(tiquet.id, uid),
    ]);
    res.render('tiquet_detalle.html', { ...navLocals(req), tiquet, productos, numUsuario, messages: [] });
  } catch (e) { console.error('[Tiquet]', e.message); res.redirect('/dashboard'); }
});

app.post('/tiquet/:uuid/eliminar', auth, async (req, res) => {
  const uid  = req.session.usuario.id;
  const conn = await dbPool.getConnection();
  try {
    const [[t]] = await conn.execute('SELECT id FROM tiquets WHERE uuid=? AND id_usuario=?',[req.params.uuid, uid]);
    if (!t) { conn.release(); return res.redirect('/dashboard?error=No+encontrado'); }
    await conn.beginTransaction();
    await conn.execute('DELETE FROM compras       WHERE id_tiquet=?',      [t.id]);
    await conn.execute('DELETE FROM tiquets_grupos WHERE tiquet_id = ?',   [t.id]);
    await conn.execute('DELETE FROM tiquets        WHERE id=? AND id_usuario=?',[t.id, uid]);
    await conn.commit();
    res.redirect('/dashboard?success=Eliminado');
  } catch (e) { await conn.rollback(); console.error('[Eliminar]', e.message); res.redirect('/dashboard?error=Error'); }
  finally { conn.release(); }
});

// ── Productos ─────────────────────────────────────────────────
app.get('/productos', auth, async (req, res) => {
  const uid = req.session.usuario.id;
  const { pais = '', supermercado = '' } = req.query;
  try {
    const productos = await getProductosUsuario(uid, pais, supermercado);
    productos.forEach(p => p.tienda = normalizarTienda(p.tienda));

    const [enGrupos] = await dbPool.execute(`
      SELECT DISTINCT c.id_producto AS id_producto
      FROM compras c
      JOIN tiquets t ON t.id = c.id_tiquet
      JOIN tiquets_grupos tg ON tg.tiquet_id = t.id
      WHERE t.id_usuario = ? AND c.es_descuento = 0
    `, [uid]);
    const idsEnGrupos = new Set(enGrupos.map(r => r.id_producto));
    productos.forEach(p => { p.en_grupo = idsEnGrupos.has(p.id_producto_maestro); });

    const idsMaestros =[...new Set(productos.map(p => p.id_producto_maestro))];
    let verifMap = {};
    if (idsMaestros.length > 0) {
      const ph = idsMaestros.map(() => '?').join(',');
      const [verificaciones] = await dbPool.execute(`
        SELECT vb.id AS id_verif, vb.id_producto, vb.codigo_barras,
               vb.votos_si, vb.votos_no, vb.estado, vu.voto AS mi_voto
        FROM verificaciones_barcode vb
        LEFT JOIN votos_usuario vu ON vu.id_verificacion = vb.id AND vu.id_usuario = ?
        WHERE vb.id_producto IN (${ph}) AND vb.estado = 'pendiente'
      `,[uid, ...idsMaestros]);
      verificaciones.forEach(v => { verifMap[v.id_producto] = v; });
    }
    const productosConVerif = productos.map(p => ({ ...p, verificacion: verifMap[p.id_producto_maestro] || null }));

    const [paises]  = await dbPool.execute('SELECT DISTINCT pais FROM tiquets WHERE id_usuario=?', [uid]).catch(() => [[]]);
    const [tiendas] = await dbPool.execute('SELECT DISTINCT supermercado FROM tiquets WHERE id_usuario=?', [uid]);

    res.render('todos_productos.html', {
      ...navLocals(req),
      productos: productosConVerif,
      paises:    paises.map(r => r.pais).filter(Boolean),
      tiendas:   tiendas.map(r => normalizarTienda(r.supermercado)),
      filtro_pais: pais, filtro_supermercado: supermercado, messages:[],
    });
  } catch (e) { console.error('[Productos]', e.message); res.redirect('/dashboard'); }
});

app.get('/productos/verificar', auth, adminPageOnly, async (req, res) => {
  try {
    const [pendientes] = await dbPool.execute(`
      SELECT vb.id, vb.codigo_barras, vb.votos_si, vb.votos_no, vb.estado, vb.creado_en,
             pm.id AS id_producto, pm.nombre, pm.marca, pm.foto_url,
             (SELECT GROUP_CONCAT(DISTINCT dp.nombre_en_tiquet SEPARATOR ', ') 
              FROM diccionario_productos dp 
              WHERE dp.id_producto_maestro = pm.id) AS nombres_tiquet
      FROM verificaciones_barcode vb
      JOIN productos_maestros pm ON pm.id = vb.id_producto
      WHERE vb.estado = 'pendiente'
      ORDER BY vb.creado_en DESC
    `);
    const [pendientesBaja] = await dbPool.execute(`
      SELECT vp.id, vp.creado_en, vp.motivo,
             pm.id AS id_producto, pm.nombre, pm.marca, pm.foto_url
      FROM verificaciones_producto vp
      JOIN productos_maestros pm ON pm.id = vp.id_producto
      WHERE vp.estado = 'pendiente'
      ORDER BY vp.creado_en DESC
    `);
    const [pendientesOpf] = await dbPool.execute(`
      SELECT op.id, op.ean, op.nombre, op.marca, op.foto_path, op.creado_en,
             u.username AS usuario
      FROM opf_pendientes op
      JOIN usuarios u ON u.id = op.id_usuario
      WHERE op.estado = 'pendiente'
      ORDER BY op.creado_en DESC
    `);
    res.render('productos_verificar.html', {
      ...navLocals(req),
      pendientes,
      pendientes_baja: pendientesBaja,
      pendientes_opf:  pendientesOpf,
      messages:[],
    });
  } catch (e) {
    console.error('[VerificarProductos]', e.message);
    res.redirect('/dashboard?error=Error+al+cargar+verificaciones');
  }
});

// ════════════════════════════════════════════════════════════
// APIs
// ════════════════════════════════════════════════════════════
app.get('/api/producto/:id/precios', auth, async (req, res) => {
  try {
    const idProducto = parseInt(req.params.id, 10);
    if (isNaN(idProducto)) return res.status(400).json({ error: 'ID inválido' });
    const [historial] = await dbPool.execute(
      'SELECT supermercado, precio, fecha_registro FROM historial_precios WHERE id_producto = ? ORDER BY fecha_registro ASC',
      [idProducto]
    );
    const [[maestro]] = await dbPool.execute('SELECT nombre, marca FROM productos_maestros WHERE id = ?',[idProducto]);
    if (!maestro) return res.status(404).json({ error: 'Producto no encontrado' });
    const bySuper = {};
    historial.forEach(row => {
      if (!bySuper[row.supermercado]) bySuper[row.supermercado] =[];
      bySuper[row.supermercado].push({ precio: parseFloat(row.precio), fecha: row.fecha_registro });
    });
    const stats = Object.entries(bySuper).map(([s, rows]) => {
      const precios = rows.map(r => r.precio);
      return {
        supermercado: s,
        min:          Math.min(...precios).toFixed(2),
        max:          Math.max(...precios).toFixed(2),
        avg:          (precios.reduce((a, b) => a + b, 0) / precios.length).toFixed(2),
        ultimo:       rows[rows.length - 1].precio.toFixed(2),
        ultima_fecha: rows[rows.length - 1].fecha,
        historial:    rows,
      };
    }).sort((a, b) => parseFloat(a.avg) - parseFloat(b.avg));
    res.json({ producto: maestro, stats, total_registros: historial.length });
  } catch (e) { console.error('[Precios]', e.message); res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/maestros/buscar', auth, async (req, res) => {
  const q = `%${req.query.q || ''}%`;
  try {
    const [rows] = await dbPool.execute(
      'SELECT id, nombre, marca, categoria, foto_url, codigo_barras FROM productos_maestros WHERE nombre LIKE ? OR marca LIKE ? ORDER BY (foto_url IS NOT NULL) DESC LIMIT 10',[q, q]
    );
    res.json(rows);
  } catch (e) { res.status(500).json([]); }
});

// ── Open Food Facts ───────────────────────────────────────────
function mapOffProducts(data) {
  const products = Array.isArray(data?.products) ? data.products :[];
  return products.map(p => {
    const nombre = (p.product_name_es || p.product_name || p.generic_name_es || p.generic_name || '').trim();
    if (!nombre) return null;
    return {
      nombre,
      marca:       (p.brands || 'Generico').split(',')[0].trim(),
      foto_url:    p.image_front_small_url || p.image_small_url || '',
      codigo_barras: p.code || null,
      fuente: 'OFF',
    };
  }).filter(Boolean);
}

function offRequestConfig(q, timeoutMs) {
  return {
    params:  { search_terms: q, search_simple: 1, action: 'process', json: 1, page_size: 15, lc: 'es', cc: 'es' },
    timeout: timeoutMs,
    headers: { 'User-Agent': 'Wget/1.21.3', Accept: '*/*' },
  };
}

function parseOffResults(data) {
  if (typeof data === 'string') {
    const head = data.slice(0, 300).toLowerCase();
    if (head.includes('<!doctype html') || head.includes('<html')) throw new Error('OFF respondió HTML temporal');
    throw new Error('OFF payload no-JSON');
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.products)) throw new Error('OFF payload inválido');
  return mapOffProducts(data);
}

function normalizarEan(valor)             { return String(valor || '').replace(/\D/g, ''); }
function sanitizarTexto(valor, maxLen)    { return String(valor || '').trim().replace(/\s+/g, ' ').slice(0, maxLen); }
function opfUrl(pathname)                 { return `${OPF_BASE_URL.replace(/\/+$/, '')}/${String(pathname || '').replace(/^\/+/, '')}`; }
function buildOpfHeaders() {
  const headers = { 'User-Agent': OPF_USER_AGENT, Accept: 'application/json' };
  if (OPENFACTS_API_KEY) headers['X-Api-Key'] = OPENFACTS_API_KEY;
  return headers;
}
function buildOpfLookupUrl(ean) { return opfUrl(`${OPF_LOOKUP_PATH.replace(/\/+$/, '')}/${ean}.json`); }

async function persistOpfFile(file) {
  if (!file) return null;
  const ext     = path.extname(file.originalname || '').toLowerCase();
  const allowed =['.jpg', '.jpeg', '.png', '.webp'];
  const safeExt = allowed.includes(ext) ? ext : (file.mimetype === 'image/png' ? '.png' : '.jpg');
  const filename     = `opf_${Date.now()}_${crypto.randomUUID()}${safeExt}`;
  const relativePath = path.join('private', 'opf_uploads', filename);
  const fullPath     = path.join(__dirname, relativePath);
  await fs.promises.writeFile(fullPath, file.buffer);
  return relativePath.replace(/\\/g, '/');
}

async function enviarOpfProducto({ ean, nombre, marca }) {
  if (!OPF_USER_ID || !OPF_PASSWORD) throw new Error('Credenciales OPF no configuradas');
  const form = new FormData();
  form.append('code', ean);
  form.append('product_name', nombre);
  form.append('brands', marca);
  form.append('lc', 'es');
  form.append('cc', 'es');
  form.append('user_id', OPF_USER_ID);
  form.append('password', OPF_PASSWORD);
  form.append('json', '1');
  const headers = { ...form.getHeaders(), ...buildOpfHeaders() };
  const r = await axios.post(opfUrl(OPF_CREATE_PATH), form, { headers, timeout: OPF_TIMEOUT_MS });
  return r.data;
}

async function enviarOpfImagen({ ean, file }) {
  if (!OPF_USER_ID || !OPF_PASSWORD) throw new Error('Credenciales OPF no configuradas');
  const form = new FormData();
  form.append('code', ean);
  form.append('imagefield', 'front');
  form.append('imgupload_front', file.buffer, { filename: file.originalname, contentType: file.mimetype });
  form.append('user_id', OPF_USER_ID);
  form.append('password', OPF_PASSWORD);
  form.append('json', '1');
  const headers = { ...form.getHeaders(), ...buildOpfHeaders() };
  const r = await axios.post(opfUrl(OPF_IMAGE_PATH), form, { headers, timeout: OPF_TIMEOUT_MS });
  return r.data;
}

async function upsertProductoMaestroFromOpf({ ean, nombre, marca, foto_url }) {
  const eanClean    = normalizarEan(ean);
  const nombreClean = sanitizarTexto(nombre, 200).toUpperCase();
  const marcaClean  = sanitizarTexto(marca,  100).toUpperCase() || 'GENERICA';
  const fotoClean   = foto_url ? String(foto_url).slice(0, 500) : null;
  if (!eanClean || !nombreClean) return null;

  const [[existing]] = await dbPool.execute(
    'SELECT id, nombre, marca, foto_url FROM productos_maestros WHERE codigo_barras = ? LIMIT 1',[eanClean]
  );
  if (existing) {
    const updates = []; const params =[];
    if (!existing.nombre  && nombreClean) { updates.push('nombre = ?');   params.push(nombreClean); }
    if (!existing.marca   && marcaClean)  { updates.push('marca = ?');    params.push(marcaClean); }
    if (!existing.foto_url && fotoClean)  { updates.push('foto_url = ?'); params.push(fotoClean); }
    if (updates.length > 0) {
      params.push(existing.id);
      await dbPool.execute(`UPDATE productos_maestros SET ${updates.join(', ')} WHERE id = ?`, params);
    }
    return existing.id;
  }
  const [ins] = await dbPool.execute(
    'INSERT INTO productos_maestros (nombre, marca, categoria, foto_url, codigo_barras) VALUES (?,?,?,?,?)',[nombreClean, marcaClean, 'Alimentacion', fotoClean, eanClean]
  );
  return ins.insertId;
}

app.get('/api/proxy/off', auth, async (req, res) => {
  const timeoutMs = Number.isFinite(OFF_TIMEOUT_MS) ? OFF_TIMEOUT_MS : 10000;
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const candidates =[
      { name: 'direct-org',     url: OFF_SEARCH_URL,    timeout: timeoutMs },
      { name: 'direct-net',     url: OFF_SECONDARY_URL, timeout: timeoutMs },
      { name: 'nginx-fallback', url: OFF_FALLBACK_URL,  timeout: timeoutMs + 2000 },
    ].filter((item, index, arr) => arr.findIndex(x => x.url === item.url) === index);

    let lastReason = 'desconocido';
    for (const source of candidates) {
      try {
        const r = await axios.get(source.url, offRequestConfig(q, source.timeout));
        return res.json(parseOffResults(r.data));
      } catch (attemptError) {
        lastReason = attemptError.response?.status || attemptError.code || attemptError.message;
        console.warn(`[OFF] ${source.name} falló (${lastReason})`);
      }
    }
    console.error(`[OFF] Todos los orígenes fallaron (${lastReason})`);
    return res.json([]);
  } catch (e) {
    console.error(`[OFF] Fallback agotado: ${e.response?.status || e.code || e.message}`);
    return res.json([]);
  }
});

app.post('/api/opf/import', auth, async (req, res) => {
  const ean     = normalizarEan(req.body.ean);
  const nombre  = sanitizarTexto(req.body.nombre, 200);
  const marca   = sanitizarTexto(req.body.marca,  100);
  const foto_url = req.body.image_url || req.body.foto_url || '';
  if (!/^\d{8,14}$/.test(ean)) return res.status(400).json({ error: 'EAN inválido' });
  if (!nombre) return res.status(400).json({ error: 'Nombre obligatorio' });
  try {
    const id = await upsertProductoMaestroFromOpf({ ean, nombre, marca, foto_url });
    return res.json({ success: true, id });
  } catch (e) {
    console.error('[OPF] Import local error:', e.message);
    return res.status(500).json({ error: 'Error guardando producto' });
  }
});

app.get('/api/opf/lookup/:ean', auth, async (req, res) => {
  const ean = normalizarEan(req.params.ean);
  if (!/^\d{8,14}$/.test(ean)) return res.status(400).json({ error: 'EAN inválido' });
  try {
    const r       = await axios.get(buildOpfLookupUrl(ean), { headers: buildOpfHeaders(), timeout: OPF_TIMEOUT_MS });
    const data    = r.data || {};
    const product = data.product || null;
    const found   = data.status === 1 || data.status === '1' || !!product;
    if (!found) return res.json({ found: false });
    res.json({
      found: true,
      product: {
        product_name: product.product_name || product.product_name_es || '',
        brands:       product.brands || '',
        image_url:    product.image_url || product.image_front_url || '',
      },
    });
  } catch (e) {
    console.warn(`[OPF] Lookup falló (${e.response?.status || e.code || e.message})`);
    res.status(502).json({ error: 'No se pudo consultar OPF' });
  }
});

app.post('/api/opf/create', auth, (req, res) => {
  uploadOpf.single('foto')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Error de archivo' });

    const status = String(req.body.status || 'draft').toLowerCase();
    const ean    = normalizarEan(req.body.ean);
    const nombre = sanitizarTexto(req.body.nombre, 200);
    const marca  = sanitizarTexto(req.body.marca,  100);
    const file   = req.file || null;

    if (!/^\d{8,14}$/.test(ean))    return res.status(400).json({ error: 'EAN inválido' });
    if (!nombre || !marca)          return res.status(400).json({ error: 'Nombre y marca son obligatorios' });
    if (!['draft','ready'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
    const esAdmin = !!req.session.usuario?.es_admin;
    let estado = status === 'ready' ? 'sent' : 'draft';
    let opfResponse = null;
    let errorMsg    = null;
    let fotoPath    = null;
    let localProductId = null;

    if (status === 'ready' && !esAdmin) {
      try {
        if (file) fotoPath = await persistOpfFile(file);
        localProductId = await upsertProductoMaestroFromOpf({ ean, nombre, marca, foto_url: null });
      } catch (e) { console.warn('[OPF] Pendiente local fallido:', e.message); }
      const [pend] = await dbPool.execute(
        `INSERT INTO opf_pendientes (id_usuario, ean, nombre, marca, foto_path) VALUES (?,?,?,?,?)`,[req.session.usuario.id, ean, nombre, marca, fotoPath]
      );
      return res.json({ success: true, pending: true, pending_id: pend.insertId, local_product_id: localProductId });
    }

    try {
      if (status === 'ready') {
        const productoRes = await enviarOpfProducto({ ean, nombre, marca });
        let imagenRes = null;
        if (file) imagenRes = await enviarOpfImagen({ ean, file });
        opfResponse = { producto: productoRes, imagen: imagenRes };
      }
    } catch (e) {
      estado    = 'failed';
      errorMsg  = e.message || 'Error enviando a OPF';
      if (file) fotoPath = await persistOpfFile(file);
    }

    if (status === 'draft' && file) fotoPath = await persistOpfFile(file);

    try { localProductId = await upsertProductoMaestroFromOpf({ ean, nombre, marca, foto_url: null }); }
    catch (e) { console.warn('[OPF] Import local fallido:', e.message); }

    const [result] = await dbPool.execute(
      `INSERT INTO opf_drafts (id_usuario, ean, nombre, marca, foto_path, estado, opf_response, error_msg) VALUES (?,?,?,?,?,?,?,?)`,[req.session.usuario.id, ean, nombre, marca, fotoPath, estado,
        opfResponse ? JSON.stringify(opfResponse).slice(0, 4000) : null,
        errorMsg ? errorMsg.slice(0, 500) : null]
    );

    if (estado === 'failed') return res.status(502).json({ error: errorMsg || 'Error enviando a OPF', draft_id: result.insertId, local_product_id: localProductId });
    res.json({ success: true, draft_id: result.insertId, sent: estado === 'sent', local_product_id: localProductId });
  });
});

// ── Compras ───────────────────────────────────────────────────
app.post('/api/compras/vincular', auth, async (req, res) => {
  const { id_compra, id_producto_maestro, producto_externo } = req.body;
  const uid  = req.session.usuario.id;
  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const [compraRows] = await conn.execute(
      `SELECT id_producto, nombre_original FROM compras WHERE id = ? AND id_usuario = ?`, [id_compra, uid]
    );
    if (compraRows.length === 0) { await conn.rollback(); return res.status(404).json({ error: 'Compra no encontrada' }); }

    const idMaestroBasura  = compraRows[0].id_producto;
    const nombreEnTiquet   = compraRows[0].nombre_original;
    let idMaestroOficial   = id_producto_maestro;
    let barcode            = producto_externo ? producto_externo.codigo_barras : null;

    if (producto_externo) {
      const [existe] = await conn.execute('SELECT id FROM productos_maestros WHERE codigo_barras = ?', [barcode]);
      if (existe.length > 0) { idMaestroOficial = existe[0].id; }
      else {
        const [ins] = await conn.execute(
          'INSERT INTO productos_maestros (nombre, marca, categoria, foto_url, codigo_barras) VALUES (?,?,?,?,?)',[producto_externo.nombre.toUpperCase(), (producto_externo.marca || 'Genérica').toUpperCase(), 'Alimentacion', producto_externo.foto_url, barcode]
        );
        idMaestroOficial = ins.insertId;
      }
    } else if (!idMaestroOficial) { throw new Error("Se requiere un producto oficial para vincular."); }

    if (nombreEnTiquet) {
      await conn.execute(`
        INSERT INTO diccionario_productos (nombre_en_tiquet, id_producto_maestro, usos)
        VALUES (?, ?, 1)
        ON DUPLICATE KEY UPDATE id_producto_maestro = ?, usos = usos + 1, actualizado_en = NOW()
      `, [nombreEnTiquet, idMaestroOficial, idMaestroOficial]);
    }

    if (idMaestroBasura && idMaestroBasura !== idMaestroOficial) {
      await conn.execute(`UPDATE compras SET id_producto = ?, curado = 1 WHERE id_producto = ?`, [idMaestroOficial, idMaestroBasura]);
      await conn.execute(`UPDATE historial_precios SET id_producto = ? WHERE id_producto = ?`,[idMaestroOficial, idMaestroBasura]);
      try { await conn.execute(`DELETE FROM productos_maestros WHERE id = ?`, [idMaestroBasura]); } catch {}
    } else {
      await conn.execute('UPDATE compras SET id_producto = ?, curado = 1 WHERE id = ?',[idMaestroOficial, id_compra]);
    }

    if (barcode) {
      const [verifRows] = await conn.execute(`SELECT id FROM verificaciones_barcode WHERE id_producto = ? AND codigo_barras = ?`, [idMaestroOficial, barcode]);
      let verifId;
      if (verifRows.length === 0) {
        const [insertVerif] = await conn.execute(`INSERT INTO verificaciones_barcode (id_producto, codigo_barras, votos_si) VALUES (?, ?, 0)`, [idMaestroOficial, barcode]);
        verifId = insertVerif.insertId;
      } else { verifId = verifRows[0].id; }
      const [votoResult] = await conn.execute(`INSERT IGNORE INTO votos_usuario (id_usuario, id_verificacion, voto) VALUES (?, ?, 'si')`, [uid, verifId]);
      if (votoResult.affectedRows > 0) {
        await conn.execute(`UPDATE verificaciones_barcode SET votos_si = votos_si + 1 WHERE id = ?`, [verifId]);
        await verificarConsenso(conn, verifId);
      }
    }

    await conn.commit();
    res.json({ success: true, message: 'Producto vinculado y base de datos optimizada' });
  } catch (e) { await conn.rollback(); console.error('[Vincular]', e.message); res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

app.post('/api/compras/:idCompra/desvincular', auth, async (req, res) => {
  const uid      = req.session.usuario.id;
  const idCompra = parseInt(req.params.idCompra, 10);
  if (!Number.isFinite(idCompra)) return res.status(400).json({ error: 'ID inválido' });

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const [[compra]] = await conn.execute(
      `SELECT id, id_usuario, id_producto, nombre_original FROM compras WHERE id = ? AND id_usuario = ?`, [idCompra, uid]
    );
    if (!compra) { await conn.rollback(); return res.status(404).json({ error: 'Compra no encontrada' }); }

    const nombreBase = (compra.nombre_original || 'Producto sin vincular').trim().toUpperCase();
    const [ins] = await conn.execute('INSERT INTO productos_maestros (nombre, marca, categoria) VALUES (?,?,?)',[nombreBase.slice(0, 200), 'Generica', 'Otros']);
    await conn.execute('UPDATE compras SET id_producto = ?, curado = 0 WHERE id = ?', [ins.insertId, idCompra]);

    if (compra.id_producto) {
      await conn.execute(
        `INSERT INTO verificaciones_producto (id_producto, id_usuario, motivo) VALUES (?,?,?)`,[compra.id_producto, uid, 'Desvinculado por usuario']
      );
    }
    await conn.commit();
    res.json({ success: true, id_producto: ins.insertId });
  } catch (e) { await conn.rollback(); console.error('[Desvincular]', e.message); res.status(500).json({ error: 'Error desvinculando compra' }); }
  finally { conn.release(); }
});

app.post('/api/verificaciones/votar', auth, async (req, res) => {
  const { id_verificacion, voto } = req.body;
  const uid  = req.session.usuario.id;
  if (!['si', 'no'].includes(voto)) return res.status(400).json({ error: 'Voto inválido' });
  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const [[verif]] = await conn.execute("SELECT * FROM verificaciones_barcode WHERE id = ? AND estado = 'pendiente'", [id_verificacion]);
    if (!verif) { await conn.rollback(); return res.status(404).json({ error: 'No encontrada o ya cerrada' }); }
    const [[yaVoto]] = await conn.execute('SELECT id FROM votos_usuario WHERE id_usuario = ? AND id_verificacion = ?', [uid, id_verificacion]);
    if (yaVoto) { await conn.rollback(); return res.status(409).json({ error: 'Ya has votado' }); }
    await conn.execute('INSERT INTO votos_usuario (id_usuario, id_verificacion, voto) VALUES (?,?,?)', [uid, id_verificacion, voto]);
    const campo = voto === 'si' ? 'votos_si' : 'votos_no';
    await conn.execute(`UPDATE verificaciones_barcode SET ${campo} = ${campo} + 1 WHERE id = ?`, [id_verificacion]);
    await verificarConsenso(conn, id_verificacion);
    await conn.commit();
    const [[updated]] = await dbPool.execute('SELECT votos_si, votos_no, estado FROM verificaciones_barcode WHERE id = ?', [id_verificacion]);
    res.json({ success: true, ...updated });
  } catch (e) { await conn.rollback(); console.error('[Votar]', e.message); res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

app.post('/api/verificaciones/admin', auth, adminOnly, async (req, res) => {
  const idVerificacion = parseInt(req.body.id_verificacion, 10);
  const accion         = String(req.body.accion || '').toLowerCase();
  if (!Number.isFinite(idVerificacion))            return res.status(400).json({ error: 'ID inválido' });
  if (!['aprobar','rechazar'].includes(accion))    return res.status(400).json({ error: 'Acción inválida' });

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const [[verif]] = await conn.execute(
      'SELECT id, id_producto, codigo_barras, estado FROM verificaciones_barcode WHERE id = ? FOR UPDATE', [idVerificacion]
    );
    if (!verif || verif.estado !== 'pendiente') { await conn.rollback(); return res.status(404).json({ error: 'Verificación no encontrada o ya cerrada' }); }

    if (accion === 'aprobar') {
      await conn.execute("UPDATE verificaciones_barcode SET estado = 'verificado' WHERE id = ?",[idVerificacion]);
      await conn.execute('UPDATE productos_maestros SET codigo_barras = ? WHERE id = ?', [verif.codigo_barras, verif.id_producto]);
    } else {
      await conn.execute("UPDATE verificaciones_barcode SET estado = 'rechazado' WHERE id = ?", [idVerificacion]);
      await conn.execute('UPDATE productos_maestros SET codigo_barras = NULL WHERE id = ? AND codigo_barras = ?',[verif.id_producto, verif.codigo_barras]);
    }
    await conn.commit();
    res.json({ success: true, estado: accion === 'aprobar' ? 'verificado' : 'rechazado' });
  } catch (e) { await conn.rollback(); console.error('[VerificacionAdmin]', e.message); res.status(500).json({ error: 'Error actualizando verificación' }); }
  finally { conn.release(); }
});

app.post('/api/verificaciones/admin/crear', auth, adminOnly, async (req, res) => {
  const idProducto = parseInt(req.body.id_producto, 10);
  const codigo     = normalizarEan(req.body.codigo_barras);
  if (!Number.isFinite(idProducto))      return res.status(400).json({ error: 'ID inválido' });
  if (!/^[0-9]{8,14}$/.test(codigo))    return res.status(400).json({ error: 'EAN inválido' });

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const [[prod]] = await conn.execute('SELECT id FROM productos_maestros WHERE id = ? FOR UPDATE', [idProducto]);
    if (!prod) { await conn.rollback(); return res.status(404).json({ error: 'Producto no encontrado' }); }
    await conn.execute('UPDATE productos_maestros SET codigo_barras = ? WHERE id = ?', [codigo, idProducto]);
    await conn.execute(
      `INSERT INTO verificaciones_barcode (id_producto, codigo_barras, votos_si) VALUES (?,?,0) ON DUPLICATE KEY UPDATE estado = 'pendiente'`,[idProducto, codigo]
    );
    await conn.commit();
    res.json({ success: true });
  } catch (e) { await conn.rollback(); console.error('[VerificacionAdminCrear]', e.message); res.status(500).json({ error: 'Error creando referencia' }); }
  finally { conn.release(); }
});

app.post('/api/opf/pending/approve', auth, adminOnly, async (req, res) => {
  const idPendiente = parseInt(req.body.id_pendiente, 10);
  if (!Number.isFinite(idPendiente)) return res.status(400).json({ error: 'ID inválido' });

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const [[pend]] = await conn.execute(`SELECT * FROM opf_pendientes WHERE id = ? FOR UPDATE`, [idPendiente]);
    if (!pend || pend.estado !== 'pendiente') { await conn.rollback(); return res.status(404).json({ error: 'Pendiente no encontrado o ya procesado' }); }

    let opfResponse = null; let errorMsg = null;
    try {
      const productoRes = await enviarOpfProducto({ ean: pend.ean, nombre: pend.nombre, marca: pend.marca });
      let imagenRes = null;
      if (pend.foto_path) {
        const fullPath = path.join(__dirname, pend.foto_path);
        const buffer   = await fs.promises.readFile(fullPath);
        const ext      = path.extname(pend.foto_path).toLowerCase();
        const mimetype = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
        imagenRes = await enviarOpfImagen({ ean: pend.ean, file: { buffer, originalname: path.basename(pend.foto_path), mimetype } });
      }
      opfResponse = { producto: productoRes, imagen: imagenRes };
      await conn.execute("UPDATE opf_pendientes SET estado = 'enviado', opf_response = ?, error_msg = NULL WHERE id = ?",[JSON.stringify(opfResponse).slice(0, 4000), idPendiente]);
    } catch (e) {
      errorMsg = e.message || 'Error enviando a OPF';
      await conn.execute("UPDATE opf_pendientes SET estado = 'fallido', error_msg = ? WHERE id = ?",[errorMsg.slice(0, 500), idPendiente]);
    }
    await conn.commit();
    if (errorMsg) return res.status(502).json({ error: errorMsg });
    res.json({ success: true });
  } catch (e) { await conn.rollback(); console.error('[OpfApprove]', e.message); res.status(500).json({ error: 'Error aprobando pendiente' }); }
  finally { conn.release(); }
});

app.post('/api/opf/pending/reject', auth, adminOnly, async (req, res) => {
  const idPendiente = parseInt(req.body.id_pendiente, 10);
  if (!Number.isFinite(idPendiente)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const [r] = await dbPool.execute("UPDATE opf_pendientes SET estado = 'rechazado' WHERE id = ? AND estado = 'pendiente'", [idPendiente]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Pendiente no encontrado o ya procesado' });
    res.json({ success: true });
  } catch (e) { console.error('[OpfReject]', e.message); res.status(500).json({ error: 'Error rechazando pendiente' }); }
});

app.post('/api/verificaciones/producto/admin', auth, adminOnly, async (req, res) => {
  const idVerificacion = parseInt(req.body.id_verificacion, 10);
  const accion         = String(req.body.accion || '').toLowerCase();
  if (!Number.isFinite(idVerificacion))                               return res.status(400).json({ error: 'ID inválido' });
  if (!['eliminar','rechazar','desvincular'].includes(accion))        return res.status(400).json({ error: 'Acción inválida' });

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const [[verif]] = await conn.execute(
      `SELECT vp.id, vp.id_producto, vp.estado FROM verificaciones_producto vp WHERE vp.id = ? FOR UPDATE`, [idVerificacion]
    );
    if (!verif || verif.estado !== 'pendiente') { await conn.rollback(); return res.status(404).json({ error: 'Verificación no encontrada o ya cerrada' }); }

    if (accion === 'eliminar') {
      await conn.execute("UPDATE verificaciones_producto SET estado = 'eliminado' WHERE id = ?", [idVerificacion]);
      await conn.execute('DELETE FROM diccionario_productos WHERE id_producto_maestro = ?', [verif.id_producto]);
      await conn.execute('UPDATE compras SET id_producto = NULL, curado = 0 WHERE id_producto = ?', [verif.id_producto]);
      await conn.execute('DELETE FROM productos_maestros WHERE id = ?', [verif.id_producto]);
    } else if (accion === 'desvincular') {
      await conn.execute("UPDATE verificaciones_producto SET estado = 'desvinculado' WHERE id = ?", [idVerificacion]);
      await conn.execute('DELETE FROM diccionario_productos WHERE id_producto_maestro = ?', [verif.id_producto]);
      await conn.execute('UPDATE compras SET id_producto = NULL, curado = 0 WHERE id_producto = ?',[verif.id_producto]);
    } else {
      await conn.execute("UPDATE verificaciones_producto SET estado = 'rechazado' WHERE id = ?", [idVerificacion]);
    }
    await conn.commit();
    const estadoFinal = accion === 'eliminar' ? 'eliminado' : (accion === 'desvincular' ? 'desvinculado' : 'rechazado');
    res.json({ success: true, estado: estadoFinal });
  } catch (e) { await conn.rollback(); console.error('[VerificacionProductoAdmin]', e.message); res.status(500).json({ error: 'Error actualizando verificación' }); }
  finally { conn.release(); }
});

// ── Eliminar una línea de compra ──────────────────────────────
app.delete('/api/compra/:idCompra', auth, async (req, res) => {
  const uid      = req.session.usuario.id;
  const idCompra = parseInt(req.params.idCompra, 10);
  if (isNaN(idCompra)) return res.status(400).json({ error: 'ID inválido' });

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    // Verificar que la compra pertenece al usuario y obtener el tiquet
    const [[compra]] = await conn.execute(
      `SELECT c.id, c.id_tiquet
       FROM compras c
       JOIN tiquets t ON t.id = c.id_tiquet
       WHERE c.id = ? AND c.id_usuario = ?`,[idCompra, uid]
    );
    if (!compra) {
      await conn.rollback();
      return res.status(404).json({ error: 'Compra no encontrada' });
    }

    // Eliminar la línea
    await conn.execute('DELETE FROM compras WHERE id = ?', [idCompra]);

    // Recalcular y actualizar el total del tiquet
    const [[{ nuevo_total }]] = await conn.execute(
      `SELECT COALESCE(SUM(cantidad * precio_unitario), 0) AS nuevo_total
       FROM compras WHERE id_tiquet = ?`,[compra.id_tiquet]
    );
    await conn.execute(
      'UPDATE tiquets SET total_tiquet = ? WHERE id = ?',
      [nuevo_total, compra.id_tiquet]
    );

    await conn.commit();
    res.json({ success: true, nuevo_total });
  } catch (e) {
    await conn.rollback();
    console.error('[EliminarCompra]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

app.post('/api/compra/:idCompra/precio', auth, async (req, res) => {
  const uid         = req.session.usuario.id;
  const idCompra    = parseInt(req.params.idCompra, 10);
  const nuevoPrecio = parseFloat(req.body.precio);
  if (isNaN(idCompra) || isNaN(nuevoPrecio)) return res.status(400).json({ error: 'Datos inválidos' });

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const [[compra]] = await conn.execute(`
      SELECT c.id, c.id_tiquet, c.id_producto, c.cantidad, c.precio_unitario, c.es_descuento, t.supermercado
      FROM compras c JOIN tiquets t ON t.id = c.id_tiquet
      WHERE c.id = ? AND c.id_usuario = ?
    `,[idCompra, uid]);
    if (!compra) { await conn.rollback(); return res.status(404).json({ error: 'Compra no encontrada' }); }

    await conn.execute('UPDATE compras SET precio_unitario = ? WHERE id = ?', [nuevoPrecio, idCompra]);

    if (!compra.es_descuento && compra.id_producto && nuevoPrecio !== 0) {
      await conn.execute('INSERT INTO historial_precios (id_producto, supermercado, precio) VALUES (?,?,?)',
        [compra.id_producto, compra.supermercado, Math.abs(nuevoPrecio)]);
    }

    const [[{ nuevo_total }]] = await conn.execute(
      `SELECT COALESCE(SUM(cantidad * precio_unitario), 0) AS nuevo_total FROM compras WHERE id_tiquet = ?`, [compra.id_tiquet]
    );
    await conn.execute('UPDATE tiquets SET total_tiquet = ? WHERE id = ?',[nuevo_total, compra.id_tiquet]);
    await conn.commit();
    res.json({ success: true, nuevo_precio: nuevoPrecio, nuevo_total });
  } catch (e) { await conn.rollback(); console.error('[EditarPrecio]', e.message); res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

app.post('/api/tiquet/:uuid/supermercado', auth, async (req, res) => {
  const uid  = req.session.usuario.id;
  const nuevo = sanitizarTexto(req.body.supermercado, 100);
  if (!nuevo) return res.status(400).json({ error: 'Nombre inválido' });
  const normalizado = normalizarTienda(nuevo);
  try {
    const [r] = await dbPool.execute(
      'UPDATE tiquets SET supermercado = ? WHERE uuid = ? AND id_usuario = ?',
      [normalizado, req.params.uuid, uid]
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Tiquet no encontrado' });
    res.json({ success: true, supermercado: normalizado });
  } catch (e) {
    console.error('[EditarSupermercado]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// PERFIL
// ════════════════════════════════════════════════════════════
app.get('/perfil', auth, async (req, res) => {
  try {
    const uid = req.session.usuario.id;
    const [[userDb]] = await dbPool.execute('SELECT email, totp_enabled FROM usuarios WHERE id = ?', [uid]);
    const[historial, totales] = await Promise.all([getTiquets(uid), getTotalesPeriodo(uid)]);
    const messages = [];
    if (req.query.success) messages.push(['success', decodeURIComponent(req.query.success)]);
    if (req.query.error)   messages.push(['danger',  decodeURIComponent(req.query.error)]);
    res.render('perfil.html', { ...navLocals(req), email: userDb.email || '', totp_enabled: userDb.totp_enabled === 1, total_tiquets: historial.length, total_gastado: totales.total, messages });
  } catch (e) { res.redirect('/dashboard'); }
});

app.post('/perfil', auth, async (req, res) => {
  const { nuevo_username, nuevo_email, password_actual, nueva_password } = req.body;
  const uid  = req.session.usuario.id;
  const msgs = [];
  try {
    const [[user]] = await dbPool.execute('SELECT * FROM usuarios WHERE id=?', [uid]);
    if (!user) return res.redirect('/logout');
    if (nuevo_username && nuevo_username !== user.username) { await dbPool.execute('UPDATE usuarios SET username=? WHERE id=?', [nuevo_username, uid]); req.session.usuario.username = nuevo_username; msgs.push(['success', 'Nombre actualizado.']); }
    if (nuevo_email && nuevo_email !== user.email)          { await dbPool.execute('UPDATE usuarios SET email=? WHERE id=?',    [nuevo_email,    uid]); req.session.usuario.email    = nuevo_email;    msgs.push(['success', 'Email actualizado.']); }
    if (password_actual && nueva_password) {
      if (!bcryptjs.compareSync(password_actual, user.password_hash)) msgs.push(['danger', 'Contraseña actual incorrecta.']);
      else if (nueva_password.length < 8)                             msgs.push(['danger', 'Mínimo 8 caracteres.']);
      else { await dbPool.execute('UPDATE usuarios SET password_hash=? WHERE id=?',[bcryptjs.hashSync(nueva_password, 12), uid]); msgs.push(['success', 'Contraseña cambiada.']); }
    }
  } catch (e) { msgs.push(['danger', 'Error al actualizar.']); }
  try {
    const [[userDb]] = await dbPool.execute('SELECT email, totp_enabled FROM usuarios WHERE id = ?', [uid]);
    const[historial, totales] = await Promise.all([getTiquets(uid), getTotalesPeriodo(uid)]);
    res.render('perfil.html', { ...navLocals(req), email: userDb.email || '', totp_enabled: userDb.totp_enabled === 1, total_tiquets: historial.length, total_gastado: totales.total, messages: msgs });
  } catch (e) { res.redirect('/dashboard'); }
});

app.post('/perfil/avatar', auth, (req, res) => {
  uploadAvatar.single('avatar')(req, res, async (err) => {
    if (err || !req.file) return res.json({ success: false, error: err?.message || 'Sin archivo' });
    let finalPath = req.file.path;
    try {
      const detectedExt = await detectarAvatarPorMagic(req.file.path);
      if (!detectedExt) { await fs.promises.unlink(req.file.path).catch(() => {}); return res.json({ success: false, error: 'Formato de avatar no permitido' }); }
      let finalFilename = req.file.filename;
      const currentExt  = path.extname(finalFilename).toLowerCase();
      if (currentExt !== detectedExt) {
        const base        = path.basename(finalFilename, currentExt || undefined);
        const newFilename = `${base}${detectedExt}`;
        const newPath     = path.join(path.dirname(req.file.path), newFilename);
        await fs.promises.rename(req.file.path, newPath);
        finalPath     = newPath;
        finalFilename = newFilename;
      }
      const url   = `/avatars/${finalFilename}`;
      const [[u]] = await dbPool.execute('SELECT avatar FROM usuarios WHERE id=?', [req.session.usuario.id]);
      if (u?.avatar?.startsWith('/avatars/')) {
        const oldName = path.basename(u.avatar);
        for (const dir of AVATAR_DIRS) {
          const old = getAvatarPath(oldName, dir);
          if (old && fs.existsSync(old)) fs.unlink(old, () => {});
        }
      }
      await dbPool.execute('UPDATE usuarios SET avatar=? WHERE id=?',[url, req.session.usuario.id]);
      req.session.usuario.avatar = url;
      res.json({ success: true, avatar: url });
    } catch (e) {
      await fs.promises.unlink(finalPath).catch(() => {});
      res.json({ success: false, error: 'Error guardando avatar' });
    }
  });
});

app.post('/perfil/eliminar_cuenta', auth, async (req, res) => {
  const { password_borrado } = req.body;
  const uid  = req.session.usuario.id;
  if (!password_borrado) return res.redirect('/perfil?error=Debes+introducir+tu+contraseña');
  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const [[u]] = await conn.execute('SELECT password_hash, avatar FROM usuarios WHERE id=?', [uid]);
    if (!u) { await conn.rollback(); return res.redirect('/login'); }
    if (!bcryptjs.compareSync(password_borrado, u.password_hash)) { await conn.rollback(); return res.redirect('/perfil?error=Contraseña+incorrecta.+Operación+cancelada.'); }
    if (u.avatar?.startsWith('/avatars/')) {
      const oldName = path.basename(u.avatar);
      for (const dir of AVATAR_DIRS) {
        const p = getAvatarPath(oldName, dir);
        if (p && fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
    await conn.execute('DELETE FROM compras              WHERE id_usuario=?',[uid]);
    await conn.execute('DELETE FROM tiquets              WHERE id_usuario=?', [uid]);
    await conn.execute('DELETE FROM codigos_recuperacion WHERE id_usuario=?', [uid]);
    await conn.execute('DELETE FROM usuarios             WHERE id=?',         [uid]);
    await conn.commit();
    req.session.destroy(() => res.redirect('/login?success=Tu+cuenta+ha+sido+eliminada+para+siempre'));
  } catch (e) { await conn.rollback(); res.redirect('/perfil?error=Error+interno'); }
  finally { conn.release(); }
});

// ── 2FA ───────────────────────────────────────────────────────
app.get('/perfil/2fa/setup', auth, async (req, res) => {
  const uid   = req.session.usuario.id;
  const [[u]] = await dbPool.execute('SELECT totp_enabled FROM usuarios WHERE id=?', [uid]);
  if (u.totp_enabled) return res.redirect('/perfil?error=2FA+ya+activo');
  const secret         = speakeasy.generateSecret({ name: `Esítiron (${req.session.usuario.username})`, length: 20 });
  req.session.totp_setup_secret = secret.base32;
  const formattedSecret = secret.base32.match(/.{1,4}/g).join(' ');
  const qrDataUrl       = await QRCode.toDataURL(secret.otpauth_url);
  res.render('perfil_2fa_setup.html', { usuario: req.session.usuario.username, qr: qrDataUrl, secret_manual: formattedSecret, messages:[] });
});

app.post('/perfil/2fa/setup', auth, async (req, res) => {
  const { token } = req.body;
  const secret    = req.session.totp_setup_secret;
  if (!secret) return res.redirect('/perfil/2fa/setup');
  const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: (token || '').replace(/\s/g, ''), window: 1 });
  if (!valid) return res.redirect('/perfil/2fa/setup?error=Código+incorrecto');
  const encryptedSecret = encrypt(secret);
  const backupCodes     = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex'));
  const hashedCodes     = backupCodes.map(code => bcryptjs.hashSync(code, 10));
  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('UPDATE usuarios SET totp_secret=?, totp_enabled=1 WHERE id=?',[encryptedSecret, req.session.usuario.id]);
    await conn.execute('DELETE FROM codigos_recuperacion WHERE id_usuario=?', [req.session.usuario.id]);
    for (const hash of hashedCodes) await conn.execute('INSERT INTO codigos_recuperacion (id_usuario, codigo_hash) VALUES (?,?)', [req.session.usuario.id, hash]);
    await conn.commit();
  } catch (e) { await conn.rollback(); return res.redirect('/perfil/2fa/setup?error=Error+interno+al+guardar'); }
  finally { conn.release(); }
  delete req.session.totp_setup_secret;
  req.session.backupCodes = backupCodes;
  res.redirect('/perfil/2fa/backup');
});

app.get('/perfil/2fa/backup', auth, (req, res) => {
  const codes = req.session.backupCodes;
  if (!codes) return res.redirect('/perfil');
  delete req.session.backupCodes;
  res.render('perfil_2fa_backup.html', { ...navLocals(req), codes });
});

app.post('/perfil/2fa/disable', auth, async (req, res) => {
  const { password } = req.body;
  const uid          = req.session.usuario.id;
  const [[u]]        = await dbPool.execute('SELECT password_hash FROM usuarios WHERE id=?', [uid]);
  if (!bcryptjs.compareSync(password, u.password_hash)) return res.redirect('/perfil?error=Contraseña+incorrecta');
  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('UPDATE usuarios SET totp_secret=NULL, totp_enabled=0 WHERE id=?', [uid]);
    await conn.execute('DELETE FROM codigos_recuperacion WHERE id_usuario=?', [uid]);
    await conn.commit();
  } catch (e) { await conn.rollback(); }
  finally { conn.release(); }
  res.redirect('/perfil?success=2FA+desactivado');
});

// ── Grupos ────────────────────────────────────────────────────
const { initGruposRoutes } = require('./grupos');
const gruposRouter = initGruposRoutes(dbPool);
app.use('/', gruposRouter);

// ── API legacy ────────────────────────────────────────────────
app.get('/api/tiquets', auth, async (req, res) => {
  try { res.json({ success: true, data: await getTiquets(req.session.usuario.id) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── 404 catch-all ───────────────────────────────────────────
app.use((req, res) => {
  if (!req.session || !req.session.usuario) {
    return res.redirect('/login?error=Debes+iniciar+sesión');
  }
  return res.status(404).render('error404.html', { ...navLocals(req) });
});

// ── Arranque ──────────────────────────────────────────────────
initDB().then(() => {
  metricsServer.listen(9091, '0.0.0.0', () => {
    console.log('[Metrics] puerto 9091 solo accesible internamente');
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Esítiron] port ${PORT} | producción=${IS_PRODUCTION} | cookies secure=${IS_PRODUCTION}`);
  });
}).catch(e => { console.error('[Fatal]', e.message); process.exit(1); });