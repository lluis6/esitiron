-- ============================================================
--  ESÍTIRON — Migración: Curación y Vinculación de Productos
--  Versión corregida para MySQL 8.0
-- ============================================================

USE tiquets_db;

-- 1. Añadir columna 'pais' a la tabla tiquets
-- Si la columna ya existe, MySQL dará error. Si es la primera vez, funcionará.
ALTER TABLE tiquets
  ADD COLUMN pais VARCHAR(80) NOT NULL DEFAULT 'España'
  AFTER supermercado;

-- 2. Índice para filtros por país
CREATE INDEX idx_tiquet_pais
  ON tiquets (id_usuario, pais);

-- 3. Índice en compras.nombre_original para búsqueda rápida
CREATE INDEX idx_compra_nombre_orig
  ON compras (nombre_original(80));

-- 4. Índice compuesto en productos_maestros para búsqueda eficiente
CREATE INDEX idx_maestro_busqueda
  ON productos_maestros (nombre(100), marca(60));

-- 5. Columna 'curado' en compras
ALTER TABLE compras
  ADD COLUMN curado TINYINT(1) NOT NULL DEFAULT 0
  AFTER es_descuento;

-- 6. Vista auxiliar para la curación
CREATE OR REPLACE VIEW vista_curacion AS
  SELECT
    c.id                  AS id_compra,
    c.id_tiquet,
    c.id_usuario,
    c.nombre_original,
    c.curado,
    pm.id                 AS id_producto_maestro,
    pm.nombre             AS nombre_maestro,
    pm.marca,
    pm.categoria,
    t.supermercado        AS tienda,
    t.pais,
    c.precio_unitario     AS precio,
    c.cantidad,
    t.fecha_compra
  FROM compras c
  JOIN tiquets t             ON t.id  = c.id_tiquet
  JOIN productos_maestros pm ON pm.id = c.id_producto
  WHERE c.es_descuento = 0;

-- 7. Actualizar filas existentes
UPDATE compras c
JOIN productos_maestros pm ON pm.id = c.id_producto
SET c.curado = 1
WHERE c.es_descuento = 0
  AND UPPER(TRIM(c.nombre_original)) = UPPER(TRIM(pm.nombre));

-- 8. Mensaje Final
SELECT 'Migración completada exitosamente' AS resultado;
