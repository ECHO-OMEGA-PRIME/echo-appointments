import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
  EMAIL_SENDER: Fetcher;
  ECHO_API_KEY?: string;
}

interface Tenant {
  id: string;
  name: string;
  email: string;
  company?: string;
  timezone: string;
  booking_url?: string;
  api_key: string;
  created_at: string;
}

interface Provider {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  role?: string;
  bio?: string;
  avatar_url?: string;
  active: number;
  created_at: string;
}

interface Service {
  id: string;
  tenant_id: string;
  name: string;
  description?: string;
  duration_min: number;
  price: number;
  currency: string;
  color: string;
  active: number;
  created_at: string;
}

interface Availability {
  id: string;
  provider_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_available: number;
}

interface Appointment {
  id: string;
  tenant_id: string;
  provider_id: string;
  service_id: string;
  client_name: string;
  client_email: string;
  client_phone?: string;
  start_time: string;
  end_time: string;
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  notes?: string;
  reminder_sent: number;
  created_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VERSION = '1.0.0';
const SERVICE = 'echo-appointments';

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data, timestamp: new Date().toISOString() }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(message: string, status = 400, details?: unknown): Response {
  return new Response(
    JSON.stringify({ success: false, error: message, details, timestamp: new Date().toISOString() }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

function log(level: string, msg: string, meta?: Record<string, unknown>) {
  console.log(JSON.stringify({ level, service: SERVICE, message: msg, ...meta, ts: new Date().toISOString() }));
}

function nanoid(len = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

// Parse HH:MM into minutes since midnight
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// Validate a time slot doesn't clash with existing appointments
async function isSlotAvailable(
  db: D1Database,
  provider_id: string,
  start_time: string,
  end_time: string,
  exclude_id?: string
): Promise<boolean> {
  let query = `
    SELECT COUNT(*) as cnt FROM appointments
    WHERE provider_id = ?
      AND status NOT IN ('cancelled','no_show')
      AND start_time < ?
      AND end_time > ?
  `;
  const params: unknown[] = [provider_id, end_time, start_time];
  if (exclude_id) {
    query += ' AND id != ?';
    params.push(exclude_id);
  }
  const result = await db.prepare(query).bind(...params).first<{ cnt: number }>();
  return (result?.cnt ?? 1) === 0;
}

// Auth middleware factory
function requireAuth(env: Env) {
  return async (c: { req: { header: (k: string) => string | undefined }; json: (d: unknown, s: number) => Response }, next: () => Promise<void>) => {
    const key = c.req.header('X-Echo-API-Key');
    const validKey = env.ECHO_API_KEY;
    if (!key || key !== validKey) {
      return c.json({ success: false, error: 'Unauthorized', timestamp: new Date().toISOString() }, 401);
    }
    await next();
  };
}

// ─── App ─────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }));
// Security headers middleware
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-XSS-Protection', '1; mode=block');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});

app.use('*', logger());

// ─── Health & Status ──────────────────────────────────────────────────────────

app.get('/', (c) => c.json({ service: SERVICE, version: VERSION, status: 'operational' }));

app.get('/health', (c) => {
  return c.json({ status: 'ok', service: SERVICE, version: VERSION, timestamp: new Date().toISOString() });
});

app.get('/status', async (c) => {
  let d1Status = 'disconnected';
  try {
    await c.env.DB.prepare('SELECT 1').first();
    d1Status = 'connected';
  } catch { /* empty */ }

  return c.json({
    ok: true,
    service: SERVICE,
    version: VERSION,
    d1: d1Status,
    features: ['tenants', 'providers', 'services', 'availability', 'appointments', 'reminders', 'analytics', 'ai-analysis', 'public-booking'],
    timestamp: new Date().toISOString(),
  });
});

// ─── Tenants ──────────────────────────────────────────────────────────────────

app.post('/tenants', async (c) => {
  const key = c.req.header('X-Echo-API-Key');
  const validKey = c.env.ECHO_API_KEY;
  if (!key || key !== validKey) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const body = await c.req.json<Partial<Tenant>>();
  if (!body.name || !body.email) return c.json({ success: false, error: 'name and email required' }, 400);

  const id = nanoid();
  const api_key = nanoid(16);
  try {
    await c.env.DB.prepare(
      `INSERT INTO tenants (id, name, email, company, timezone, booking_url, api_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, body.name, body.email, body.company ?? null, body.timezone ?? 'UTC', body.booking_url ?? null, api_key).run();

    const tenant = await c.env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(id).first<Tenant>();
    log('info', 'tenant created', { id });
    return c.json({ success: true, data: tenant, timestamp: new Date().toISOString() }, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE')) return c.json({ success: false, error: 'Email already registered' }, 409);
    return c.json({ success: false, error: msg }, 500);
  }
});

app.get('/tenants/:id', async (c) => {
  const tenant = await c.env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(c.req.param('id')).first<Tenant>();
  if (!tenant) return c.json({ success: false, error: 'Tenant not found' }, 404);
  return c.json({ success: true, data: tenant, timestamp: new Date().toISOString() });
});

// ─── Providers ────────────────────────────────────────────────────────────────

app.get('/providers', async (c) => {
  const tenant_id = c.req.query('tenant_id');
  if (!tenant_id) return c.json({ success: false, error: 'tenant_id required' }, 400);
  const rows = await c.env.DB.prepare('SELECT * FROM providers WHERE tenant_id = ? ORDER BY name').bind(tenant_id).all<Provider>();
  return c.json({ success: true, data: rows.results, timestamp: new Date().toISOString() });
});

app.post('/providers', async (c) => {
  const key = c.req.header('X-Echo-API-Key');
  const validKey = c.env.ECHO_API_KEY;
  if (!key || key !== validKey) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const body = await c.req.json<Partial<Provider>>();
  if (!body.tenant_id || !body.name || !body.email) return c.json({ success: false, error: 'tenant_id, name, email required' }, 400);

  const id = nanoid();
  await c.env.DB.prepare(
    `INSERT INTO providers (id, tenant_id, name, email, role, bio, avatar_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, body.tenant_id, body.name, body.email, body.role ?? null, body.bio ?? null, body.avatar_url ?? null).run();

  const provider = await c.env.DB.prepare('SELECT * FROM providers WHERE id = ?').bind(id).first<Provider>();
  log('info', 'provider created', { id, tenant_id: body.tenant_id });
  return c.json({ success: true, data: provider, timestamp: new Date().toISOString() }, 201);
});

app.get('/providers/:id', async (c) => {
  const provider = await c.env.DB.prepare('SELECT * FROM providers WHERE id = ?').bind(c.req.param('id')).first<Provider>();
  if (!provider) return c.json({ success: false, error: 'Provider not found' }, 404);
  return c.json({ success: true, data: provider, timestamp: new Date().toISOString() });
});

app.put('/providers/:id', async (c) => {
  const key = c.req.header('X-Echo-API-Key');
  const validKey = c.env.ECHO_API_KEY;
  if (!key || key !== validKey) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const body = await c.req.json<Partial<Provider>>();
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM providers WHERE id = ?').bind(id).first<Provider>();
  if (!existing) return c.json({ success: false, error: 'Provider not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE providers SET name=?, email=?, role=?, bio=?, avatar_url=? WHERE id=?`
  ).bind(body.name ?? existing.name, body.email ?? existing.email, body.role ?? existing.role ?? null, body.bio ?? existing.bio ?? null, body.avatar_url ?? existing.avatar_url ?? null, id).run();

  const updated = await c.env.DB.prepare('SELECT * FROM providers WHERE id = ?').bind(id).first<Provider>();
  return c.json({ success: true, data: updated, timestamp: new Date().toISOString() });
});

app.patch('/providers/:id/toggle', async (c) => {
  const key = c.req.header('X-Echo-API-Key');
  const validKey = c.env.ECHO_API_KEY;
  if (!key || key !== validKey) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const provider = await c.env.DB.prepare('SELECT * FROM providers WHERE id = ?').bind(id).first<Provider>();
  if (!provider) return c.json({ success: false, error: 'Provider not found' }, 404);

  await c.env.DB.prepare('UPDATE providers SET active = ? WHERE id = ?').bind(provider.active ? 0 : 1, id).run();
  const updated = await c.env.DB.prepare('SELECT * FROM providers WHERE id = ?').bind(id).first<Provider>();
  return c.json({ success: true, data: updated, timestamp: new Date().toISOString() });
});

// ─── Services ─────────────────────────────────────────────────────────────────

app.get('/services', async (c) => {
  const tenant_id = c.req.query('tenant_id');
  if (!tenant_id) return c.json({ success: false, error: 'tenant_id required' }, 400);
  const rows = await c.env.DB.prepare('SELECT * FROM services WHERE tenant_id = ? ORDER BY name').bind(tenant_id).all<Service>();
  return c.json({ success: true, data: rows.results, timestamp: new Date().toISOString() });
});

app.post('/services', async (c) => {
  const key = c.req.header('X-Echo-API-Key');
  const validKey = c.env.ECHO_API_KEY;
  if (!key || key !== validKey) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const body = await c.req.json<Partial<Service>>();
  if (!body.tenant_id || !body.name) return c.json({ success: false, error: 'tenant_id, name required' }, 400);

  const id = nanoid();
  await c.env.DB.prepare(
    `INSERT INTO services (id, tenant_id, name, description, duration_min, price, currency, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, body.tenant_id, body.name, body.description ?? null, body.duration_min ?? 60, body.price ?? 0, body.currency ?? 'USD', body.color ?? '#3B82F6').run();

  const service = await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(id).first<Service>();
  log('info', 'service created', { id, tenant_id: body.tenant_id });
  return c.json({ success: true, data: service, timestamp: new Date().toISOString() }, 201);
});

app.get('/services/:id', async (c) => {
  const service = await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(c.req.param('id')).first<Service>();
  if (!service) return c.json({ success: false, error: 'Service not found' }, 404);
  return c.json({ success: true, data: service, timestamp: new Date().toISOString() });
});

app.put('/services/:id', async (c) => {
  const key = c.req.header('X-Echo-API-Key');
  const validKey = c.env.ECHO_API_KEY;
  if (!key || key !== validKey) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const body = await c.req.json<Partial<Service>>();
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(id).first<Service>();
  if (!existing) return c.json({ success: false, error: 'Service not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE services SET name=?, description=?, duration_min=?, price=?, currency=?, color=? WHERE id=?`
  ).bind(body.name ?? existing.name, body.description ?? existing.description ?? null, body.duration_min ?? existing.duration_min, body.price ?? existing.price, body.currency ?? existing.currency, body.color ?? existing.color, id).run();

  const updated = await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(id).first<Service>();
  return c.json({ success: true, data: updated, timestamp: new Date().toISOString() });
});

app.patch('/services/:id/toggle', async (c) => {
  const key = c.req.header('X-Echo-API-Key');
  const validKey = c.env.ECHO_API_KEY;
  if (!key || key !== validKey) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const service = await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(id).first<Service>();
  if (!service) return c.json({ success: false, error: 'Service not found' }, 404);

  await c.env.DB.prepare('UPDATE services SET active = ? WHERE id = ?').bind(service.active ? 0 : 1, id).run();
  const updated = await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(id).first<Service>();
  return c.json({ success: true, data: updated, timestamp: new Date().toISOString() });
});

// ─── Availability ─────────────────────────────────────────────────────────────

app.get('/availability', async (c) => {
  const provider_id = c.req.query('provider_id');
  if (!provider_id) return c.json({ success: false, error: 'provider_id required' }, 400);
  const rows = await c.env.DB.prepare('SELECT * FROM availability WHERE provider_id = ? ORDER BY day_of_week').bind(provider_id).all<Availability>();
  return c.json({ success: true, data: rows.results, timestamp: new Date().toISOString() });
});

// Bulk set availability for a provider (replaces all existing)
app.post('/availability', async (c) => {
  const key = c.req.header('X-Echo-API-Key');
  const validKey = c.env.ECHO_API_KEY;
  if (!key || key !== validKey) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const body = await c.req.json<{ provider_id: string; schedule: Array<{ day_of_week: number; start_time: string; end_time: string; is_available?: number }> }>();
  if (!body.provider_id || !Array.isArray(body.schedule)) return c.json({ success: false, error: 'provider_id and schedule array required' }, 400);

  // Delete existing and reinsert
  await c.env.DB.prepare('DELETE FROM availability WHERE provider_id = ?').bind(body.provider_id).run();

  const stmts = body.schedule.map((s) =>
    c.env.DB.prepare(
      `INSERT INTO availability (id, provider_id, day_of_week, start_time, end_time, is_available)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(nanoid(), body.provider_id, s.day_of_week, s.start_time, s.end_time, s.is_available ?? 1)
  );

  if (stmts.length > 0) await c.env.DB.batch(stmts);

  const rows = await c.env.DB.prepare('SELECT * FROM availability WHERE provider_id = ? ORDER BY day_of_week').bind(body.provider_id).all<Availability>();
  log('info', 'availability set', { provider_id: body.provider_id, days: body.schedule.length });
  return c.json({ success: true, data: rows.results, timestamp: new Date().toISOString() });
});

// Get available time slots for a provider given a date range
app.get('/slots/:provider_id', async (c) => {
  const provider_id = c.req.param('provider_id');
  const date_from = c.req.query('date_from'); // YYYY-MM-DD
  const date_to = c.req.query('date_to');     // YYYY-MM-DD
  const service_id = c.req.query('service_id');

  if (!date_from || !date_to) return c.json({ success: false, error: 'date_from and date_to required' }, 400);

  // Get provider
  const provider = await c.env.DB.prepare('SELECT * FROM providers WHERE id = ? AND active = 1').bind(provider_id).first<Provider>();
  if (!provider) return c.json({ success: false, error: 'Provider not found or inactive' }, 404);

  // Get service duration
  let duration_min = 60;
  if (service_id) {
    const svc = await c.env.DB.prepare('SELECT duration_min FROM services WHERE id = ?').bind(service_id).first<{ duration_min: number }>();
    if (svc) duration_min = svc.duration_min;
  }

  // Get availability rules
  const avail = await c.env.DB.prepare('SELECT * FROM availability WHERE provider_id = ? AND is_available = 1').bind(provider_id).all<Availability>();
  const availMap: Record<number, Availability> = {};
  for (const a of avail.results) availMap[a.day_of_week] = a;

  // Get booked appointments in range
  const booked = await c.env.DB.prepare(
    `SELECT start_time, end_time FROM appointments WHERE provider_id = ? AND status NOT IN ('cancelled','no_show') AND start_time >= ? AND start_time <= ?`
  ).bind(provider_id, `${date_from}T00:00:00`, `${date_to}T23:59:59`).all<{ start_time: string; end_time: string }>();

  // Build slot list
  const slots: Array<{ date: string; start: string; end: string; available: boolean }> = [];
  const from = new Date(`${date_from}T00:00:00Z`);
  const to = new Date(`${date_to}T23:59:59Z`);

  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    const rule = availMap[dow];
    if (!rule) continue;

    const dateStr = d.toISOString().split('T')[0];
    const startMin = timeToMinutes(rule.start_time);
    const endMin = timeToMinutes(rule.end_time);

    for (let m = startMin; m + duration_min <= endMin; m += duration_min) {
      const sh = String(Math.floor(m / 60)).padStart(2, '0');
      const sm = String(m % 60).padStart(2, '0');
      const eh = String(Math.floor((m + duration_min) / 60)).padStart(2, '0');
      const em = String((m + duration_min) % 60).padStart(2, '0');
      const slotStart = `${dateStr}T${sh}:${sm}:00`;
      const slotEnd = `${dateStr}T${eh}:${em}:00`;

      // Check against booked
      const clash = booked.results.some(
        (b) => b.start_time < slotEnd && b.end_time > slotStart
      );
      slots.push({ date: dateStr, start: slotStart, end: slotEnd, available: !clash });
    }
  }

  return c.json({ success: true, data: { provider_id, date_from, date_to, duration_min, slots }, timestamp: new Date().toISOString() });
});

// ─── Appointments ─────────────────────────────────────────────────────────────

app.get('/appointments', async (c) => {
  const q = c.req.query();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (q.tenant_id) { conditions.push('a.tenant_id = ?'); params.push(q.tenant_id); }
  if (q.provider_id) { conditions.push('a.provider_id = ?'); params.push(q.provider_id); }
  if (q.status) { conditions.push('a.status = ?'); params.push(q.status); }
  if (q.date_from) { conditions.push('a.start_time >= ?'); params.push(`${q.date_from}T00:00:00`); }
  if (q.date_to) { conditions.push('a.start_time <= ?'); params.push(`${q.date_to}T23:59:59`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(parseInt(q.limit ?? '100'), 500);
  const offset = parseInt(q.offset ?? '0');

  const rows = await c.env.DB.prepare(
    `SELECT a.*, p.name as provider_name, s.name as service_name FROM appointments a
     LEFT JOIN providers p ON a.provider_id = p.id
     LEFT JOIN services s ON a.service_id = s.id
     ${where} ORDER BY a.start_time DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all<Appointment & { provider_name: string; service_name: string }>();

  return c.json({ success: true, data: rows.results, total: rows.results.length, timestamp: new Date().toISOString() });
});

app.post('/appointments', async (c) => {
  const body = await c.req.json<Partial<Appointment>>();
  const required = ['tenant_id', 'provider_id', 'service_id', 'client_name', 'client_email', 'start_time', 'end_time'];
  for (const f of required) {
    if (!body[f as keyof Appointment]) return c.json({ success: false, error: `${f} required` }, 400);
  }

  // Validate slot availability
  const available = await isSlotAvailable(c.env.DB, body.provider_id!, body.start_time!, body.end_time!);
  if (!available) return c.json({ success: false, error: 'Time slot is already booked' }, 409);

  const id = nanoid();
  await c.env.DB.prepare(
    `INSERT INTO appointments (id, tenant_id, provider_id, service_id, client_name, client_email, client_phone, start_time, end_time, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`
  ).bind(id, body.tenant_id, body.provider_id, body.service_id, body.client_name, body.client_email, body.client_phone ?? null, body.start_time, body.end_time, body.notes ?? null).run();

  // Schedule reminders
  const apptTime = new Date(body.start_time!);
  const reminder24h = new Date(apptTime.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const reminder1h = new Date(apptTime.getTime() - 60 * 60 * 1000).toISOString();

  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO reminders (id, appointment_id, type, scheduled_for) VALUES (?, ?, 'email', ?)`).bind(nanoid(), id, reminder24h),
    c.env.DB.prepare(`INSERT INTO reminders (id, appointment_id, type, scheduled_for) VALUES (?, ?, 'email', ?)`).bind(nanoid(), id, reminder1h),
  ]);

  const appt = await c.env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first<Appointment>();
  log('info', 'appointment created', { id, tenant_id: body.tenant_id, provider_id: body.provider_id });
  return c.json({ success: true, data: appt, timestamp: new Date().toISOString() }, 201);
});

app.get('/appointments/:id', async (c) => {
  const appt = await c.env.DB.prepare(
    `SELECT a.*, p.name as provider_name, s.name as service_name, s.duration_min, s.price
     FROM appointments a
     LEFT JOIN providers p ON a.provider_id = p.id
     LEFT JOIN services s ON a.service_id = s.id
     WHERE a.id = ?`
  ).bind(c.req.param('id')).first<Appointment>();
  if (!appt) return c.json({ success: false, error: 'Appointment not found' }, 404);
  return c.json({ success: true, data: appt, timestamp: new Date().toISOString() });
});

app.put('/appointments/:id', async (c) => {
  const key = c.req.header('X-Echo-API-Key');
  const validKey = c.env.ECHO_API_KEY;
  if (!key || key !== validKey) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const body = await c.req.json<Partial<Appointment>>();
  const existing = await c.env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first<Appointment>();
  if (!existing) return c.json({ success: false, error: 'Appointment not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE appointments SET notes=?, client_phone=? WHERE id=?`
  ).bind(body.notes ?? existing.notes ?? null, body.client_phone ?? existing.client_phone ?? null, id).run();

  const updated = await c.env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first<Appointment>();
  return c.json({ success: true, data: updated, timestamp: new Date().toISOString() });
});

// Status transition helpers
async function setStatus(db: D1Database, id: string, status: string): Promise<Appointment | null> {
  await db.prepare('UPDATE appointments SET status = ? WHERE id = ?').bind(status, id).run();
  return db.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first<Appointment>();
}

app.patch('/appointments/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const appt = await c.env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first<Appointment>();
  if (!appt) return c.json({ success: false, error: 'Appointment not found' }, 404);
  if (['completed', 'cancelled'].includes(appt.status)) return c.json({ success: false, error: `Cannot cancel ${appt.status} appointment` }, 400);
  const updated = await setStatus(c.env.DB, id, 'cancelled');
  log('info', 'appointment cancelled', { id });
  return c.json({ success: true, data: updated, timestamp: new Date().toISOString() });
});

app.post('/appointments/:id/confirm', async (c) => {
  const id = c.req.param('id');
  const appt = await c.env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first<Appointment>();
  if (!appt) return c.json({ success: false, error: 'Appointment not found' }, 404);
  if (appt.status !== 'scheduled') return c.json({ success: false, error: 'Only scheduled appointments can be confirmed' }, 400);
  const updated = await setStatus(c.env.DB, id, 'confirmed');
  log('info', 'appointment confirmed', { id });
  return c.json({ success: true, data: updated, timestamp: new Date().toISOString() });
});

app.post('/appointments/:id/complete', async (c) => {
  const id = c.req.param('id');
  const appt = await c.env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first<Appointment>();
  if (!appt) return c.json({ success: false, error: 'Appointment not found' }, 404);
  if (!['scheduled', 'confirmed'].includes(appt.status)) return c.json({ success: false, error: 'Only scheduled/confirmed appointments can be completed' }, 400);
  const updated = await setStatus(c.env.DB, id, 'completed');
  log('info', 'appointment completed', { id });
  return c.json({ success: true, data: updated, timestamp: new Date().toISOString() });
});

app.post('/appointments/:id/no-show', async (c) => {
  const id = c.req.param('id');
  const appt = await c.env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first<Appointment>();
  if (!appt) return c.json({ success: false, error: 'Appointment not found' }, 404);
  const updated = await setStatus(c.env.DB, id, 'no_show');
  log('warn', 'appointment no-show', { id });
  return c.json({ success: true, data: updated, timestamp: new Date().toISOString() });
});

app.post('/appointments/:id/reschedule', async (c) => {
  const key = c.req.header('X-Echo-API-Key');
  const validKey = c.env.ECHO_API_KEY;
  if (!key || key !== validKey) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const body = await c.req.json<{ start_time: string; end_time: string }>();
  if (!body.start_time || !body.end_time) return c.json({ success: false, error: 'start_time and end_time required' }, 400);

  const appt = await c.env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first<Appointment>();
  if (!appt) return c.json({ success: false, error: 'Appointment not found' }, 404);
  if (['completed', 'cancelled'].includes(appt.status)) return c.json({ success: false, error: `Cannot reschedule ${appt.status} appointment` }, 400);

  const available = await isSlotAvailable(c.env.DB, appt.provider_id, body.start_time, body.end_time, id);
  if (!available) return c.json({ success: false, error: 'New time slot is already booked' }, 409);

  await c.env.DB.prepare('UPDATE appointments SET start_time=?, end_time=?, status=? WHERE id=?').bind(body.start_time, body.end_time, 'scheduled', id).run();

  // Delete old pending reminders and create new ones
  await c.env.DB.prepare(`DELETE FROM reminders WHERE appointment_id = ? AND status = 'pending'`).bind(id).run();
  const newTime = new Date(body.start_time);
  const r24 = new Date(newTime.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const r1 = new Date(newTime.getTime() - 60 * 60 * 1000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO reminders (id, appointment_id, type, scheduled_for) VALUES (?, ?, 'email', ?)`).bind(nanoid(), id, r24),
    c.env.DB.prepare(`INSERT INTO reminders (id, appointment_id, type, scheduled_for) VALUES (?, ?, 'email', ?)`).bind(nanoid(), id, r1),
  ]);

  const updated = await c.env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first<Appointment>();
  log('info', 'appointment rescheduled', { id, new_start: body.start_time });
  return c.json({ success: true, data: updated, timestamp: new Date().toISOString() });
});

// ─── AI Analysis ──────────────────────────────────────────────────────────────

app.post('/appointments/:id/analyze', async (c) => {
  const id = c.req.param('id');
  const appt = await c.env.DB.prepare(
    `SELECT a.*, p.name as provider_name, s.name as service_name FROM appointments a
     LEFT JOIN providers p ON a.provider_id = p.id
     LEFT JOIN services s ON a.service_id = s.id WHERE a.id = ?`
  ).bind(id).first<Appointment & { provider_name: string; service_name: string }>();
  if (!appt) return c.json({ success: false, error: 'Appointment not found' }, 404);

  // Get historical data for this client
  const history = await c.env.DB.prepare(
    `SELECT status, start_time FROM appointments WHERE client_email = ? ORDER BY start_time DESC LIMIT 20`
  ).bind(appt.client_email).all<{ status: string; start_time: string }>();

  try {
    const res = await c.env.ENGINE_RUNTIME.fetch('https://echo-engine-runtime.bmcii1976.workers.dev/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Echo-API-Key': c.env.ECHO_API_KEY },
      body: JSON.stringify({
        engine: 'appointments-analyzer',
        prompt: `Analyze this appointment and predict no-show risk:
Appointment: ${JSON.stringify(appt)}
Client history (last 20): ${JSON.stringify(history.results)}
Provide: no_show_risk (0-100), scheduling_pattern, recommendations.`,
        max_tokens: 500,
      }),
    });

    const analysis = await res.json();
    return c.json({ success: true, data: { appointment: appt, analysis, client_history_count: history.results.length }, timestamp: new Date().toISOString() });
  } catch (e) {
    log('error', 'engine runtime analysis failed', { id, error: String(e) });
    return c.json({ success: true, data: { appointment: appt, analysis: { note: 'AI analysis unavailable', no_show_risk: null }, client_history_count: history.results.length }, timestamp: new Date().toISOString() });
  }
});

// ─── Public Booking ───────────────────────────────────────────────────────────

app.get('/book/:tenant_id', async (c) => {
  const tenant_id = c.req.param('tenant_id');
  const tenant = await c.env.DB.prepare('SELECT id, name, company, timezone FROM tenants WHERE id = ?').bind(tenant_id).first<Partial<Tenant>>();
  if (!tenant) return c.json({ success: false, error: 'Booking page not found' }, 404);

  const [providers, services] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, role, bio, avatar_url FROM providers WHERE tenant_id = ? AND active = 1 ORDER BY name').bind(tenant_id).all<Partial<Provider>>(),
    c.env.DB.prepare('SELECT id, name, description, duration_min, price, currency, color FROM services WHERE tenant_id = ? AND active = 1 ORDER BY name').bind(tenant_id).all<Partial<Service>>(),
  ]);

  return c.json({ success: true, data: { tenant, providers: providers.results, services: services.results }, timestamp: new Date().toISOString() });
});

app.post('/book/:tenant_id', async (c) => {
  const tenant_id = c.req.param('tenant_id');
  const tenant = await c.env.DB.prepare('SELECT id FROM tenants WHERE id = ?').bind(tenant_id).first<{ id: string }>();
  if (!tenant) return c.json({ success: false, error: 'Tenant not found' }, 404);

  const body = await c.req.json<Partial<Appointment>>();
  const required = ['provider_id', 'service_id', 'client_name', 'client_email', 'start_time', 'end_time'];
  for (const f of required) {
    if (!body[f as keyof Appointment]) return c.json({ success: false, error: `${f} required` }, 400);
  }

  // Validate provider and service belong to tenant
  const provider = await c.env.DB.prepare('SELECT id FROM providers WHERE id = ? AND tenant_id = ? AND active = 1').bind(body.provider_id, tenant_id).first<{ id: string }>();
  if (!provider) return c.json({ success: false, error: 'Provider not found' }, 404);

  const service = await c.env.DB.prepare('SELECT id FROM services WHERE id = ? AND tenant_id = ? AND active = 1').bind(body.service_id, tenant_id).first<{ id: string }>();
  if (!service) return c.json({ success: false, error: 'Service not found' }, 404);

  const available = await isSlotAvailable(c.env.DB, body.provider_id!, body.start_time!, body.end_time!);
  if (!available) return c.json({ success: false, error: 'Time slot is no longer available' }, 409);

  const id = nanoid();
  await c.env.DB.prepare(
    `INSERT INTO appointments (id, tenant_id, provider_id, service_id, client_name, client_email, client_phone, start_time, end_time, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`
  ).bind(id, tenant_id, body.provider_id, body.service_id, body.client_name, body.client_email, body.client_phone ?? null, body.start_time, body.end_time, body.notes ?? null).run();

  // Schedule reminders
  const apptTime = new Date(body.start_time!);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO reminders (id, appointment_id, type, scheduled_for) VALUES (?, ?, 'email', ?)`).bind(nanoid(), id, new Date(apptTime.getTime() - 24 * 60 * 60 * 1000).toISOString()),
    c.env.DB.prepare(`INSERT INTO reminders (id, appointment_id, type, scheduled_for) VALUES (?, ?, 'email', ?)`).bind(nanoid(), id, new Date(apptTime.getTime() - 60 * 60 * 1000).toISOString()),
  ]);

  const appt = await c.env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first<Appointment>();
  log('info', 'public booking created', { id, tenant_id, client_email: body.client_email });
  return c.json({ success: true, data: appt, message: 'Appointment booked successfully', timestamp: new Date().toISOString() }, 201);
});

// ─── Analytics ────────────────────────────────────────────────────────────────

app.get('/analytics', async (c) => {
  const tenant_id = c.req.query('tenant_id');
  const date_from = c.req.query('date_from') ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const date_to = c.req.query('date_to') ?? new Date().toISOString().split('T')[0];

  const tenantFilter = tenant_id ? 'AND tenant_id = ?' : '';
  const baseParams: unknown[] = tenant_id ? [tenant_id, `${date_from}T00:00:00`, `${date_to}T23:59:59`] : [`${date_from}T00:00:00`, `${date_to}T23:59:59`];

  const [totals, byProvider, byService, revenue] = await Promise.all([
    c.env.DB.prepare(`SELECT status, COUNT(*) as cnt FROM appointments WHERE start_time >= ? AND start_time <= ? ${tenantFilter} GROUP BY status`).bind(...(tenant_id ? [`${date_from}T00:00:00`, `${date_to}T23:59:59`, tenant_id] : [`${date_from}T00:00:00`, `${date_to}T23:59:59`])).all<{ status: string; cnt: number }>(),
    c.env.DB.prepare(`SELECT p.name as provider, a.status, COUNT(*) as cnt FROM appointments a LEFT JOIN providers p ON a.provider_id=p.id WHERE a.start_time >= ? AND a.start_time <= ? ${tenantFilter} GROUP BY a.provider_id, a.status`).bind(...baseParams).all<{ provider: string; status: string; cnt: number }>(),
    c.env.DB.prepare(`SELECT s.name as service, COUNT(*) as cnt FROM appointments a LEFT JOIN services s ON a.service_id=s.id WHERE a.start_time >= ? AND a.start_time <= ? ${tenantFilter} GROUP BY a.service_id`).bind(...baseParams).all<{ service: string; cnt: number }>(),
    c.env.DB.prepare(`SELECT SUM(s.price) as total FROM appointments a LEFT JOIN services s ON a.service_id=s.id WHERE a.status='completed' AND a.start_time >= ? AND a.start_time <= ? ${tenantFilter}`).bind(...baseParams).first<{ total: number | null }>(),
  ]);

  const statusMap: Record<string, number> = {};
  for (const row of totals.results) statusMap[row.status] = row.cnt;
  const total = Object.values(statusMap).reduce((a, b) => a + b, 0);
  const completed = statusMap['completed'] ?? 0;
  const no_show = statusMap['no_show'] ?? 0;

  return c.json({
    success: true,
    data: {
      period: { from: date_from, to: date_to },
      totals: { total, ...statusMap },
      completion_rate: total ? Math.round((completed / total) * 100) : 0,
      no_show_rate: total ? Math.round((no_show / total) * 100) : 0,
      revenue: revenue?.total ?? 0,
      by_provider: byProvider.results,
      by_service: byService.results,
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

app.get('/dashboard', async (c) => {
  const tenant_id = c.req.query('tenant_id');
  const tenantFilter = tenant_id ? 'AND tenant_id = ?' : '';
  const params = (extra: unknown[]) => tenant_id ? [...extra, tenant_id] : extra;

  const now = new Date().toISOString();
  const todayStart = new Date().toISOString().split('T')[0] + 'T00:00:00';
  const todayEnd = new Date().toISOString().split('T')[0] + 'T23:59:59';
  const upcoming_cutoff = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const [todayAppts, upcomingAppts, recentCancels, utilization] = await Promise.all([
    c.env.DB.prepare(
      `SELECT a.*, p.name as provider_name, s.name as service_name FROM appointments a LEFT JOIN providers p ON a.provider_id=p.id LEFT JOIN services s ON a.service_id=s.id WHERE a.start_time >= ? AND a.start_time <= ? ${tenantFilter} ORDER BY a.start_time`
    ).bind(...params([todayStart, todayEnd])).all<Appointment>(),
    c.env.DB.prepare(
      `SELECT a.*, p.name as provider_name, s.name as service_name FROM appointments a LEFT JOIN providers p ON a.provider_id=p.id LEFT JOIN services s ON a.service_id=s.id WHERE a.start_time > ? AND a.start_time <= ? AND a.status IN ('scheduled','confirmed') ${tenantFilter} ORDER BY a.start_time LIMIT 20`
    ).bind(...params([now, upcoming_cutoff])).all<Appointment>(),
    c.env.DB.prepare(
      `SELECT a.*, p.name as provider_name FROM appointments a LEFT JOIN providers p ON a.provider_id=p.id WHERE a.status='cancelled' ${tenantFilter} ORDER BY a.created_at DESC LIMIT 10`
    ).bind(...(tenant_id ? [tenant_id] : [])).all<Appointment>(),
    c.env.DB.prepare(
      `SELECT p.name, COUNT(*) as total, SUM(CASE WHEN a.status='completed' THEN 1 ELSE 0 END) as completed FROM appointments a LEFT JOIN providers p ON a.provider_id=p.id WHERE a.start_time >= ? ${tenantFilter} GROUP BY a.provider_id`
    ).bind(...params([todayStart.slice(0, 10) + 'T00:00:00'])).all<{ name: string; total: number; completed: number }>(),
  ]);

  return c.json({
    success: true,
    data: {
      today: { date: todayStart.split('T')[0], appointments: todayAppts.results },
      upcoming: upcomingAppts.results,
      recent_cancellations: recentCancels.results,
      provider_utilization: utilization.results,
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── Scheduled Handler (Cron) ─────────────────────────────────────────────────

async function handleScheduled(env: Env): Promise<void> {
  const now = new Date();
  const windowStart = now.toISOString();
  const windowEnd = new Date(now.getTime() + 15 * 60 * 1000).toISOString(); // next 15 min window

  log('info', 'cron fired', { time: windowStart });

  // 1. Send pending reminders that are due
  const dueReminders = await env.DB.prepare(
    `SELECT r.*, a.client_email, a.client_name, a.start_time, a.id as appt_id
     FROM reminders r
     JOIN appointments a ON r.appointment_id = a.id
     WHERE r.status = 'pending' AND r.scheduled_for <= ? AND a.status IN ('scheduled','confirmed')`
  ).bind(windowEnd).all<{ id: string; appointment_id: string; type: string; client_email: string; client_name: string; start_time: string; appt_id: string }>();

  for (const reminder of dueReminders.results) {
    try {
      // Try to send via email sender binding
      await env.EMAIL_SENDER.fetch('https://echo-email-sender.bmcii1976.workers.dev/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Echo-API-Key': env.ECHO_API_KEY },
        body: JSON.stringify({
          to: reminder.client_email,
          subject: `Reminder: Your appointment on ${reminder.start_time.split('T')[0]}`,
          text: `Hi ${reminder.client_name}, this is a reminder for your appointment at ${reminder.start_time}. Reply to this email to cancel or reschedule.`,
        }),
      });
      await env.DB.prepare(`UPDATE reminders SET status='sent', sent_at=? WHERE id=?`).bind(now.toISOString(), reminder.id).run();
      log('info', 'reminder sent', { reminder_id: reminder.id, appointment_id: reminder.appointment_id });
    } catch (e) {
      await env.DB.prepare(`UPDATE reminders SET status='failed' WHERE id=?`).bind(reminder.id).run();
      log('error', 'reminder send failed', { reminder_id: reminder.id, error: String(e) });
    }
  }

  // 2. Mark past unconfirmed appointments as no-show (more than 1 hour past start)
  const noShowCutoff = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const noShows = await env.DB.prepare(
    `UPDATE appointments SET status='no_show' WHERE status='scheduled' AND end_time < ?`
  ).bind(noShowCutoff).run();

  if (noShows.changes > 0) {
    log('info', 'no-shows marked', { count: noShows.changes });
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────


app.onError((err, c) => {
  if (err.message?.includes('JSON')) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  console.error(`[echo-appointments] ${err.message}`);
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await handleScheduled(env);
  },
};
