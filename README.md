# NalessS♫♫ — Reproductor Compartido

Reproductor de música estilo Nintendo con cola compartida en tiempo real para 2 personas.

## Requisitos

- Node.js 18 o superior → https://nodejs.org
- Cuenta de Spotify Premium (para Web Playback SDK)

## Instalación rápida

```bash
# 1. Entra a la carpeta
cd "NalessS♫♫"

# 2. Instala dependencias
npm install

# 3. Inicia el servidor
npm start
```

Luego abre http://localhost:3000 en tu navegador.

## Cómo usarlo con 2 personas

### Opción A — Misma red WiFi
1. Ejecuta `npm start`
2. Encuentra tu IP local (en Windows: `ipconfig` en cmd)
3. Comparte `http://TU-IP:3000` con la otra persona
4. Ambas se conectan y comparten la cola

### Opción B — Cualquier lugar (internet)
Sube la app a Railway o Render (gratis):

**Railway:**
1. Crea cuenta en https://railway.app
2. Nuevo proyecto → Deploy from GitHub
3. Sube esta carpeta a GitHub primero
4. Agrega las variables de entorno del archivo `.env`
5. Railway te da una URL pública

**Render:**
1. Crea cuenta en https://render.com
2. New → Web Service → conecta tu repo
3. Build command: `npm install`
4. Start command: `npm start`

## Variables de entorno

Edita el archivo `.env`:

```
SPOTIFY_CLIENT_ID=tu_client_id
SPOTIFY_CLIENT_SECRET=tu_client_secret
REDIRECT_URI=http://localhost:3000/callback
PORT=3000
```

Cuando lo subas a internet, cambia `REDIRECT_URI` a tu URL real
y agrégala también en tu app de Spotify Dashboard.

## Características

- Cola compartida en tiempo real (Socket.io)
- Control de Spotify (requiere Premium)
- Subida de MP3s propios
- Notificaciones de quién agregó qué
- Diseño estilo papel cuadriculado Nintendo
- Animaciones y efectos pixelados
- 2+ personas pueden usarlo simultáneamente

## Notas importantes

- El Web Playback SDK de Spotify requiere cuenta **Premium**
- Los MP3s subidos se guardan en la carpeta `/uploads`
- La app está en "Development mode" en Spotify, agrega tu email
  en User Management del Dashboard para que funcione

## Estructura de archivos

```
NalessS/
├── server.js          ← Servidor principal
├── package.json
├── .env               ← Credenciales (NO compartir)
├── uploads/           ← MP3s subidos
└── public/
    ├── index.html
    ├── css/style.css
    ├── js/app.js
    └── assets/
```
