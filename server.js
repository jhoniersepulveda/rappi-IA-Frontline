require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

// ─── Load static data ────────────────────────────────────────────────────────

const advisorsData = JSON.parse(fs.readFileSync('./advisors.json', 'utf8'));
const storesData   = JSON.parse(fs.readFileSync('./stores.json', 'utf8'));

if (!fs.existsSync('./sessions.json')) {
  fs.writeFileSync('./sessions.json', '{}');
}
let sessionsCache = JSON.parse(fs.readFileSync('./sessions.json', 'utf8'));

// ─── Google Calendar auth ────────────────────────────────────────────────────

const calendarAuth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/calendar'],
});

const calendar = google.calendar({ version: 'v3', auth: calendarAuth });

// ─── Nodemailer transporter ──────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function persistSessions() {
  try {
    fs.writeFileSync('./sessions.json', JSON.stringify(sessionsCache, null, 2));
  } catch (err) {
    console.error('[sessions] Failed to persist sessions.json:', err.message);
  }
}

function todayInBogota() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

function isBusinessDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00-05:00');
  const dow = d.getDay();
  return dow !== 0 && dow !== 6;
}

function generateSlots(dateStr) {
  const slots = [];
  for (let h = 9; h < 18; h++) {
    for (let m = 0; m < 60; m += 15) {
      if (h === 17 && m > 45) break;
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      slots.push(`${dateStr}T${hh}:${mm}:00-05:00`);
    }
  }
  return slots; // 36 slots: 9:00–17:45
}

function slotOverlapsBusy(slotIso, busyPeriods) {
  const slotStart = new Date(slotIso).getTime();
  const slotEnd = slotStart + 15 * 60 * 1000;
  return busyPeriods.some(b => {
    const bStart = new Date(b.start).getTime();
    const bEnd = new Date(b.end).getTime();
    return bStart < slotEnd && bEnd > slotStart;
  });
}

