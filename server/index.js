
import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDatabase, db } from './db.js';
import { apiRouter } from './routes/api.js';
import { hashPassword } from './middleware/auth.js';
import { startAutomationScheduler } from './services/automationScheduler.js';
import { getWhatsAppWebSessionManager } from './services/whatsappWebSessions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Trusted frontend origins.
const allowedOrigins = new Set([
  'https://electroniki.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

// Additional trusted origins can be configured through Render environment variables.
const configuredOrigins = [
  process.env.FRONTEND_URL,
  ...(process.env.FRONTEND_URLS || '').split(','),
];

for (const value of configuredOrigins) {
  if (!value || !value.trim()) continue;

  try {
    allowedOrigins.add(new URL(value.trim()).origin);
  } catch {
    console.error('Invalid frontend origin configured:', value);
  }
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Security headers.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }

    next();
  });

  // Root API health-check route.
  app.get('/', (_req, res) => {
    res.status(200).json({
      success: true,
      message: 'ElectroHub Shop Management API is running successfully.',
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  });

  // CORS configuration for the Vercel frontend and local development.
  app.use((req, res, next) => {
    const origin = req.get('Origin');

    if (!origin) {
      return next();
    }

    let parsedOrigin;

    try {
      parsedOrigin = new URL(origin);
    } catch {
      return res.status(403).json({
        error: 'Invalid request origin.',
      });
    }

    if (!['http:', 'https:'].includes(parsedOrigin.protocol)) {
      return res.status(403).json({
        error: 'Invalid request protocol.',
      });
    }

    const normalizedOrigin = parsedOrigin.origin;
    const requestHost = String(req.get('Host') || '').toLowerCase();

    // Allow either the same origin or an explicitly trusted frontend.
    const isSameOrigin =
      parsedOrigin.host.toLowerCase() === requestHost;

    const isAllowedOrigin =
      isSameOrigin || allowedOrigins.has(normalizedOrigin);

    if (!isAllowedOrigin) {
      if (req.method === 'OPTIONS') {
        return res.status(403).json({
          error: 'Cross-origin requests are not allowed.',
        });
      }

      return next();
    }

    res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization'
    );
    res.setHeader('Vary', 'Origin');

    // Handle browser CORS preflight requests.
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    next();
  });

  // Reject state-changing requests from untrusted origins.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    const origin = req.get('Origin');

    // Preserve existing behavior for requests without an Origin header.
    if (origin) {
      try {
        const parsedOrigin = new URL(origin);

        const isSameOrigin =
          parsedOrigin.host.toLowerCase() ===
          String(req.get('Host') || '').toLowerCase();

        const isAllowedOrigin =
          isSameOrigin || allowedOrigins.has(parsedOrigin.origin);

        if (
          !['http:', 'https:'].includes(parsedOrigin.protocol) ||
          !isAllowedOrigin
        ) {
          return res.status(403).json({
            error: 'Cross-origin requests are not allowed.',
          });
        }
      } catch {
        return res.status(403).json({
          error: 'Invalid request origin.',
        });
      }
    }

    next();
  });

  // Request body parsing.
  app.use(express.json({ limit: '16mb' }));
  app.use(express.urlencoded({ extended: true, limit: '12mb' }));
  app.use(cookieParser());

  // Rate limiting for authentication endpoints.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Too many authentication attempts, please try again shortly.',
    },
  });

  const passwordResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error:
        'Too many password reset requests. Please try again after 15 minutes.',
    },
  });

  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register-shop', authLimiter);
  app.use('/api/auth/forgot-password', passwordResetLimiter);
  app.use('/api/auth/reset-password', passwordResetLimiter);

  // API routes.
  app.use('/api', apiRouter);

  // Safe JSON error handler for API routes.
  app.use('/api', (err, _req, res, _next) => {
    console.error('API Error:', err?.message || err);

    res.status(err?.status || 500).json({
      error:
        err?.status >= 400 && err?.status < 500
          ? err.message
          : 'An unexpected server error occurred.',
    });
  });

  return app;
}

