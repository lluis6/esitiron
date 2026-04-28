-- ============================================================
--  ESÍTIRON - DATABASE SCHEMA COMPLETO
--  Enfoque: Seguridad + Catálogo Global + Historial de Precios
--           + 2FA + Sistema de Vinculación Inteligente
--           + Anti-Scraping (UUIDs) + Curación Colaborativa
-- ============================================================

CREATE DATABASE IF NOT EXISTS tiquets_db
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE tiquets_db;

-- ─────────────────────────────────────────────────────────────
-- 1. Usuarios
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    username        VARCHAR(60)     NOT NULL UNIQUE,
    password_hash   VARCHAR(255)    NOT NULL,
    email           VARCHAR(120)    NOT NULL UNIQUE,
    avatar          VARCHAR(255)    DEFAULT NULL,
    totp_secret     VARCHAR(255)    DEFAULT NULL,
    totp_enabled    TINYINT(1)      NOT NULL DEFAULT 0,
    fecha_registro  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activo          TINYINT(1)      NOT NULL DEFAULT 1,
    is_admin        TINYINT(1)      NOT NULL DEFAULT 0,
    PRIMARY KEY (id)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
-- 2. Catálogo Maestro de Productos
--    Global para todos los usuarios.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS productos_maestros (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    nombre          VARCHAR(200)    NOT NULL,
    marca           VARCHAR(100)    DEFAULT 'Genérica',
    categoria       VARCHAR(60)     DEFAULT 'Otros',
    foto_url        VARCHAR(500)    DEFAULT NULL,
    codigo_barras   VARCHAR(50)     UNIQUE DEFAULT NULL,
    PRIMARY KEY (id),
    INDEX idx_prod_nombre (nombre)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
-- 3. Tiquets (cabecera de la compra)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tiquets (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    uuid            VARCHAR(36)     UNIQUE DEFAULT NULL,
    id_usuario      INT UNSIGNED    NOT NULL,
    supermercado    VARCHAR(100)    NOT NULL,
    fecha_compra    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    total_tiquet    DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
    metodo_pago     VARCHAR(30)     DEFAULT NULL,
    ruta_imagen     VARCHAR(255)    DEFAULT NULL,
    pais            VARCHAR(60)     DEFAULT 'España',
    PRIMARY KEY (id),
    FOREIGN KEY (id_usuario) REFERENCES usuarios(id) ON DELETE CASCADE,
    INDEX idx_tiquet_usuario (id_usuario),
    INDEX idx_tiquet_fecha   (fecha_compra)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
-- 4. Compras (detalle de cada tiquet, relación 1:N)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compras (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    id_tiquet       INT UNSIGNED    NOT NULL,
    id_usuario      INT UNSIGNED    NOT NULL,
    id_producto     INT UNSIGNED    DEFAULT NULL,
    nombre_original VARCHAR(500)    DEFAULT NULL,
    descripcion     VARCHAR(200)    DEFAULT NULL,
    cantidad        DECIMAL(8,3)    NOT NULL DEFAULT 1.000,
    precio_unitario DECIMAL(10,2)   NOT NULL,
    es_descuento    TINYINT(1)      NOT NULL DEFAULT 0,
    curado          TINYINT(1)      NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    FOREIGN KEY (id_tiquet)   REFERENCES tiquets(id)            ON DELETE CASCADE,
    FOREIGN KEY (id_usuario)  REFERENCES usuarios(id)           ON DELETE CASCADE,
    FOREIGN KEY (id_producto) REFERENCES productos_maestros(id) ON DELETE SET NULL,
    INDEX idx_compra_usuario        (id_usuario),
    INDEX idx_compra_nombre_original(nombre_original(191))
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
-- 5. Historial de Precios 
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS historial_precios (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    id_producto     INT UNSIGNED    NOT NULL,
    supermercado    VARCHAR(100)    NOT NULL,
    precio          DECIMAL(10,2)   NOT NULL,
    fecha_registro  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (id_producto) REFERENCES productos_maestros(id) ON DELETE CASCADE,
    INDEX idx_historial_consulta (id_producto, supermercado, fecha_registro)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
-- 6. Auditoría de Seguridad y 7. 2FA Backup
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS login_attempts (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    id_usuario      INT UNSIGNED    NOT NULL,
    ip_address      VARCHAR(45)     NOT NULL,
    intento_fecha   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (id_usuario) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS codigos_recuperacion (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    id_usuario      INT UNSIGNED    NOT NULL,
    codigo_hash     VARCHAR(255)    NOT NULL,
    usado           TINYINT(1)      NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    FOREIGN KEY (id_usuario) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
-- 8. DICCIONARIO DE PRODUCTOS (Sistema Inteligente de Redirección)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS diccionario_productos (
    id                  INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    nombre_en_tiquet    VARCHAR(500)    NOT NULL,
    id_producto_maestro INT UNSIGNED    NOT NULL,
    usos                INT             NOT NULL DEFAULT 1,
    creado_en           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                        ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY  uk_nombre    (nombre_en_tiquet(191)),
    INDEX       idx_producto (id_producto_maestro),
    FOREIGN KEY (id_producto_maestro) REFERENCES productos_maestros(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
-- 9. Sistema de Verificación Colaborativa
-- ─────────────────────────────────────────────────────────────
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS votos_usuario (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    id_usuario      INT UNSIGNED    NOT NULL,
    id_verificacion INT UNSIGNED    NOT NULL,
    voto            ENUM('si','no') NOT NULL,
    votado_en       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_usuario_verif (id_usuario, id_verificacion),
    FOREIGN KEY (id_usuario) REFERENCES usuarios(id) ON DELETE CASCADE,
    FOREIGN KEY (id_verificacion) REFERENCES verificaciones_barcode(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
-- 10. Sistema de Grupos Colaborativos
-- ─────────────────────────────────────────────────────────────

-- Grupos
CREATE TABLE IF NOT EXISTS grupos (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    nombre          VARCHAR(100)    NOT NULL,
    descripcion     VARCHAR(255)    DEFAULT NULL,
    creador_id      INT UNSIGNED    NOT NULL,
    creado_en       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (creador_id) REFERENCES usuarios(id) ON DELETE CASCADE,
    INDEX idx_grupos_creador (creador_id)
) ENGINE=InnoDB;

-- Miembros de grupo
CREATE TABLE IF NOT EXISTS miembros_grupo (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    grupo_id        INT UNSIGNED    NOT NULL,
    usuario_id      INT UNSIGNED    NOT NULL,
    rol             ENUM('admin','miembro') NOT NULL DEFAULT 'miembro',
    unido_en        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_grupo_usuario (grupo_id, usuario_id),
    FOREIGN KEY (grupo_id)   REFERENCES grupos(id)   ON DELETE CASCADE,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
    INDEX idx_miembros_usuario (usuario_id)
) ENGINE=InnoDB;

-- Invitaciones internas (sin email)
CREATE TABLE IF NOT EXISTS invitaciones (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    grupo_id        INT UNSIGNED    NOT NULL,
    invitador_id    INT UNSIGNED    NOT NULL,
    invitado_id     INT UNSIGNED    NOT NULL,
    estado          ENUM('pendiente','aceptada','rechazada') NOT NULL DEFAULT 'pendiente',
    creado_en       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    respondido_en   DATETIME        DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_invitacion (grupo_id, invitado_id),
    FOREIGN KEY (grupo_id)     REFERENCES grupos(id)   ON DELETE CASCADE,
    FOREIGN KEY (invitador_id) REFERENCES usuarios(id) ON DELETE CASCADE,
    FOREIGN KEY (invitado_id)  REFERENCES usuarios(id) ON DELETE CASCADE,
    INDEX idx_inv_invitado (invitado_id, estado)
) ENGINE=InnoDB;

-- Relación tiquets ↔ grupos (muchos a muchos)
CREATE TABLE IF NOT EXISTS tiquets_grupos (
    tiquet_id       INT UNSIGNED    NOT NULL,
    grupo_id        INT UNSIGNED    NOT NULL,
    compartido_en   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tiquet_id, grupo_id),
    FOREIGN KEY (tiquet_id) REFERENCES tiquets(id) ON DELETE CASCADE,
    FOREIGN KEY (grupo_id)  REFERENCES grupos(id)  ON DELETE CASCADE,
    INDEX idx_tg_grupo (grupo_id)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
-- VISTAS
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW vista_resumen_tiquets AS
    SELECT u.id AS usuario_id, u.username AS nombre_usuario, t.id AS tiquet_id, t.uuid,
           t.supermercado, t.fecha_compra, t.total_tiquet, t.metodo_pago, t.ruta_imagen,
           (SELECT COUNT(*) FROM compras c WHERE c.id_tiquet = t.id) AS total_articulos
    FROM tiquets t JOIN usuarios u ON t.id_usuario = u.id ORDER BY t.fecha_compra DESC;

CREATE OR REPLACE VIEW vista_compras_detalladas AS
    SELECT u.username, t.id AS tiquet_no, t.uuid AS tiquet_uuid, t.supermercado,
           pm.nombre AS producto, pm.marca, c.cantidad, c.precio_unitario,
           (c.cantidad * c.precio_unitario) AS subtotal, c.curado, c.nombre_original
    FROM compras c JOIN usuarios u ON c.id_usuario = u.id
    JOIN tiquets t ON c.id_tiquet = t.id JOIN productos_maestros pm ON c.id_producto = pm.id;

CREATE OR REPLACE VIEW vista_comparativa_precios AS
    SELECT pm.nombre AS producto, pm.marca, hp.supermercado, hp.precio AS precio_actual,
           (hp.precio - (SELECT AVG(precio) FROM historial_precios WHERE id_producto = pm.id)) AS diferencia_vs_promedio,
           hp.fecha_registro AS ultima_actualizacion
    FROM productos_maestros pm JOIN historial_precios hp ON pm.id = hp.id_producto
    WHERE hp.fecha_registro = (SELECT MAX(fecha_registro) FROM historial_precios WHERE id_producto = pm.id AND supermercado = hp.supermercado);

CREATE OR REPLACE VIEW vista_gastos_mensuales AS
    SELECT id_usuario, DATE_FORMAT(fecha_compra, '%Y-%m') AS mes, supermercado, SUM(total_tiquet) AS total_gastado, COUNT(id) AS numero_tiquets
    FROM tiquets GROUP BY id_usuario, mes, supermercado ORDER BY mes DESC;

CREATE OR REPLACE VIEW vista_diccionario_frecuente AS
    SELECT dp.nombre_en_tiquet, pm.nombre AS producto_maestro, pm.marca, pm.categoria, dp.usos, dp.actualizado_en
    FROM diccionario_productos dp JOIN productos_maestros pm ON pm.id = dp.id_producto_maestro
    ORDER BY dp.usos DESC;

CREATE OR REPLACE VIEW vista_verificaciones AS
    SELECT vb.id, pm.nombre AS producto, pm.marca, vb.codigo_barras, vb.votos_si, vb.votos_no,
           (vb.votos_si + vb.votos_no) AS total_votos,
           CASE WHEN (vb.votos_si + vb.votos_no) = 0 THEN 0 ELSE ROUND(vb.votos_si * 100.0 / (vb.votos_si + vb.votos_no), 1) END AS porcentaje_si,
           vb.estado, vb.creado_en
    FROM verificaciones_barcode vb JOIN productos_maestros pm ON pm.id = vb.id_producto;
