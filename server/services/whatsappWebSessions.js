import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import WhatsAppWeb from 'whatsapp-web.js';
import { normalizeWhatsAppNumber } from '../utils/whatsappCloud.js';

const { Client, LocalAuth, MessageMedia } = WhatsAppWeb;

const truthy = (value) => String(value || '').trim().toLowerCase() === 'true';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_WEB_VERSION = '2.3000.1053021455-alpha';
const DEFAULT_WEB_VERSION_ARCHIVE = 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html';

export async function prepareWhatsAppWebVersion({ version, cachePath, archiveTemplate }) {
  if (!/^[\w.-]+$/.test(version)) throw new Error('WHATSAPP_WEB_VERSION must be a valid WhatsApp Web build identifier.');
  const cacheFile = path.join(cachePath, `${version}.html`);
  const isValidAppHtml = (html) => /<html\b[^>]*\bid\s*=\s*["']whatsapp-web["']/i.test(html)
    && !/<html\b[^>]*\bid\s*=\s*["']whatsapp-web-logged-out["']/i.test(html);

  try {
    const cachedHtml = await fs.readFile(cacheFile, 'utf8');
    if (isValidAppHtml(cachedHtml)) return cachePath;
  } catch {
    // Download the requested pinned build when there is no valid local copy.
  }

  const archiveUrl = archiveTemplate.replace('{version}', encodeURIComponent(version));
  let response;
  try {
    response = await fetch(archiveUrl, { signal: AbortSignal.timeout(20000) });
  } catch {
    throw new Error('Could not download the pinned WhatsApp Web build. Check backend internet access and retry.');
  }
  if (!response.ok) throw new Error(`Pinned WhatsApp Web build download failed (HTTP ${response.status}).`);

  const html = await response.text();
  if (html.length > 10 * 1024 * 1024 || !isValidAppHtml(html)) {
    throw new Error('The pinned WhatsApp Web build is not a valid logged-in app page; refusing to start this session.');
  }
  await fs.mkdir(cachePath, { recursive: true });
  await fs.writeFile(cacheFile, html, 'utf8');
  return cachePath;
}

function isTransientBrowserNavigationError(error) {
  const message = String(error?.message || error || '');
  return /execution context was destroyed|cannot find context with specified id|target closed|session closed|frame was detached|navigation.*interrupted|cannot read properties of null \(reading ['"]Socket['"]\)/i.test(message);
}

function shopSessionId(shopId) {
  return `shop-${crypto.createHash('sha256').update(String(shopId)).digest('hex').slice(0, 32)}`;
}

export function createWhatsAppWebSessionManager({
  env = process.env,
  dataPath = env.WHATSAPP_WEB_DATA_PATH || path.resolve(process.cwd(), '.wwebjs_auth'),
  clientFactory = async ({ clientId, dataPath: authPath, browserPath }) => {
    const webVersion = String(env.WHATSAPP_WEB_VERSION || DEFAULT_WEB_VERSION).trim();
    const webVersionArchive = String(env.WHATSAPP_WEB_VERSION_ARCHIVE || DEFAULT_WEB_VERSION_ARCHIVE).trim();
    const webVersionCachePath = await prepareWhatsAppWebVersion({
      version: webVersion,
      cachePath: path.resolve(process.cwd(), '.wwebjs_cache'),
      archiveTemplate: webVersionArchive,
    });
    const client = new Client({
      authStrategy: new LocalAuth({ clientId, dataPath: authPath }),
      webVersion,
      webVersionCache: { type: 'local', path: webVersionCachePath, strict: true },
      // The library's default UA is Chrome 101 on macOS. WhatsApp now serves a
      // logged-out landing page for that obsolete UA; let current Chrome report itself.
      userAgent: false,
      puppeteer: {
        headless: true,
        ...(browserPath ? { executablePath: browserPath } : {}),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });
    const inject = client.inject.bind(client);
    client.inject = async () => {
      for (let attempt = 0; ; attempt += 1) {
        try { return await inject(); } catch (error) {
          if (attempt >= 3 || !isTransientBrowserNavigationError(error)) throw error;
          await sleep(1500);
        }
      }
    };
    return client;
  },
  qrEncoder = (value) => QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 2, width: 320 }),
  messageMediaFactory = (mimeType, data, fileName) => new MessageMedia(mimeType, data, fileName),
  now = () => Date.now(),
} = {}) {
  const sessions = new Map();
  const invoiceSends = new Map();
  const rootPath = path.resolve(dataPath);

  const isEnabled = () => truthy(env.WHATSAPP_WEB_ENABLED);
  const sessionPath = (shopId) => path.join(rootPath, `session-${shopSessionId(shopId)}`);

  async function removeSavedProfile(shopId) {
    const profilePath = sessionPath(shopId);
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await fs.rm(profilePath, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 });
        await fs.access(profilePath).then(
          () => { throw new Error('The old WhatsApp profile is still present.'); },
          (error) => { if (error?.code !== 'ENOENT') throw error; },
        );
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(500 * (attempt + 1));
      }
    }
    throw new Error(`Could not clear the old WhatsApp profile. Close any other ElectroHub backend process and retry. ${lastError?.message || ''}`.trim());
  }

  function publicStatus(shopId, entry = sessions.get(String(shopId))) {
    if (!isEnabled()) return { enabled: false, status: 'disabled', connected: false, phoneNumber: '', qrDataUrl: '' };
    if (!entry) return { enabled: true, status: 'disconnected', connected: false, phoneNumber: '', qrDataUrl: '' };
    return {
      enabled: true,
      status: entry.status,
      connected: entry.status === 'connected',
      phoneNumber: entry.phoneNumber || '',
      qrDataUrl: entry.status === 'qr' ? entry.qrDataUrl || '' : '',
      error: entry.status === 'error' ? entry.error || 'WhatsApp could not start.' : '',
    };
  }

  function startClient(shopId) {
    const id = String(shopId);
    const existing = sessions.get(id);
    if (existing) return existing;

    const entry = {
      shopId: id,
      status: 'starting',
      phoneNumber: '',
      qrDataUrl: '',
      error: '',
      client: null,
      disconnecting: false,
      needsFreshSession: false,
    };
    sessions.set(id, entry);

    entry.startPromise = (async () => {
      let profileReset = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let client;
        try {
          client = await clientFactory({
            clientId: shopSessionId(id),
            dataPath: rootPath,
            browserPath: String(env.WHATSAPP_WEB_BROWSER_PATH || '').trim(),
            shopId: id,
          });
          entry.client = client;
          client.on('qr', async (qr) => {
            if (entry.disconnecting || entry.client !== client) return;
            try {
              entry.qrDataUrl = await qrEncoder(qr);
              if (entry.disconnecting || entry.client !== client) return;
              entry.status = 'qr';
              entry.error = '';
            } catch {
              if (entry.client !== client) return;
              entry.status = 'error';
              entry.error = 'Could not create a WhatsApp link QR code.';
            }
          });
          client.on('authenticated', () => {
            if (entry.disconnecting || entry.client !== client) return;
            entry.status = 'authenticated';
            entry.qrDataUrl = '';
            entry.error = '';
          });
          client.on('ready', () => {
            if (entry.disconnecting || entry.client !== client) return;
            entry.status = 'connected';
            entry.qrDataUrl = '';
            entry.error = '';
            entry.phoneNumber = String(client.info?.wid?.user || '');
          });
          client.on('auth_failure', () => {
            if (entry.disconnecting || entry.client !== client) return;
            entry.status = 'error';
            entry.needsFreshSession = true;
            entry.qrDataUrl = '';
            entry.error = 'WhatsApp authentication expired. Click Link WhatsApp to reset the saved session and create a fresh QR code.';
          });
          client.on('disconnected', (reason) => {
            if (entry.disconnecting || entry.client !== client) return;
            entry.status = 'disconnected';
            entry.needsFreshSession = /logout/i.test(String(reason || ''));
            entry.phoneNumber = '';
            entry.qrDataUrl = '';
            entry.error = String(reason || 'WhatsApp device disconnected.');
          });
          await client.initialize();
          entry.needsFreshSession = false;
          break;
        } catch (error) {
          // Keep the real startup failure available locally without logging
          // pairing QR values, account numbers, or authentication credentials.
          console.error(`[WhatsApp browser startup attempt ${attempt + 1}] ${error?.message || 'Unknown startup failure'}`);
          if (attempt < 2 && !entry.disconnecting && isTransientBrowserNavigationError(error)) {
            try { await client?.destroy(); } catch { /* The browser may already be closing. */ }
            if (entry.client === client) entry.client = null;
            entry.status = 'starting';
            entry.qrDataUrl = '';
            entry.error = '';
            if (attempt === 1 && !profileReset) {
              try {
                await fs.rm(sessionPath(id), { recursive: true, force: true });
                profileReset = true;
              } catch (resetError) {
                entry.status = 'error';
                entry.needsFreshSession = true;
                entry.error = `Could not reset the failed WhatsApp profile: ${resetError?.message || 'profile is locked'}`;
                break;
              }
            }
            await sleep(1000);
            continue;
          }
          entry.status = 'error';
          entry.qrDataUrl = '';
          entry.needsFreshSession = isTransientBrowserNavigationError(error);
          entry.error = entry.needsFreshSession
            ? 'The saved WhatsApp session could not be restored. Click Link WhatsApp to reset it and create a fresh QR code.'
            : error?.message || 'Could not start the WhatsApp session.';
          break;
        }
      }
      return entry;
    })();
    return entry;
  }

  async function getStatus(shopId) {
    if (!isEnabled()) return publicStatus(shopId);
    const id = String(shopId || '');
    let entry = sessions.get(id);
    if (!entry) {
      try {
        await fs.access(sessionPath(id));
        entry = startClient(id); // Restore a previously linked LocalAuth session lazily.
      } catch {
        return publicStatus(id);
      }
    }
    return publicStatus(id, entry);
  }

  async function link(shopId) {
    if (!isEnabled()) throw new Error('WhatsApp Web linking is disabled by the backend feature flag.');
    const id = String(shopId || '');
    const previous = sessions.get(id);
    if (previous?.status === 'error' || previous?.status === 'disconnected') {
      previous.disconnecting = true;
      try { await previous.client?.destroy(); } catch { /* Profile cleanup below verifies whether the browser released it. */ }
      sessions.delete(id);
      // An explicit Link action from the owner is the recovery action for a
      // failed restore. Always discard that failed LocalAuth profile so the
      // new client can emit a genuine first-pairing QR instead of reopening it.
      await removeSavedProfile(id);
    }
    const entry = startClient(id);
    return publicStatus(shopId, entry);
  }

  async function disconnect(shopId) {
    const id = String(shopId || '');
    const entry = sessions.get(id);
    if (entry) {
      entry.disconnecting = true;
      try {
        await entry.client?.logout();
      } catch {
        // Clearing the local session below still completes a disconnect.
      }
      try {
        await entry.client?.destroy();
      } catch {
        // The browser may already have exited after logout.
      }
      sessions.delete(id);
    }
    await fs.rm(sessionPath(id), { recursive: true, force: true });
    return publicStatus(id);
  }

  async function sendInvoiceDocument({ shopId, invoiceNo, to, pdf, fileName, caption = '' }) {
    if (!isEnabled()) throw new Error('WhatsApp Web invoice sending is disabled.');
    const id = String(shopId || '');
    const recipient = normalizeWhatsAppNumber(to);
    if (!recipient) throw new Error('The invoice has no valid customer WhatsApp number.');
    if (!Buffer.isBuffer(pdf) || pdf.length === 0 || pdf.length > 10 * 1024 * 1024) {
      throw new Error('Invoice PDF must be between 1 byte and 10 MiB.');
    }

    const dedupeKey = `${id}:${String(invoiceNo || '')}`;
    const recent = invoiceSends.get(dedupeKey);
    if (recent && recent.expiresAt > now()) {
      if (recent.promise) return recent.promise;
      return { ...recent.result, duplicate: true };
    }

    const safeFileName = String(fileName || `${invoiceNo || 'invoice'}.pdf`).replace(/[^\w.-]/g, '_').slice(0, 120) || 'invoice.pdf';
    const sendPromise = (async () => {
      const entry = sessions.get(id) || await getStatus(id).then(() => sessions.get(id));
      if (!entry || entry.status !== 'connected' || !entry.client) {
        throw new Error('This shop has no linked WhatsApp device. Ask the Shop Owner to link WhatsApp in Settings.');
      }
      const numberId = await entry.client.getNumberId(recipient);
      if (!numberId) throw new Error('The customer WhatsApp number is invalid or is not registered on WhatsApp.');
      const media = messageMediaFactory('application/pdf', pdf.toString('base64'), safeFileName);
      const message = await entry.client.sendMessage(numberId._serialized || `${recipient}@c.us`, media, {
        caption: String(caption || '').slice(0, 1024),
        sendMediaAsDocument: true,
      });
      return { messageId: String(message?.id?._serialized || ''), duplicate: false };
    })();
    const sendRecord = { promise: sendPromise, result: null, expiresAt: now() + 5 * 60 * 1000 };
    invoiceSends.set(dedupeKey, sendRecord);
    try {
      sendRecord.result = await sendPromise;
      sendRecord.promise = null;
      sendRecord.expiresAt = now() + 5 * 60 * 1000;
      return sendRecord.result;
    } catch (error) {
      invoiceSends.delete(dedupeKey);
      throw error;
    }
  }

  async function restorePersistedSessions(shopIds = []) {
    if (!isEnabled()) return 0;
    let restored = 0;
    for (const shopId of shopIds) {
      try {
        await fs.access(sessionPath(shopId));
        startClient(shopId);
        restored += 1;
      } catch {
        // No saved session for this shop.
      }
    }
    return restored;
  }

  async function shutdown() {
    for (const entry of sessions.values()) {
      entry.disconnecting = true;
      try { await entry.client?.destroy(); } catch { /* Preserve LocalAuth data while closing browser clients. */ }
    }
    sessions.clear();
  }

  return {
    getStatus,
    link,
    disconnect,
    sendInvoiceDocument,
    // Only metadata is returned by the API. Never expose a client, auth path, or credentials.
    restorePersistedSessions,
    shutdown,
    sessionPath,
    isEnabled,
  };
}

let activeWhatsAppWebSessionManager = createWhatsAppWebSessionManager();

export function getWhatsAppWebSessionManager() {
  return activeWhatsAppWebSessionManager;
}

export function setWhatsAppWebSessionManagerForTests(manager) {
  const previous = activeWhatsAppWebSessionManager;
  activeWhatsAppWebSessionManager = manager;
  return () => { activeWhatsAppWebSessionManager = previous; };
}
