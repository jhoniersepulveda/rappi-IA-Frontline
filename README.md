# Rappi Frontline

Simula el botón **"Necesito ayuda"** de Rappi Aliados. El restaurante hace clic y puede agendar una sesión de soporte de 15 minutos con su asesor asignado, directamente en Google Calendar.

---

## Flujo de usuario (3 pasos)

1. **Ver asesor** — Bottom sheet con perfil del asesor + botón "Agendar sesión"
2. **Elegir horario** — Slots de 15 min (lun–vie, 9am–6pm) + tipo de problema + descripción
3. **Confirmación** — Resumen de la sesión + botón "Agregar a Google Calendar"

La app identifica la tienda por URL: `rappi-frontline.com/app?store=84921`

---

## Configuración paso a paso

### 1. Crear proyecto y cuenta de servicio en Google Cloud

1. Ve a [console.cloud.google.com](https://console.cloud.google.com) y crea un proyecto nuevo
2. Activa la **Google Calendar API**: APIs & Services → Library → busca "Google Calendar API" → Enable
3. Ve a **IAM & Admin → Service Accounts** → Create service account
   - Nombre: `frontline-bot`
   - Rol: ninguno es necesario (los permisos los da el calendario)
4. Entra al service account creado → pestaña **Keys** → Add Key → JSON
5. Descarga el archivo `.json` — contiene el `client_email` y la `private_key`

### 2. Compartir los calendarios de asesores con la cuenta de servicio

En Google Calendar de cada asesor:
1. Abre Google Calendar → busca el calendario del asesor en la barra izquierda
2. Click en los tres puntos → **Settings and sharing**
3. Sección **Share with specific people** → agrega el `client_email` de la cuenta de servicio
4. Permiso: **Make changes to events**
5. Repite para cada asesor en `advisors.json`

> Sin este paso, la cuenta de servicio no puede leer ni crear eventos en el calendario del asesor.

### 3. Configurar el archivo `.env`

Edita el archivo `.env` con los datos del JSON descargado:

```env
# Google Calendar — copia del JSON de la cuenta de servicio
GOOGLE_SERVICE_ACCOUNT_EMAIL=frontline-bot@tu-proyecto.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"

# SMTP para notificaciones al asesor
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=tu-cuenta@gmail.com
SMTP_PASS=tu-app-password   # Genera en Google Account → Security → App passwords

# Servidor
PORT=3000
```

**Importante sobre `GOOGLE_PRIVATE_KEY`:**
- En el archivo `.env` local, la clave debe estar en una sola línea dentro de comillas dobles con `\n` literal (como aparece en el JSON descargado)
- En Railway/Render, pega la clave tal cual desde el JSON — la plataforma maneja los saltos de línea

### 4. Agregar asesores a `advisors.json`

Cada asesor necesita estos campos:

```json
{
  "id": "advisor_002",
  "name": "Ana Martínez",
  "title": "Partner Advisor",
  "email": "ana@rappi.com",
  "calendarId": "ana@rappi.com",
  "initials": "AM",
  "yearsAtRappi": 3,
  "rating": 4.8,
  "totalSessions": 215,
  "bio": "Especializada en pedidos y operaciones. Siempre lista para ayudarte a crecer.",
  "storeIds": ["11111", "22222", "33333"]
}
```

- `calendarId`: generalmente el email del asesor (si usa Google Workspace)
- `storeIds`: lista de tiendas asignadas a este asesor

---

## Ejecutar localmente

```bash
# Instalar dependencias
npm install

# Iniciar servidor
npm start

# Modo desarrollo (recarga automática, Node 18+)
npm run dev
```

Abre el navegador en: [http://localhost:3000/app?store=84921](http://localhost:3000/app?store=84921)

---

## Estructura de archivos

```
rappi-frontline/
├── server.js          # Express + Google Calendar API + Nodemailer
├── advisors.json      # Config de asesores y tiendas asignadas
├── sessions.json      # Registro de sesiones (una por tienda por día)
├── .env               # Credenciales (no subir a git)
├── public/
│   └── index.html     # Frontend completo (vanilla JS + CSS)
├── package.json
└── README.md
```

---

## API endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/advisor?store=84921` | Devuelve el asesor asignado a una tienda |
| `GET` | `/api/session-today?store=84921` | Verifica si ya hay sesión agendada hoy |
| `GET` | `/api/slots?advisorId=advisor_001&date=2026-03-12` | Slots disponibles de 15 min |
| `POST` | `/api/book` | Agenda la sesión en Google Calendar y envía email |

---

## Deploy gratuito en Railway

1. Sube el código a GitHub (sin el `.env`, agrégalo a `.gitignore`)
2. Ve a [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Selecciona tu repositorio
4. En la sección **Variables**, agrega todas las variables del `.env`
   - Para `GOOGLE_PRIVATE_KEY`: pega la clave multilínea directamente (Railway la maneja bien)
5. Railway detecta `npm start` automáticamente y despliega

## Deploy gratuito en Render

1. Ve a [render.com](https://render.com) → New Web Service → Connect GitHub
2. Build Command: `npm install`
3. Start Command: `npm start`
4. En **Environment Variables**, agrega las variables del `.env`
5. Plan gratuito: el servidor puede tardar ~30s en "despertar" si estuvo inactivo

---

## Reglas de negocio

- **Una sesión por tienda por día** — si la tienda ya tiene sesión hoy, se muestra un mensaje amigable
- **Slots de exactamente 15 minutos** — sin excepciones
- **Horario disponible**: lunes a viernes, 9:00 AM – 6:00 PM (America/Bogota)
- **El asesor recibe**: invitación de Google Calendar + email con detalle del caso

---

## Agregar a `.gitignore`

```
node_modules/
.env
sessions.json
```
