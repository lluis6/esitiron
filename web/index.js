'use strict';

const express      = require('express');
const session      = require('express-session');
const flash        = require('connect-flash');
const multer       = require('multer');
const mysql        = require('mysql2/promise');
const bcrypt       = require('bcrypt');
const fetch        = require('node-fetch');
const FormData     = require('form-data');
const path         = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const OCR_URL = `http://${process.env.OCR_HOST || 'ocr'}:5000/analitzar`;

// ── Base de dades ─────────────────────────────────────────────────────────────

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'db',
  port:     Number(process.env.DB_PORT || 3306),
  user:     process.env.DB_USER     || 'user_seguro',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'app_db',
  waitForConnections: true,
  connectionLimit:    5,
});

async function crearTaules() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS usuaris (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        username      VARCHAR(80)  UNIQUE NOT NULL,
        email         VARCHAR(120),
        password_hash VARCHAR(256) NOT NULL,
        creat_a       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS tiquets (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        usuari_id     INT NOT NULL,
        supermercado  VARCHAR(120),
        total         DECIMAL(10,2),
        fecha_compra  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuari_id) REFERENCES usuaris(id)
      )
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS productes (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        tiquet_id      INT NOT NULL,
        usuari_id      INT NOT NULL,
        producto       VARCHAR(200),
        categoria      VARCHAR(80),
        cantidad       DECIMAL(8,3) DEFAULT 1,
        precio         DECIMAL(10,2),
        es_descuento   TINYINT(1) DEFAULT 0,
        supermercado   VARCHAR(120),
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tiquet_id) REFERENCES tiquets(id),
        FOREIGN KEY (usuari_id) REFERENCES usuaris(id)
      )
    `);
    console.log('Taules llestes');
  } finally {
    conn.release();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(num) {
  return parseFloat(num || 0).toFixed(2);
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + '  ' + dt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function fmtDateShort(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function loginRequired(req, res, next) {
  if (!req.session.usuariId) return res.redirect('/auth/login');
  next();
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret:            process.env.SECRET_KEY || 'canvia-aixo-en-produccio',
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 1 setmana
}));

app.use(flash());

// Fer flash messages accessibles a tots els templates
app.use((req, res, next) => {
  res.locals.messages = req.flash();
  next();
});

// Upload en memòria (mai toca el disc del contenidor)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter(req, file, cb) {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Formato no soportado. Usa JPG, PNG o WEBP.'));
  },
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── AUTH ──────────────────────────────────────────────────────────────────────

app.get('/auth/login', (req, res) => {
  if (req.session.usuariId) return res.redirect('/');
  res.render('login');
});

app.post('/auth/login', async (req, res) => {
  const { accion, username, password, email } = req.body;
  const user = (username || '').trim();

  if (accion === 'login') {
    const [rows] = await pool.execute(
      'SELECT * FROM usuaris WHERE username = ?', [user]
    );
    const usuari = rows[0];
    if (usuari && await bcrypt.compare(password, usuari.password_hash)) {
      req.session.usuariId = usuari.id;
      req.session.username = usuari.username;
      return res.redirect('/');
    }
    req.flash('error', 'Usuario o contraseña incorrectos.');
    return res.redirect('/auth/login');
  }

  if (accion === 'registro') {
    if (user.length < 3) {
      req.flash('error', 'El usuario debe tener al menos 3 caracteres.');
      return res.redirect('/auth/login');
    }
    if ((password || '').length < 8) {
      req.flash('error', 'La contraseña debe tener al menos 8 caracteres.');
      return res.redirect('/auth/login');
    }
    try {
      const hash = await bcrypt.hash(password, 12);
      await pool.execute(
        'INSERT INTO usuaris (username, email, password_hash) VALUES (?, ?, ?)',
        [user, email || null, hash]
      );
      req.flash('success', '¡Cuenta creada! Ya puedes iniciar sesión.');
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY')
        req.flash('error', 'Ese nombre de usuario ya existe.');
      else
        req.flash('error', 'Error al crear la cuenta.');
    }
    return res.redirect('/auth/login');
  }

  res.redirect('/auth/login');
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

app.get('/', loginRequired, async (req, res) => {
  const uid = req.session.usuariId;

  const [historialRaw] = await pool.execute(`
    SELECT t.id, t.supermercado, t.total, t.fecha_compra,
           COUNT(p.id) AS num_productes
    FROM tiquets t
    LEFT JOIN productes p ON p.tiquet_id = t.id
    WHERE t.usuari_id = ?
    GROUP BY t.id
    ORDER BY t.fecha_compra DESC
  `, [uid]);

  const [[{ total }]] = await pool.execute(
    'SELECT COALESCE(SUM(total), 0) AS total FROM tiquets WHERE usuari_id = ?', [uid]
  );

  const [resumen] = await pool.execute(`
    SELECT supermercado,
           SUM(total)    AS total_gastado,
           COUNT(id)     AS num_tiquets
    FROM tiquets WHERE usuari_id = ?
    GROUP BY supermercado
    ORDER BY total_gastado DESC
  `, [uid]);

  const historial = historialRaw.map(t => ({
    ...t,
    total:        fmt(t.total),
    fecha_compra: fmtDate(t.fecha_compra),
  }));

  const resumeN = resumen.map(r => ({
    ...r,
    total_gastado: parseFloat(r.total_gastado || 0),
    total_fmt:     fmt(r.total_gastado),
  }));

  res.render('dashboard', {
    usuario:  req.session.username,
    total:    fmt(total),
    historial,
    resumen:  resumeN,
  });
});

// ── SUBIR TIQUET ──────────────────────────────────────────────────────────────

app.post('/subir', loginRequired, upload.single('foto_tiquet'), async (req, res) => {
  if (!req.file) {
    req.flash('error', 'Selecciona una foto antes de subir.');
    return res.redirect('/');
  }

  try {
    const form = new FormData();
    form.append('imatge', req.file.buffer, {
      filename:    req.file.originalname,
      contentType: req.file.mimetype,
    });

    const resp = await fetch(OCR_URL, { method: 'POST', body: form, timeout: 60000 });
    if (!resp.ok) throw new Error(`OCR HTTP ${resp.status}`);
    const dades = await resp.json();

    req.session.tiquetPendent = dades;
    return res.redirect('/preview');

  } catch (e) {
    console.error('Error OCR:', e.message);
    req.flash('error', 'Error al procesar la imagen. Inténtalo de nuevo.');
    return res.redirect('/');
  }
});

// ── PREVIEW ───────────────────────────────────────────────────────────────────

app.get('/preview', loginRequired, (req, res) => {
  const dades = req.session.tiquetPendent;
  if (!dades) return res.redirect('/');

  const productos = dades.productos || [];
  const noDescuento = productos.filter(p => !p.es_descuento);

  res.render('tiquet_preview', {
    usuario:      req.session.username,
    supermercado: dades.supermercado || 'Desconocido',
    productos,
    noDescuentoCount: noDescuento.length,
    total:        dades.total || '0.00',
    fmt,
  });
});

app.post('/confirmar', loginRequired, async (req, res) => {
  const dades = req.session.tiquetPendent;
  if (!dades) return res.redirect('/');
  delete req.session.tiquetPendent;

  const uid  = req.session.usuariId;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO tiquets (usuari_id, supermercado, total) VALUES (?, ?, ?)',
      [uid, dades.supermercado, dades.total || 0]
    );
    const tiquetId = result.insertId;
    for (const p of (dades.productos || [])) {
      await conn.execute(`
        INSERT INTO productes
          (tiquet_id, usuari_id, producto, categoria, cantidad,
           precio, es_descuento, supermercado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        tiquetId, uid,
        p.producto, p.categoria,
        p.cantidad || 1, p.precio || 0,
        p.es_descuento ? 1 : 0,
        dades.supermercado,
      ]);
    }
    await conn.commit();
    req.flash('success', '¡Tiquet guardado correctamente! 🎉');
  } catch (e) {
    await conn.rollback();
    console.error('Error guardant tiquet:', e.message);
    req.flash('error', 'Error al guardar el tiquet.');
  } finally {
    conn.release();
  }
  res.redirect('/');
});