export async function startServer() {
  await connectDatabase();
  await ensurePlatformAdmin();

  const app = createApp();
  const port = Number(process.env.PORT || 5000);
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    const distPath = path.resolve(__dirname, '../../frontend/dist');

    app.use(express.static(distPath));

    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(
        `ElectroHub SaaS server listening on http://0.0.0.0:${port}`
      );

      console.log('Allowed frontend origins:', [
        ...allowedOrigins,
      ]);

      startAutomationScheduler();

      if (getWhatsAppWebSessionManager().isEnabled()) {
        // Restore persisted WhatsApp sessions in the background.
        db.Shop.find({})
          .then((shops) =>
            getWhatsAppWebSessionManager().restorePersistedSessions(
              shops.map((shop) => shop.id)
            )
          )
          .then((count) => {
            if (count) {
              console.log(
                `Restoring ${count} linked WhatsApp shop session(s).`
              );
            }
          })
          .catch((error) =>
            console.error(
              'WhatsApp session restore failed:',
              error?.message || error
            )
          );
      }

      resolve(server);
    });

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} is already in use. Stop the existing ElectroHub backend before starting another copy.`
          )
        );
      } else {
        reject(err);
      }
    });
  });
}

export async function ensurePlatformAdmin() {
  const email = String(process.env.SUPER_ADMIN_EMAIL || '')
    .trim()
    .toLowerCase();

  const password = String(process.env.SUPER_ADMIN_PASSWORD || '');
  const name = String(process.env.SUPER_ADMIN_NAME || '').trim();

  if (!email && !password && !name) {
    return false;
  }

  if (!email || !password || !name) {
    throw new Error(
      'Set SUPER_ADMIN_EMAIL, SUPER_ADMIN_NAME, and SUPER_ADMIN_PASSWORD together in backend/.env.'
    );
  }

  if (password.length < 12) {
    throw new Error(
      'SUPER_ADMIN_PASSWORD must be at least 12 characters long.'
    );
  }

  let platformShop = (await db.Shop.find({})).find(
    (shop) => shop.platformAdminWorkspace === true
  );

  if (!platformShop) {
    platformShop = await db.Shop.create({
      name: 'Platform Administration',
      platformAdminWorkspace: true,
      receiptFooter: '',
      invoicePrefix: 'SYS',
      currency: 'PKR',
      openingCash: 0,
    });
  }

  const passwordHash = await hashPassword(password);
  const existing = await db.User.findOne({ email });

  if (existing) {
    if (existing.role === 'super_admin') {
      return false;
    }

    if (
      String(process.env.SUPER_ADMIN_PROMOTE_EXISTING || '').toLowerCase() !==
      'true'
    ) {
      throw new Error(
        'SUPER_ADMIN_EMAIL is already assigned to a non-platform user. Set SUPER_ADMIN_PROMOTE_EXISTING=true only if this account should become the platform Super Admin.'
      );
    }

    await db.User.updateOne(
      { _id: existing.id },
      {
        shopId: platformShop.id,
        name,
        passwordHash,
        role: 'super_admin',
        active: true,
      }
    );

    console.info('Existing account promoted to Platform Super Admin.');

    return true;
  }

  await db.User.create({
    shopId: platformShop.id,
    name,
    email,
    passwordHash,
    role: 'super_admin',
    active: true,
  });

  console.info('Platform Super Admin bootstrap completed.');

  return true;
}

// Start server if invoked directly or via server.ts.
if (
  process.argv[1] &&
  (
    process.argv[1].replace(/\\/g, '/').endsWith('server/index.js') ||
    process.argv[1].endsWith('server.ts') ||
    process.argv[1].endsWith('server.js')
  )
) {
  startServer().catch(async (err) => {
    console.error('Server startup failed:', err.message);

    await mongoose.disconnect();

    process.exitCode = 1;
  });
}