function buildCalendarLink({ title, startIso, description }) {
  const toGCal = (iso) =>
    new Date(iso).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const endIso = new Date(new Date(startIso).getTime() + 15 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${toGCal(startIso)}/${toGCal(endIso)}`,
    details: description,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function formatDateTimeSpanish(isoStr) {
  const d = new Date(isoStr);
  const datePart = new Intl.DateTimeFormat('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'America/Bogota',
  }).format(d);
  const timePart = new Intl.DateTimeFormat('es-CO', {
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'America/Bogota',
  }).format(d);
  return `${datePart.charAt(0).toUpperCase() + datePart.slice(1)} · ${timePart.toUpperCase()}`;
}

const PROBLEM_TYPES = [
  'Pagos y liquidaciones',
  'Pedidos y operaciones',
  'Visibilidad en plataforma',
  'Acceso a la app',
  'Otro',
];

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login API
app.post('/api/login', (req, res) => {
  const { storeId, password } = req.body;
  if (!storeId || !password) {
    return res.status(400).json({ error: 'Store ID y contraseña son requeridos' });
  }
  const store = storesData.stores.find(
    s => s.storeId === storeId.trim() && s.password === password
  );
  if (!store) {
    return res.status(401).json({ error: 'Store ID o contraseña incorrectos' });
  }
  const { password: _, ...safeStore } = store;
  return res.json({ store: safeStore });
});

// Redirect /app to index.html (keeps ?store= param)
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Portal simulation
app.get('/portal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

// Root → login
app.get('/', (req, res) => {
  res.redirect('/login');
});

// Static files (after explicit routes so / is not intercepted)
app.use(express.static(path.join(__dirname, 'public')));

// ─── GET /api/advisor?store= ─────────────────────────────────────────────────

app.get('/api/advisor', (req, res) => {
  const storeId = (req.query.store || '').trim();
  if (!storeId) {
    return res.status(400).json({ error: 'Parámetro store requerido' });
  }
  const advisor = advisorsData.advisors.find(a => a.storeIds.includes(storeId));
  if (!advisor) {
    return res.status(404).json({ error: 'Asesor no encontrado para esta tienda' });
  }
  return res.json(advisor);
});

// ─── GET /api/session-today?store= ──────────────────────────────────────────

app.get('/api/session-today', (req, res) => {
  const storeId = (req.query.store || '').trim();
  if (!storeId) {
    return res.status(400).json({ error: 'Parámetro store requerido' });
  }
  const today = todayInBogota();
  const key = `${storeId}:${today}`;
  if (sessionsCache[key]) {
    return res.json({ hasSession: true, session: sessionsCache[key] });
  }
  return res.json({ hasSession: false });
});

// ─── GET /api/slots?advisorId=&date= ────────────────────────────────────────

app.get('/api/slots', async (req, res) => {
  const { advisorId, date } = req.query;
  if (!advisorId || !date) {
    return res.status(400).json({ error: 'Parámetros advisorId y date requeridos' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Formato de fecha inválido (YYYY-MM-DD)' });
  }
  if (!isBusinessDay(date)) {
    return res.status(400).json({ error: 'No hay disponibilidad los fines de semana' });
  }

  const advisor = advisorsData.advisors.find(a => a.id === advisorId);
  if (!advisor) {
    return res.status(404).json({ error: 'Asesor no encontrado' });
  }

  const timeMin = `${date}T09:00:00-05:00`;
  const timeMax = `${date}T18:00:00-05:00`;

  let busyPeriods = [];
  try {
    const fbRes = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: 'America/Bogota',
        items: [{ id: advisor.calendarId }],
      },
    });
    const calData = fbRes.data.calendars[advisor.calendarId];
    if (calData && calData.busy) {
      busyPeriods = calData.busy;
    }
    if (calData && calData.errors) {
      console.warn('[slots] Calendar errors for', advisor.calendarId, calData.errors);
    }
  } catch (err) {
    console.error('[slots] Google Calendar freebusy error:', err.message);
    return res.status(503).json({ error: 'No se pudo consultar la disponibilidad. Intenta de nuevo.' });
  }

  const allSlots = generateSlots(date);
  const nowPlus30 = Date.now() + 30 * 60 * 1000;

  const available = allSlots.filter(slot => {
    const slotTime = new Date(slot).getTime();
    if (slotTime < nowPlus30) return false; // past or too soon
    return !slotOverlapsBusy(slot, busyPeriods);
  });

  return res.json({ date, advisorId, slots: available });
});

// ─── POST /api/book ──────────────────────────────────────────────────────────

app.post('/api/book', async (req, res) => {
  const { storeId, advisorId, slot, problemType, description, restaurantName } = req.body;

  // Validation
  if (!storeId || !advisorId || !slot || !problemType || !description) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }
  if (!PROBLEM_TYPES.includes(problemType)) {
    return res.status(400).json({ error: 'Tipo de problema inválido' });
  }
  if (description.length > 300) {
    return res.status(400).json({ error: 'La descripción no puede superar 300 caracteres' });
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(slot)) {
    return res.status(400).json({ error: 'Formato de slot inválido' });
  }

  const advisor = advisorsData.advisors.find(a => a.id === advisorId);
  if (!advisor) {
    return res.status(404).json({ error: 'Asesor no encontrado' });
  }
  if (!advisor.storeIds.includes(storeId.trim())) {
    return res.status(403).json({ error: 'Esta tienda no corresponde al asesor indicado' });
  }

  // One session per day rule
  const slotDate = slot.substring(0, 10);
  const sessionKey = `${storeId}:${slotDate}`;
  if (sessionsCache[sessionKey]) {
    return res.status(409).json({
      error: 'Ya tienes una sesión agendada para hoy',
      existingSession: sessionsCache[sessionKey],
    });
  }

  // Compute end time (15 minutes)
  const startTime = new Date(slot);
  const endTime = new Date(startTime.getTime() + 15 * 60 * 1000);
  const name = (restaurantName || `Tienda ${storeId}`).trim();
  const eventTitle = `Frontline · ${name} · ${problemType}`;
  const eventDescription = `Tienda: ${storeId}\nRestaurante: ${name}\nProblema: ${problemType}\n\n${description}\n\nSesión máximo 15 minutos.`;

  // Create Google Calendar event
  let eventId = null;
  try {
    const eventRes = await calendar.events.insert({
      calendarId: advisor.calendarId,
      requestBody: {
        summary: eventTitle,
        description: eventDescription,
        start: { dateTime: startTime.toISOString(), timeZone: 'America/Bogota' },
        end: { dateTime: endTime.toISOString(), timeZone: 'America/Bogota' },
        reminders: {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: 10 }],
        },
      },
    });
    eventId = eventRes.data.id;
  } catch (err) {
    console.error('[book] Google Calendar insert error:', err.message);
    if (err.code === 409 || (err.errors && err.errors[0]?.reason === 'duplicate')) {
      return res.status(409).json({ error: 'El horario ya no está disponible, elige otro' });
    }
    return res.status(503).json({ error: 'No se pudo agendar la sesión. Intenta de nuevo.' });
  }

  // Send email to advisor (non-blocking)
  const formattedDateTime = formatDateTimeSpanish(slot);
  const emailHtml = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#FF441A;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="color:white;margin:0">Sesión Frontline agendada</h2>
      </div>
      <div style="background:#f9f9f9;padding:24px;border-radius:0 0 8px 8px;border:1px solid #eee">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#666;width:140px">Restaurante</td><td style="padding:8px 0;font-weight:600">${name}</td></tr>
          <tr><td style="padding:8px 0;color:#666">Store ID</td><td style="padding:8px 0;font-weight:600">${storeId}</td></tr>
          <tr><td style="padding:8px 0;color:#666">Tipo de problema</td><td style="padding:8px 0;font-weight:600">${problemType}</td></tr>
          <tr><td style="padding:8px 0;color:#666">Fecha y hora</td><td style="padding:8px 0;font-weight:600">${formattedDateTime}</td></tr>
          <tr><td style="padding:8px 0;color:#666;vertical-align:top">Descripción</td><td style="padding:8px 0">${description.replace(/\n/g, '<br>')}</td></tr>
        </table>
        <div style="margin-top:20px;padding:12px 16px;background:#fff3cd;border-radius:6px;border-left:4px solid #FF441A">
          <strong>Importante:</strong> Sesión máximo 15 minutos. Intenta resolver el caso antes de la llamada.
        </div>
      </div>
    </div>
  `;

  transporter.sendMail({
    from: process.env.SMTP_USER,
    to: advisor.email,
    subject: `Sesión Frontline – ${name} – ${formattedDateTime}`,
    html: emailHtml,
  }).catch(err => {
    console.error('[book] Email send error:', err.message);
  });

  // Persist session
  sessionsCache[sessionKey] = {
    slot,
    advisorId: advisor.id,
    advisorName: advisor.name,
    problemType,
    restaurantName: name,
    confirmedAt: new Date().toISOString(),
    eventId,
  };
  persistSessions();

  // Build add-to-calendar link
  const calendarLink = buildCalendarLink({
    title: eventTitle,
    startIso: slot,
    description: eventDescription,
  });

  return res.json({
    confirmationId: eventId,
    slot,
    advisorName: advisor.name,
    advisorTitle: advisor.title,
    problemType,
    restaurantName: name,
    calendarLink,
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000');
app.listen(PORT, () => {
  console.log(`\n🚀 Rappi Frontline corriendo en http://localhost:${PORT}`);
  console.log(`   Portal: http://localhost:${PORT}/portal?store=84921`);
  console.log(`   App:    http://localhost:${PORT}/app?store=84921\n`);
});
