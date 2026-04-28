-- ============================================================
--  ESITIRON — Migracion: Borradores OPF
-- ============================================================

USE tiquets_db;

CREATE TABLE IF NOT EXISTS opf_drafts (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_usuario    INT UNSIGNED NOT NULL,
  ean           VARCHAR(50)  NOT NULL,
  nombre        VARCHAR(200) NOT NULL,
  marca         VARCHAR(100) NOT NULL,
  foto_path     VARCHAR(255) DEFAULT NULL,
  estado        ENUM('draft','sent','failed') NOT NULL DEFAULT 'draft',
  opf_response  TEXT         DEFAULT NULL,
  error_msg     VARCHAR(500) DEFAULT NULL,
  creado_en     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_opf_usuario (id_usuario),
  INDEX idx_opf_ean (ean),
  FOREIGN KEY (id_usuario) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB;

SELECT 'Migracion OPF completada' AS resultado;
