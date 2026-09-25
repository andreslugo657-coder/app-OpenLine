# OpenLine Secure Sync

Este repositorio originalmente era una app SPA de una sola página con sincronización por MQTT público. Eso no es seguro para un taller profesional con datos de clientes, finanzas, stock y permisos administrativos.

Se agregó un backend mínimo y seguro que permite:

- autorizar dispositivos por taller
- revocar dispositivos no autorizados
- validar sesiones por token por dispositivo
- firmar mensajes con HMAC para evitar spoofing
- usar WebSockets autenticados en vez de publicar sobre un broker público anónimo
- centralizar comandos y estado

## Requisitos

- Node.js 18+
- npm

## Instalar

```bash
npm install
```

## Ejecutar

```bash
npm start
```

La API queda disponible en:

- http://localhost:3000/health
- ws://localhost:3000/ws

## Endpoints principales

### 1) Autorizar un dispositivo a un taller

```bash
curl -X POST http://localhost:3000/api/workshops/TALLER-1000/authorize \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "dev_phone_01",
    "user": "Admin",
    "branch": "Central",
    "role": "admin",
    "adminPin": "1234"
  }'
```

Respuesta:

```json
{
  "workshopId": "TALLER-1000",
  "deviceId": "dev_phone_01",
  "sessionToken": "...",
  "deviceSecret": "...",
  "expiresAt": 1720000000000,
  "status": "authorized"
}
```

### 2) Enviar sincronización segura

```bash
curl -X POST http://localhost:3000/api/workshops/TALLER-1000/sync \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "dev_phone_01",
    "sessionToken": "...",
    "action": "repairs",
    "payload": [{ "id": "1001", "status": "WAITING" }],
    "sig": "..."
  }'
```

La firma `sig` debe calcularse con el `deviceSecret` recibido en la autorización.

### 3) Enviar comando administrativo

```bash
curl -X POST http://localhost:3000/api/workshops/TALLER-1000/command \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "dev_phone_01",
    "sessionToken": "...",
    "command": "ACTIVATE_LICENSE",
    "payload": { "license": { "type": "PRO" } },
    "sig": "..."
  }'
```

### 4) Ver estado del taller

```bash
curl http://localhost:3000/api/workshops/TALLER-1000/status
```

## Seguridad aplicada

- El broker público ya no se usa.
- Los dispositivos deben autenticarse con PIN maestro del taller.
- Toda sesión usa `sessionToken` temporal.
- Cada mensaje tiene firma HMAC con secreto por dispositivo.
- Los WebSockets exigen sesión válida antes de recibir broadcast.
- Los dispositivos pueden ser revocados por el administrador del taller.
- La clave del backend no vive en el navegador.

## Cómo integrar esto a la app principal

1. En `index.html` reemplazar la conexión MQTT pública por una llamada de registro al backend.
2. Guardar `sessionToken` + `deviceSecret` en `localStorage` del dispositivo.
3. En cada sincronización publicar por `POST /api/workshops/:id/sync` con firma HMAC.
4. Los eventos del taller se reciben por WebSocket autenticado en `/ws`.
5. Sustituir los topics de MQTT por eventos del taller en JSON serializados.

## Limitación del prototipo

Este es un modelo seguro funcional para entorno local o hosting privado, pero aún no está integrado al HTML principal de la app del usuario. El siguiente paso recomendado es:

- crear un archivo `secureSyncClient.js`
- reemplazar la conexión MQTT pública en `index.html`
- migrar las llamadas actuales `publishRepairsMQTT`, `publishStockMQTT`, etc. a la API del backend

## Variables de entorno

```bash
PORT=3000
OPENLINE_ADMIN_PIN=1234
OPENLINE_SERVER_SECRET=tu_secret_super_secreto
```

## Recomiendo para producción

- mover la base de datos a PostgreSQL/Mongo
- usar JWT con expiración
- usar HTTPS con TLS 1.2+
- bloquear acceso por IP o whitelist
- cifrar también en la base de datos
- mantener una lista de dispositivos permitidos
- no usar `localStorage` para secretos críticos si se puede evitar (usar cookies HttpOnly o almacenamiento seguro del navegador)
