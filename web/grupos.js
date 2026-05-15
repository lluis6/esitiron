'use strict';

/**
 * grupos.js — Rutas del Sistema de Grupos Colaborativos
 * Importar en app.js: const gruposRouter = require('./grupos'); app.use('/', gruposRouter);
 */

const express = require('express');
const path = require('path');
const router  = express.Router();

const asyncWrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── AUTH middleware (reutiliza el del app.js principal) ───────
const auth = (req, res, next) => {
  if (!req.session.usuario) return res.status(401).json({ error: 'No autenticado' });
  next();
};

// Se inyecta el pool desde app.js al llamar a initGruposRoutes(pool)
let db;
function initGruposRoutes(pool) {
  db = pool;
  return router;
}

// ════════════════════════════════════════════════════════════
// GRUPOS — CRUD
// ════════════════════════════════════════════════════════════

/**
 * POST /api/grupos
 * Crear un nuevo grupo. El creador se añade automáticamente como admin.
 */
router.post('/api/grupos', auth, async (req, res) => {
  const { nombre, descripcion } = req.body;
  const uid = req.session.usuario.id;

  if (!nombre || nombre.trim().length < 2) {
    return res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [r] = await conn.execute(
      'INSERT INTO grupos (nombre, descripcion, creador_id) VALUES (?,?,?)',
      [nombre.trim(), (descripcion || '').trim() || null, uid]
    );
    const grupoId = r.insertId;

    // El creador entra automáticamente como admin
    await conn.execute(
      'INSERT INTO miembros_grupo (grupo_id, usuario_id, rol) VALUES (?,?,?)',
      [grupoId, uid, 'admin']
    );

    await conn.commit();
    res.json({ success: true, id: grupoId, nombre: nombre.trim() });
  } catch (e) {
    await conn.rollback();
    console.error('[Grupos] crear:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/**
 * GET /api/grupos
 * Listar todos los grupos del usuario autenticado (como miembro o admin).
 */
router.get('/api/grupos', auth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB no inicializada' });

  const uid = req.session.usuario.id;
  const [rows] = await db.execute(`
    SELECT g.id, g.nombre, g.descripcion, g.creado_en, mg.rol,
           (SELECT COUNT(*) FROM miembros_grupo WHERE grupo_id = g.id) AS total_miembros,
           (SELECT COUNT(*) FROM tiquets_grupos WHERE grupo_id = g.id) AS total_tiquets
    FROM grupos g
    JOIN miembros_grupo mg ON mg.grupo_id = g.id AND mg.usuario_id = ?
    ORDER BY g.creado_en DESC
  `, [uid]);
  res.json(rows);
});

/**
 * GET /api/grupos/:id
 * Detalle de un grupo: info + miembros. Solo accesible para miembros.
 */
router.get('/api/grupos/:id', auth, async (req, res) => {
  const uid     = req.session.usuario.id;
  const grupoId = parseInt(req.params.id, 10);

  try {
    // Verificar membresía
    const [[miembro]] = await db.execute(
      'SELECT rol FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, uid]
    );
    if (!miembro) return res.status(403).json({ error: 'No eres miembro de este grupo' });

    const [[grupo]] = await db.execute(
      'SELECT g.*, u.username AS creador FROM grupos g JOIN usuarios u ON u.id = g.creador_id WHERE g.id = ?',
      [grupoId]
    );
    if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado' });

    const [miembros] = await db.execute(`
      SELECT u.id, u.username, u.avatar, mg.rol, mg.unido_en
      FROM miembros_grupo mg
      JOIN usuarios u ON u.id = mg.usuario_id
      WHERE mg.grupo_id = ?
      ORDER BY mg.rol DESC, mg.unido_en ASC
    `, [grupoId]);

    res.json({ ...grupo, miRol: miembro.rol, miembros });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * LÓGICA DE SUCESIÓN Y SALIDA
 * Se encarga de que el grupo no se quede huérfano si el admin se va.
 */
async function procesarSalidaGrupo(grupoId, targetUid, usuarioEjecutorId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Obtener el rol del usuario que quiere salir/ser expulsado
    const [[miembro]] = await conn.execute(
      'SELECT rol FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, targetUid]
    );
    if (!miembro) throw new Error('El usuario no es miembro de este grupo');

    // 2. Si el usuario que se va es ADMIN, buscar un sucesor
    if (miembro.rol === 'admin') {
      const [posiblesSucesores] = await conn.execute(
        'SELECT usuario_id FROM miembros_grupo WHERE grupo_id = ? AND usuario_id != ? ORDER BY unido_en ASC LIMIT 1',
        [grupoId, targetUid]
      );

      if (posiblesSucesores.length > 0) {
        // Asignar el rol de admin al miembro más antiguo
        const nuevoAdminId = posiblesSucesores[0].usuario_id;
        await conn.execute(
          "UPDATE miembros_grupo SET rol = 'admin' WHERE grupo_id = ? AND usuario_id = ?",
          [grupoId, nuevoAdminId]
        );
        // Opcional: Actualizar también el creador_id en la tabla grupos para evitar borrados en cascada
        await conn.execute(
          "UPDATE grupos SET creador_id = ? WHERE id = ?",
          [nuevoAdminId, grupoId]
        );
        console.log(`[Grupos] Sucesor nombrado: ${nuevoAdminId} en grupo ${grupoId}`);
      } else {
        // No queda nadie más, el grupo se puede quedar vacío o borrarse
        // Dependiendo de tu DB, esto podría disparar el borrado del grupo
        console.log(`[Grupos] Grupo ${grupoId} se ha quedado sin miembros.`);
      }
    }

    // 3. Eliminar al miembro
    await conn.execute(
      'DELETE FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, targetUid]
    );

    await conn.commit();
    return { success: true };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// NUEVA ruta — Salir del grupo (uno mismo)
router.delete('/api/grupos/:id/miembros/me', auth, async (req, res) => {
  const uid = req.session.usuario.id;
  const grupoId = parseInt(req.params.id, 10);
  try {
    const result = await procesarSalidaGrupo(grupoId, uid, uid);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Expulsar a un miembro (solo admins pueden expulsar a otros)
router.delete('/api/grupos/:id/miembros/:targetUid', auth, async (req, res) => {
  const uid = req.session.usuario.id;
  const grupoId = parseInt(req.params.id, 10);
  const targetUid = parseInt(req.params.targetUid, 10);

  try {
    // Verificar si el ejecutor es admin (solo si no se está echando a sí mismo)
    if (uid !== targetUid) {
      const [[ejecutor]] = await db.execute(
        'SELECT rol FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
        [grupoId, uid]
      );
      if (!ejecutor || ejecutor.rol !== 'admin') {
        return res.status(403).json({ error: 'Solo un admin puede expulsar miembros' });
      }
    }

    const result = await procesarSalidaGrupo(grupoId, targetUid, uid);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// INVITACIONES
// ════════════════════════════════════════════════════════════

/**
 * GET /api/usuarios/buscar?q=username
 * Buscar usuarios por username para invitar (excluye al propio usuario).
 */
router.get('/api/usuarios/buscar', auth, async (req, res) => {
  const uid = req.session.usuario.id;
  const q   = `%${(req.query.q || '').trim()}%`;
  if (!req.query.q || req.query.q.trim().length < 2) return res.json([]);

  try {
    const [rows] = await db.execute(
      'SELECT id, username, avatar FROM usuarios WHERE username LIKE ? AND id != ? AND activo = 1 LIMIT 8',
      [q, uid]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json([]);
  }
});

/**
 * POST /api/grupos/:id/invitar
 * Invitar a un usuario por su ID. Requiere ser miembro del grupo.
 */
router.post('/api/grupos/:id/invitar', auth, async (req, res) => {
  const uid       = req.session.usuario.id;
  const grupoId   = parseInt(req.params.id, 10);
  const invitadoId = parseInt(req.body.usuario_id, 10);

  if (!invitadoId || invitadoId === uid) {
    return res.status(400).json({ error: 'ID de usuario inválido' });
  }

  try {
    // Verificar que quien invita es miembro
    const [[miembro]] = await db.execute(
      'SELECT rol FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, uid]
    );
    if (!miembro) return res.status(403).json({ error: 'No eres miembro de este grupo' });

    // Verificar que el invitado no sea ya miembro
    const [[yaEsMiembro]] = await db.execute(
      'SELECT id FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, invitadoId]
    );
    if (yaEsMiembro) return res.status(409).json({ error: 'El usuario ya es miembro del grupo' });

    // Crear invitación (ON DUPLICATE ignora si ya existe una pendiente)
    await db.execute(
      `INSERT INTO invitaciones (grupo_id, invitador_id, invitado_id, estado)
       VALUES (?,?,?,'pendiente')
       ON DUPLICATE KEY UPDATE estado = 'pendiente', creado_en = NOW(), respondido_en = NULL`,
      [grupoId, uid, invitadoId]
    );

    res.json({ success: true, message: 'Invitación enviada' });
  } catch (e) {
    console.error('[Invitar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/grupos/invitaciones
 * Listar invitaciones pendientes del usuario logueado.
 */
router.get('/api/grupos/invitaciones', auth, async (req, res) => {
  const uid = req.session.usuario.id;
  try {
    const [rows] = await db.execute(`
      SELECT i.id, i.estado, i.creado_en,
             g.id AS grupo_id, g.nombre AS grupo_nombre,
             u.username AS invitador, u.avatar AS invitador_avatar,
             (SELECT COUNT(*) FROM miembros_grupo WHERE grupo_id = g.id) AS total_miembros
      FROM invitaciones i
      JOIN grupos g ON g.id = i.grupo_id
      JOIN usuarios u ON u.id = i.invitador_id
      WHERE i.invitado_id = ? AND i.estado = 'pendiente'
      ORDER BY i.creado_en DESC
    `, [uid]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/invitaciones/:id/responder
 * Aceptar o rechazar una invitación. body: { accion: 'aceptar'|'rechazar' }
 */
router.post('/api/invitaciones/:id/responder', auth, async (req, res) => {
  const uid  = req.session.usuario.id;
  const invId = parseInt(req.params.id, 10);
  const { accion } = req.body;

  if (!['aceptar', 'rechazar'].includes(accion)) {
    return res.status(400).json({ error: 'Acción inválida' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[inv]] = await conn.execute(
      "SELECT * FROM invitaciones WHERE id = ? AND invitado_id = ? AND estado = 'pendiente'",
      [invId, uid]
    );
    if (!inv) {
      await conn.rollback();
      return res.status(404).json({ error: 'Invitación no encontrada o ya respondida' });
    }

    const nuevoEstado = accion === 'aceptar' ? 'aceptada' : 'rechazada';
    await conn.execute(
      'UPDATE invitaciones SET estado = ?, respondido_en = NOW() WHERE id = ?',
      [nuevoEstado, invId]
    );

    if (accion === 'aceptar') {
      // Añadir como miembro (ignorar si ya existe por alguna race condition)
      await conn.execute(
        "INSERT IGNORE INTO miembros_grupo (grupo_id, usuario_id, rol) VALUES (?,?,'miembro')",
        [inv.grupo_id, uid]
      );
    }

    await conn.commit();
    res.json({ success: true, estado: nuevoEstado });
  } catch (e) {
    await conn.rollback();
    console.error('[Responder inv]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ════════════════════════════════════════════════════════════
// TIQUETS EN GRUPOS
// ════════════════════════════════════════════════════════════

/**
 * POST /api/tiquets/:id/asignar-grupos
 * Sincroniza en qué grupos aparece un tiquet. Solo el dueño puede hacerlo.
 * body: { grupo_ids: [1, 3, 5] }
 */
router.post('/api/tiquets/:id/asignar-grupos', auth, async (req, res) => {
  const uid     = req.session.usuario.id;
  const tiquetId = parseInt(req.params.id, 10);
  const grupoIds = Array.isArray(req.body.grupo_ids) ? req.body.grupo_ids.map(Number) : [];

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Verificar propiedad del tiquet
    const [[tiquet]] = await conn.execute(
      'SELECT id FROM tiquets WHERE id = ? AND id_usuario = ?',
      [tiquetId, uid]
    );
    if (!tiquet) {
      await conn.rollback();
      return res.status(403).json({ error: 'Tiquet no encontrado o no te pertenece' });
    }

    // Verificar que el usuario es miembro de todos los grupos enviados
    let gruposValidos = [];
    if (grupoIds.length > 0) {
      const ph = grupoIds.map(() => '?').join(',');
      const [miembroDe] = await conn.execute(
        `SELECT grupo_id FROM miembros_grupo WHERE usuario_id = ? AND grupo_id IN (${ph})`,
        [uid, ...grupoIds]
      );
      gruposValidos = miembroDe.map(r => r.grupo_id);
    }

    // Sincronizar: borrar todos los del tiquet y reinsertar los válidos
    await conn.execute('DELETE FROM tiquets_grupos WHERE tiquet_id = ?', [tiquetId]);

    if (gruposValidos.length > 0) {
      const vals = gruposValidos.map(gid => [tiquetId, gid]);
      await conn.query(
        'INSERT INTO tiquets_grupos (tiquet_id, grupo_id) VALUES ?',
        [vals]
      );
    }

    await conn.commit();
    res.json({ success: true, grupos_asignados: gruposValidos.length });
  } catch (e) {
    await conn.rollback();
    console.error('[AsignarGrupos]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/**
 * GET /api/tiquets/:id/grupos
 * Qué grupos tiene asignados un tiquet (para rellenar checkboxes del modal).
 */
router.get('/api/tiquets/:id/grupos', auth, async (req, res) => {
  const uid      = req.session.usuario.id;
  const tiquetId = parseInt(req.params.id, 10);

  try {
    // Verificar propiedad
    const [[t]] = await db.execute(
      'SELECT id FROM tiquets WHERE id = ? AND id_usuario = ?',
      [tiquetId, uid]
    );
    if (!t) return res.status(403).json({ error: 'No autorizado' });

    const [rows] = await db.execute(
      'SELECT grupo_id FROM tiquets_grupos WHERE tiquet_id = ?',
      [tiquetId]
    );
    res.json(rows.map(r => r.grupo_id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/tiquets/:id/grupos/:grupoId
 * Quitar un tiquet de un grupo sin borrar el tiquet.
 */
router.delete('/api/tiquets/:id/grupos/:grupoId', auth, async (req, res) => {
  const uid = req.session.usuario.id;
  const tiquetId = parseInt(req.params.id, 10);
  const grupoId = parseInt(req.params.grupoId, 10);

  if (!Number.isFinite(tiquetId) || !Number.isFinite(grupoId)) {
    return res.status(400).json({ error: 'Parametros invalidos' });
  }

  try {
    const [[t]] = await db.execute(
      'SELECT id FROM tiquets WHERE id = ? AND id_usuario = ?',
      [tiquetId, uid]
    );
    if (!t) return res.status(403).json({ error: 'No autorizado' });

    const [[miembro]] = await db.execute(
      'SELECT id FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, uid]
    );
    if (!miembro) return res.status(403).json({ error: 'No eres miembro de este grupo' });

    const [result] = await db.execute(
      'DELETE FROM tiquets_grupos WHERE tiquet_id = ? AND grupo_id = ?',
      [tiquetId, grupoId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Tiquet no encontrado en este grupo' });
    }

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/grupos/:id/tiquets
 * Listar todos los tiquets compartidos en un grupo. Solo miembros.
 */
router.get('/api/grupos/:id/tiquets', auth, async (req, res) => {
  const uid     = req.session.usuario.id;
  const grupoId = parseInt(req.params.id, 10);

  try {
    const [[miembro]] = await db.execute(
      'SELECT id FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, uid]
    );
    if (!miembro) return res.status(403).json({ error: 'No eres miembro de este grupo' });

    const [tiquets] = await db.execute(`
      SELECT t.id, t.uuid, t.id_usuario AS propietario_id, t.supermercado, t.fecha_compra, t.total_tiquet,
             u.username AS propietario, u.avatar AS propietario_avatar,
             (SELECT COUNT(*) FROM compras c WHERE c.id_tiquet = t.id AND c.es_descuento = 0) AS total_articulos,
             tg.compartido_en
      FROM tiquets_grupos tg
      JOIN tiquets t ON t.id = tg.tiquet_id
      JOIN usuarios u ON u.id = t.id_usuario
      WHERE tg.grupo_id = ?
      ORDER BY tg.compartido_en DESC
    `, [grupoId]);

    res.json(tiquets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/grupos/:id/tiquets/:uuid
 * Eliminar un tiquet compartido del grupo.
 * - Admin del grupo: puede eliminar cualquier tiquet del grupo.
 * - Miembro normal: solo puede eliminar sus propios tiquets.
 */
router.delete('/api/grupos/:id/tiquets/:uuid', auth, async (req, res) => {
  const uid = req.session.usuario.id;
  const grupoId = parseInt(req.params.id, 10);
  const tiquetUuid = String(req.params.uuid || '').trim();

  if (!Number.isFinite(grupoId) || !tiquetUuid) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[miembro]] = await conn.execute(
      'SELECT rol FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, uid]
    );
    if (!miembro) {
      await conn.rollback();
      return res.status(403).json({ error: 'No eres miembro de este grupo' });
    }

    const [[tiquet]] = await conn.execute(`
      SELECT t.id, t.id_usuario
      FROM tiquets_grupos tg
      JOIN tiquets t ON t.id = tg.tiquet_id
      WHERE tg.grupo_id = ? AND t.uuid = ?
      LIMIT 1
    `, [grupoId, tiquetUuid]);

    if (!tiquet) {
      await conn.rollback();
      return res.status(404).json({ error: 'Tiquet no encontrado en este grupo' });
    }

    const esAdmin = miembro.rol === 'admin';
    const esPropietario = Number(tiquet.id_usuario) === Number(uid);
    if (!esAdmin && !esPropietario) {
      await conn.rollback();
      return res.status(403).json({ error: 'Solo puedes eliminar tus propios tiquets' });
    }

    await conn.execute('DELETE FROM compras WHERE id_tiquet = ?', [tiquet.id]);
    await conn.execute('DELETE FROM tiquets_grupos WHERE tiquet_id = ?', [tiquet.id]);
    await conn.execute('DELETE FROM tiquets WHERE id = ?', [tiquet.id]);

    await conn.commit();
    return res.json({ success: true });
  } catch (e) {
    await conn.rollback();
    return res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ════════════════════════════════════════════════════════════
// PAGOS ENTRE MIEMBROS
// ════════════════════════════════════════════════════════════

/**
 * GET /api/grupos/:id/pagos
 * Listar pagos entre miembros del grupo.
 */
router.get('/api/grupos/:id/pagos', auth, async (req, res) => {
  const uid = req.session.usuario.id;
  const grupoId = parseInt(req.params.id, 10);

  if (!Number.isFinite(grupoId)) return res.status(400).json({ error: 'Grupo inválido' });

  try {
    const [[miembro]] = await db.execute(
      'SELECT id FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, uid]
    );
    if (!miembro) return res.status(403).json({ error: 'No eres miembro de este grupo' });

    const [pagos] = await db.execute(`
      SELECT p.id, p.grupo_id, p.from_user_id, p.to_user_id, p.cantidad, p.creado_en,
             uf.username AS from_user, ut.username AS to_user
      FROM grupos_pagos p
      JOIN usuarios uf ON uf.id = p.from_user_id
      JOIN usuarios ut ON ut.id = p.to_user_id
      WHERE p.grupo_id = ?
      ORDER BY p.creado_en DESC
    `, [grupoId]);

    res.json(pagos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/grupos/:id/pagos
 * Registrar pago: from_user -> to_user
 */
router.post('/api/grupos/:id/pagos', auth, async (req, res) => {
  const uid = req.session.usuario.id;
  const grupoId = parseInt(req.params.id, 10);
  const toUserId = parseInt(req.body.to_user_id, 10);
  const cantidad = Number(req.body.amount || req.body.cantidad || 0);

  if (!Number.isFinite(grupoId)) return res.status(400).json({ error: 'Grupo inválido' });
  if (!Number.isFinite(toUserId) || toUserId <= 0 || toUserId === uid) {
    return res.status(400).json({ error: 'Usuario destino inválido' });
  }
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    return res.status(400).json({ error: 'Cantidad inválida' });
  }

  try {
    const [[miembro]] = await db.execute(
      'SELECT id FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, uid]
    );
    if (!miembro) return res.status(403).json({ error: 'No eres miembro de este grupo' });

    const [[destino]] = await db.execute(
      'SELECT id FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, toUserId]
    );
    if (!destino) return res.status(404).json({ error: 'El usuario no esta en el grupo' });

    await db.execute(
      'INSERT INTO grupos_pagos (grupo_id, from_user_id, to_user_id, cantidad) VALUES (?,?,?,?)',
      [grupoId, uid, toUserId, cantidad]
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// NUEVA ruta — salir del grupo (cualquier miembro)
router.delete('/api/grupos/:id/miembros/me', auth, async (req, res) => {
  const uid     = req.session.usuario.id;
  const grupoId = parseInt(req.params.id, 10);

  try {
    const [[miembro]] = await db.execute(
      'SELECT rol FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, uid]
    );
    if (!miembro) return res.status(404).json({ error: 'No eres miembro de este grupo' });

    await db.execute(
      'DELETE FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, uid]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/grupos/:id', auth, async (req, res) => {
  const uid     = req.session.usuario.id;
  const grupoId = parseInt(req.params.id, 10);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Verificar que quien intenta borrar es el ADMIN
    const [[miembro]] = await conn.execute(
      "SELECT rol FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?",
      [grupoId, uid]
    );

    if (!miembro || miembro.rol !== 'admin') {
      await conn.rollback();
      return res.status(403).json({ error: 'Solo un admin puede eliminar el grupo' });
    }

    // 2. Limpiar dependencias en orden para evitar errores de Foreign Key
    
    // Borrar invitaciones enviadas desde este grupo
    await conn.execute('DELETE FROM invitaciones WHERE grupo_id = ?', [grupoId]);
    
    // Borrar el historial de pagos registrados en este grupo
    await conn.execute('DELETE FROM grupos_pagos WHERE grupo_id = ?', [grupoId]);
    
    // Quitar la vinculación de tiquets con este grupo (esto no borra el tiquet del dueño, solo lo quita del grupo)
    await conn.execute('DELETE FROM tiquets_grupos WHERE grupo_id = ?', [grupoId]);
    
    // Borrar a todos los miembros del grupo
    await conn.execute('DELETE FROM miembros_grupo WHERE grupo_id = ?', [grupoId]);

    // 3. Finalmente, borrar el registro del grupo
    await conn.execute('DELETE FROM grupos WHERE id = ?', [grupoId]);

    await conn.commit();
    res.json({ success: true });
  } catch (e) {
    await conn.rollback();
    console.error('[Grupos] Error fatal al eliminar:', e.message);
    res.status(500).json({ error: 'No se pudo eliminar el grupo porque tiene datos activos vinculados.' });
  } finally {
    conn.release();
  }
});

// ════════════════════════════════════════════════════════════
// PÁGINA DE GRUPOS (renderiza la vista)
// ════════════════════════════════════════════════════════════

/**
 * GET /grupos — Página principal de grupos
 */
router.get('/grupos', (req, res, next) => {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}, async (req, res) => {
  const uid = req.session.usuario.id;
  try {
    const [grupos] = await db.execute(`
      SELECT g.id, g.nombre, g.descripcion, g.creado_en, mg.rol,
             (SELECT COUNT(*) FROM miembros_grupo WHERE grupo_id = g.id) AS total_miembros,
             (SELECT COUNT(*) FROM tiquets_grupos WHERE grupo_id = g.id) AS total_tiquets
      FROM grupos g
      JOIN miembros_grupo mg ON mg.grupo_id = g.id AND mg.usuario_id = ?
      ORDER BY g.creado_en DESC
    `, [uid]);

    const [invitaciones] = await db.execute(`
      SELECT i.id, i.creado_en,
             g.id AS grupo_id, g.nombre AS grupo_nombre,
             u.username AS invitador
      FROM invitaciones i
      JOIN grupos g ON g.id = i.grupo_id
      JOIN usuarios u ON u.id = i.invitador_id
      WHERE i.invitado_id = ? AND i.estado = 'pendiente'
      ORDER BY i.creado_en DESC
    `, [uid]);

    const navLocals = {
      usuario: req.session.usuario?.username || '',
      usuario_email: req.session.usuario?.email || '',
      usuario_id: req.session.usuario?.id || 0,
      avatar_url: req.session.usuario?.avatar
        ? '/avatar/' + require('path').basename(req.session.usuario.avatar)
        : null,
    };

    const messages = [];
    if (req.query.success) messages.push(['success', decodeURIComponent(req.query.success)]);
    if (req.query.error)   messages.push(['danger',  decodeURIComponent(req.query.error)]);

    res.render('grupos.html', { ...navLocals, grupos, invitaciones, messages });
  } catch (e) {
    console.error('[Grupos page]', e.message);
    res.redirect('/dashboard?error=Error+cargando+grupos');
  }
});

/**
 * GET /grupos/:id/productos
 * Listar productos de los tiquets compartidos en un grupo. Solo miembros.
 */
router.get('/grupos/:id/productos', (req, res, next) => {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}, async (req, res) => {
  const uid = req.session.usuario.id;
  const grupoId = parseInt(req.params.id, 10);
  const { pais = '', supermercado = '' } = req.query;

  if (!Number.isFinite(grupoId)) return res.redirect('/grupos?error=Grupo+inválido');

  try {
    const [[grupo]] = await db.execute(`
      SELECT g.id, g.nombre
      FROM grupos g
      JOIN miembros_grupo mg ON mg.grupo_id = g.id
      WHERE g.id = ? AND mg.usuario_id = ?
      LIMIT 1
    `, [grupoId, uid]);

    if (!grupo) return res.redirect('/grupos?error=No+tienes+acceso+a+este+grupo');

    let query = `
      SELECT pm.nombre AS producto, pm.categoria, pm.marca, pm.foto_url,
             pm.id AS id_producto_maestro, pm.codigo_barras,
             t.supermercado AS tienda, COALESCE(t.pais, 'España') AS pais,
             c.cantidad, c.precio_unitario AS precio,
             c.id AS id_compra, c.nombre_original, c.curado,
             u.username AS propietario, t.fecha_compra
      FROM tiquets_grupos tg
      JOIN tiquets t ON t.id = tg.tiquet_id
      JOIN compras c ON c.id_tiquet = t.id AND c.es_descuento = 0
      JOIN productos_maestros pm ON pm.id = c.id_producto
      JOIN usuarios u ON u.id = t.id_usuario
      WHERE tg.grupo_id = ?`;
    const params = [grupoId];

    if (pais) { query += ' AND t.pais = ?'; params.push(pais); }
    if (supermercado) { query += ' AND t.supermercado = ?'; params.push(supermercado); }

    query += ' ORDER BY t.fecha_compra DESC';
    const [productos] = await db.execute(query, params);

    const [paises] = await db.execute(`
      SELECT DISTINCT t.pais
      FROM tiquets_grupos tg
      JOIN tiquets t ON t.id = tg.tiquet_id
      WHERE tg.grupo_id = ?
      ORDER BY t.pais
    `, [grupoId]).catch(() => [[]]);

    const [tiendas] = await db.execute(`
      SELECT DISTINCT t.supermercado
      FROM tiquets_grupos tg
      JOIN tiquets t ON t.id = tg.tiquet_id
      WHERE tg.grupo_id = ?
      ORDER BY t.supermercado
    `, [grupoId]);

    const messages = [];
    if (req.query.success) messages.push(['success', decodeURIComponent(req.query.success)]);
    if (req.query.error) messages.push(['danger', decodeURIComponent(req.query.error)]);

    res.render('todos_productos.html', {
      usuario: req.session.usuario?.username || '',
      usuario_email: req.session.usuario?.email || '',
      avatar_url: req.session.usuario?.avatar ? '/avatar/' + path.basename(req.session.usuario.avatar) : null,
      productos,
      paises: paises.map(r => r.pais).filter(Boolean),
      tiendas: tiendas.map(r => normalizarTienda(r.supermercado)),
      filtro_pais: pais,
      filtro_supermercado: supermercado,
      messages,
      es_grupo: true,
      grupo,
    });
  } catch (e) {
    console.error('[Grupo productos]', e.message);
    res.redirect('/grupos?error=Error+cargando+productos+del+grupo');
  }
});

const TIENDAS_MAP = {
  MERCADONA: 'Mercadona',
  CONSUM: 'Consum',
  LIDL: 'Lidl',
  ALDI: 'Aldi',
  CARREFOUR: 'Carrefour',
  ALCAMPO: 'Alcampo',
  DIA: 'Dia',
  CAPRABO: 'Caprabo',
  BONPREU: 'Bonpreu',
  EROSKI: 'Eroski',
  SPAR: 'Spar',
};

function normalizarTienda(nombre) {
  if (!nombre) return 'Desconocido';
  const up = String(nombre).toUpperCase();
  for (const [k, v] of Object.entries(TIENDAS_MAP)) {
    if (up.includes(k)) return v;
  }
  return String(nombre).toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).trim();
}

// ════════════════════════════════════════════════════════════
// COMPARTIR TIQUETS (compatibilidad frontend)
// ════════════════════════════════════════════════════════════

function normalizarPayloadCompartir(body = {}) {
  const tiquetUuid = body.tiquet_uuid || body.ticket_uuid || body.uuid_tiquet || null;
  const tiquetId = body.tiquet_id ? parseInt(body.tiquet_id, 10) : null;
  const grupoIdBody = body.grupo_id ? parseInt(body.grupo_id, 10) : null;
  return { tiquetUuid, tiquetId, grupoIdBody };
}

async function compartirTiquetEnGrupo({ uid, grupoId, tiquetUuid, tiquetId }) {
  if (!db) return { status: 503, body: { error: 'DB no inicializada' } };

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[miembro]] = await conn.execute(
      'SELECT rol FROM miembros_grupo WHERE grupo_id = ? AND usuario_id = ?',
      [grupoId, uid]
    );
    if (!miembro) {
      await conn.rollback();
      return { status: 403, body: { error: 'No eres miembro de este grupo' } };
    }

    let tiquet = null;

    if (tiquetUuid) {
      const [rows] = await conn.execute(
        'SELECT id, uuid FROM tiquets WHERE uuid = ? AND id_usuario = ? LIMIT 1',
        [tiquetUuid, uid]
      );
      tiquet = rows[0] || null;
    } else if (Number.isFinite(tiquetId)) {
      const [rows] = await conn.execute(
        'SELECT id, uuid FROM tiquets WHERE id = ? AND id_usuario = ? LIMIT 1',
        [tiquetId, uid]
      );
      tiquet = rows[0] || null;
    }

    if (!tiquet) {
      await conn.rollback();
      return { status: 404, body: { error: 'Tiquet no encontrado o no te pertenece' } };
    }

    await conn.execute(
      'INSERT IGNORE INTO tiquets_grupos (tiquet_id, grupo_id) VALUES (?, ?)',
      [tiquet.id, grupoId]
    );

    await conn.commit();
    return {
      status: 200,
      body: { success: true, grupo_id: grupoId, tiquet_uuid: tiquet.uuid }
    };
  } catch (e) {
    await conn.rollback();
    console.error('[CompartirTiquet]', e.message);
    return { status: 500, body: { error: e.message } };
  } finally {
    conn.release();
  }
}

async function handlerCompartirDesdeGrupo(req, res) {
  const uid = req.session.usuario.id;
  const grupoId = parseInt(req.params.id, 10);
  if (!Number.isFinite(grupoId)) return res.status(400).json({ error: 'Grupo inválido' });

  const { tiquetUuid, tiquetId } = normalizarPayloadCompartir(req.body);
  if (!tiquetUuid && !Number.isFinite(tiquetId)) {
    return res.status(400).json({ error: 'Falta tiquet_uuid o tiquet_id' });
  }

  const result = await compartirTiquetEnGrupo({ uid, grupoId, tiquetUuid, tiquetId });
  return res.status(result.status).json(result.body);
}

// POST /api/grupos/:id/tiquets/compartir
router.post('/api/grupos/:id/tiquets/compartir', auth, asyncWrap(handlerCompartirDesdeGrupo));

// POST /api/grupos/:id/tiquets (compatibilidad)
router.post('/api/grupos/:id/tiquets', auth, asyncWrap(handlerCompartirDesdeGrupo));

// POST /api/tiquets/:uuid/compartir (compatibilidad)
router.post('/api/tiquets/:uuid/compartir', auth, asyncWrap(async (req, res) => {
  const uid = req.session.usuario.id;
  const tiquetUuid = req.params.uuid;
  const { grupoIdBody } = normalizarPayloadCompartir(req.body);

  if (!Number.isFinite(grupoIdBody)) {
    return res.status(400).json({ error: 'Falta grupo_id válido' });
  }

  const result = await compartirTiquetEnGrupo({
    uid,
    grupoId: grupoIdBody,
    tiquetUuid,
    tiquetId: null,
  });
  return res.status(result.status).json(result.body);
}));

// ════════════════════════════════════════════════════════════
// ERROR HANDLING
// ════════════════════════════════════════════════════════════

// Middleware para manejar errores en las rutas de grupos
router.use((err, _req, res, _next) => {
  console.error('[GruposRouter]', err?.stack || err?.message || err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Error interno en grupos' });
});

module.exports = { initGruposRoutes };