app.post('/rechazar', loginRequired, (req, res) => {
  delete req.session.tiquetPendent;
  req.flash('warning', 'Tiquet descartado. Puedes subir uno nuevo.');
  res.redirect('/');
});

// ── DETALL TIQUET ─────────────────────────────────────────────────────────────

app.get('/tiquet/:id', loginRequired, async (req, res) => {
  const uid = req.session.usuariId;
  const id  = parseInt(req.params.id, 10);

  const [[tiquet]] = await pool.execute(
    'SELECT * FROM tiquets WHERE id = ? AND usuari_id = ?', [id, uid]
  );
  if (!tiquet) {
    req.flash('error', 'Tiquet no encontrado.');
    return res.redirect('/');
  }

  const [productos] = await pool.execute(
    'SELECT * FROM productes WHERE tiquet_id = ? ORDER BY id', [id]
  );

  res.render('tiquet_detalle', {
    usuario:  req.session.username,
    tiquet: {
      ...tiquet,
      total:        fmt(tiquet.total),
      fecha_compra: fmtDate(tiquet.fecha_compra),
    },
    productos,
    fmt,
  });
});

// ── TOTS ELS PRODUCTES ────────────────────────────────────────────────────────

app.get('/productos', loginRequired, async (req, res) => {
  const uid = req.session.usuariId;
  const [productos] = await pool.execute(`
    SELECT p.*, t.fecha_compra AS fecha_registro
    FROM productes p
    JOIN tiquets t ON t.id = p.tiquet_id
    WHERE p.usuari_id = ?
    ORDER BY t.fecha_compra DESC
  `, [uid]);

  const productosFmt = productos.map(p => ({
    ...p,
    fecha_registro: fmtDateShort(p.fecha_registro),
    precio:         parseFloat(p.precio || 0),
    cantidad:       parseFloat(p.cantidad || 1),
  }));

  res.render('todos_productos', {
    usuario:  req.session.username,
    productos: productosFmt,
    fmt,
  });
});

// ── Inici ─────────────────────────────────────────────────────────────────────

crearTaules()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Esítiron escoltant al port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('No s\'ha pogut connectar a la BD:', err.message);
    process.exit(1);
  });
