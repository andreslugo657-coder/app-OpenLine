# OpenLine Secure

OpenLine es una app web multi-taller. El servidor es la autoridad de los datos: cada sesión queda limitada a un taller, las escrituras usan revisión optimista y las operaciones de venta/caja se aplican en una sola transacción.

## Rutas

- `/` — interfaz operativa de un taller.
- `/master.html` — panel maestro separado. No se enlaza desde la interfaz de talleres y exige la contraseña maestra del servidor.
- `/seguimiento.html?w=TALLER-1000&id=OL-...&tk=...` — seguimiento público con token firmado por orden.
- `/health` — estado básico del servidor.

## Configuración

Node.js 18 o superior:

```bash
npm install
npm start
```

Variables obligatorias:

```bash
OPENLINE_SERVER_SECRET=un-secreto-aleatorio-de-32-caracteres-o-mas
OPENLINE_MASTER_PASSWORD=una-clave-maestra-larga
```

Opcionales:

```bash
PORT=3000
OPENLINE_DATA_FILE=./data/openline.json
CORS_ORIGIN=https://tu-dominio.example
```

`OPENLINE_MASTER_PASSWORD` puede reemplazarse por `OPENLINE_MASTER_PASSWORD_HASH`, generado con el formato `salt:hash` de `crypto.scrypt`. Nunca guardes contraseñas dentro de HTML, JavaScript o `localStorage`.

## Flujo seguro

1. El administrador abre `/master.html`, inicia sesión y crea un taller con su código y contraseña de unión.
2. Cada dispositivo secundario abre `/`, introduce el código y la contraseña y recibe una sesión temporal.
3. El servidor devuelve únicamente el estado del taller autenticado. No existen topics públicos ni sincronización MQTT.
4. Caja, ventas y stock se guardan juntas en una transacción. Si otro dispositivo modificó el stock, la venta se rechaza y la app refresca el estado.
5. Los demás cambios se guardan con `baseRevision`; un conflicto no sobrescribe silenciosamente el trabajo de otro dispositivo.

## Seguridad incorporada

- Contraseñas con `crypto.scrypt` y comparación constante.
- Sesiones temporales en memoria del servidor; el navegador solo conserva el token en `sessionStorage`.
- Rate limit para login maestro y unión de talleres.
- Validación de alcance: una sesión no puede leer ni escribir otro `workshopId`.
- Cabeceras de seguridad, límite de payload y CORS explícito.
- Persistencia JSON con escritura temporal y rename atómico.
- El seguimiento público requiere un token HMAC por orden y solo expone datos reducidos.
- El panel maestro no forma parte de `index.html` y sus endpoints exigen una sesión de rol maestro.

## Nota de producción

La persistencia JSON es adecuada para una instalación pequeña o una primera versión. Para varios servidores o alta concurrencia, cambia `OPENLINE_DATA_FILE` por PostgreSQL/SQLite administrado y conserva las mismas reglas de aislamiento y transacciones. Publica siempre detrás de HTTPS y configura un `CORS_ORIGIN` explícito.