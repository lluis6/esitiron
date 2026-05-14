# Explicacion del server.js (reordenado por bloques)

Este documento explica el funcionamiento del archivo server.js por bloques. El orden esta reorganizado para entender mejor el flujo general: configuracion, seguridad, sesiones, autenticacion, OCR, APIs y funcionalidades auxiliares.

## 1) Arranque y dependencias
- Se cargan librerias de Node para servidor web, plantillas, subida de archivos, cifrado, base de datos, sesiones y utilidades.
- Se prepara la app Express y el puerto.
- Se configura el modo de produccion con `NODE_ENV`.

## 2) Variables de entorno y URLs externas
- Se definen URLs de OCR y de Open Food Facts (OFF/OPF) con valores por defecto.
- Se definen timeouts y credenciales desde variables de entorno.

## 3) Prometheus (metricas)
- Se crea un registro de metricas.
- Se exponen contadores y gauges para:
  - tickets subidos
  - total historico
  - tickets en las ultimas 24h

## 4) Cifrado de datos sensibles
- Se requiere `SESSION_SECRET` y `AES_SALT`.
- Se deriva una clave con `scrypt` y se usa AES-256-GCM.
- Se define `encrypt()` y `decrypt()`.
- Esto se usa para cifrar el secreto TOTP en base de datos.

## 5) Directorios y archivos
- Se definen rutas para avatares y archivos privados.
- Se comprueba que el directorio de avatares sea escribible.

## 6) Base de datos
- Se crea un pool de conexiones MySQL.
- Se ajusta charset utf8mb4.
- Se inicializan tablas y columnas si faltan.
- Se crean tablas auxiliares (diccionario, verificaciones, etc.).

## 7) Helpers
- Normalizacion de tiendas.
- Parseo de fechas.
- Helpers para reglas de negocio (categoria peso, descuento, etc.).

## 8) Subidas de archivos (multer)
- `uploadTiquet`: sube imagen o PDF del ticket, con validacion de MIME/ext.
- `uploadAvatar`: sube avatar con limite y validacion.
- `uploadOpf`: sube imagen para Open Food Facts.
- Se normalizan imagenes HEIC/HEIF a JPEG si `sharp` esta disponible.

## 9) Assets y middleware
- Se sirven assets estaticos (CSS/JS/imagenes).
- Se parsea body URL-encoded y JSON.

## 10) Sesiones y cookies
- Se configura `express-session`.
- La cookie es `httpOnly` y `secure`.
- `sameSite: lax` para compatibilidad con Tailscale.
- La sesion se firma con `SESSION_SECRET`.
- Nota: la cookie NO cifra el contenido de la sesion; guarda un ID firmado.

## 11) Cabeceras de seguridad
- `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
- `Cache-Control: no-store` para paginas privadas.

## 12) Middlewares de auth
- `auth`: exige sesion activa.
- `adminOnly` y `adminPageOnly`: permisos de admin.

## 13) Endpoints tecnicos
- `/health` para estado.
- `/debug-charset` para depuracion de charset DB.

## 14) Servidor de metricas
- Servidor HTTP separado en puerto 9091 con `/metrics`.

## 15) Avatar seguro
- `/avatar/:filename` valida extension y existencia.
- Protege con sesion y cabeceras de seguridad.

## 16) Plantillas Nunjucks
- Configura `views` y filtros de formato.
- Se define `navLocals()` para datos comunes de la UI.

## 17) Consultas a BD (helpers)
- `getUser`, `getTiquets`, `getTotalesPeriodo`, etc.
- Helpers para reportes, productos, y datos de tickets.

## 18) Guardado de ticket
- `guardarTiquet()` normaliza productos, calcula total, crea ticket.
- Actualiza diccionario de productos.
- Inserta historial de precios.

## 19) Auth: login, registro, logout
- Registro: password se hashea con `bcryptjs.hashSync`.
- Login: se compara con `bcryptjs.compareSync`.
- Si tiene TOTP activo, crea `req.session.totp_pending`.
- Si no, crea `req.session.usuario`.

## 20) 2FA / TOTP
- Setup: genera secreto con `speakeasy.generateSecret`.
- Verificacion: `speakeasy.totp.verify`.
- Guarda el secreto cifrado (AES-256-GCM).
- Crea codigos de recuperacion y los guarda con bcrypt.
- En login, descifra el secreto y valida el token.

## 21) Dashboard y vistas
- `/dashboard`, `/tiquets`, `/tiquet/:uuid`, etc.
- Carga datos desde BD y renderiza vistas.

## 22) OCR: subida y previsualizacion
- Subida de ticket:
  - valida archivo
  - normaliza imagen (HEIC -> JPEG)
  - llama al OCR via HTTP
  - guarda resultado en sesion `tiquetPendent`
- Preview: muestra datos antes de guardar.

## 23) Confirmar / guardar ticket
- Convierte el formulario en datos.
- Llama a `guardarTiquet`.
- Incrementa contador de Prometheus.

## 24) Productos y curacion
- Listado de productos del usuario.
- Vinculacion con productos maestros.
- Verificaciones de codigo de barras.

## 25) APIs publicas (auth requeridos)
- `/api/producto/:id/precios`
- `/api/maestros/buscar`
- `/api/proxy/off`
- `/api/opf/*`
- `/api/compras/*`
- `/api/verificaciones/*`

## 26) Open Food Facts (OFF/OPF)
- Consulta OFF con fallback.
- Import de productos OPF.
- Subida de imagenes y datos.

## 27) Perfil y cuenta
- Actualizar username/email/password.
- Cambiar avatar.
- Eliminar cuenta (borra datos relacionados).

## 28) 404
- Si no hay sesion, redirige a login.
- Si hay sesion, muestra error404.

## 29) Arranque
- Inicializa BD.
- Inicia servidor de metricas.
- Inicia app Express.

---

Si quieres, puedo ampliar cada bloque con ejemplos de codigo o referencias a lineas concretas.