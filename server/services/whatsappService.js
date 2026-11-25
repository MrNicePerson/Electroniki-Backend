import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import { formatWhatsAppJid } from '../utils/whatsappPhone.js';
import { listSavedWhatsAppShopIds, useMongoAuthState } from './whatsappAuthState.js';

const reconnectDelayMs = 3000;
const messageDedupeMs = 5 * 60 * 1000;
const connectionWaitTimeoutMs = 20000;

export function createWhatsAppService({
  socketFactory = makeWASocket,
  authStateFactory = useMongoAuthState,
  listSavedShopIds = listSavedWhatsAppShopIds,
  qrEncoder = (qr) => QRCode.toDataURL(qr),
  logger = pino({ level: 'silent' }),
  reconnectDelay = reconnectDelayMs,
} = {}) {
  const sessions = new Map();
  const sentInvoices = new Map();

  function publicStatus(shopId, entry = sessions.get(String(shopId))) {
    if (!entry) {
      return { status: 'not_linked', connected: false, qrDataUrl: null, phoneNumber: null, error: null };
    }
    return {
      status: entry.status,
      connected: entry.status === 'connected',
      qrDataUrl: entry.qrDataUrl || null,
      phoneNumber: entry.phoneNumber || null,
      error: entry.error || null,
    };
  }

  function setState(entry, status, error = null) {
    entry.status = status;
    entry.error = error ? String(error.message || error) : null;
    if (status !== 'qr_ready') entry.qrDataUrl = null;
    if (status !== 'connected') entry.phoneNumber = null;
  }

  function createEntry(shopId) {
    return {
      shopId: String(shopId),
      status: 'connecting',
      connected: false,
      qrDataUrl: null,
      phoneNumber: null,
      error: null,
      socket: null,
      authStore: null,
      reconnectTimer: null,
      manuallyDisconnected: false,
      startPromise: null,
    };
  }

  async function startSocket(entry) {
    if (entry.manuallyDisconnected || sessions.get(entry.shopId) !== entry) return;
    setState(entry, 'connecting');
    try {
      const authStore = await authStateFactory(entry.shopId);
      if (entry.manuallyDisconnected || sessions.get(entry.shopId) !== entry) return;
      entry.authStore = authStore;
      const socket = socketFactory({
        auth: authStore.state,
        logger,
        printQRInTerminal: false,
        browser: ['Electroniki', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false,
      });
      entry.socket = socket;

      socket.ev.on('creds.update', (update) => {
        void authStore.saveCreds(update).catch((error) => {
          console.error(`WhatsApp credentials could not be saved for shop ${entry.shopId}:`, error?.message || error);
        });
      });
      socket.ev.on('connection.update', (update) => {
        void handleConnectionUpdate(entry, socket, update).catch((error) => {
          console.error(`WhatsApp connection update failed for shop ${entry.shopId}:`, error?.message || error);
        });
      });
    } catch (error) {
      if (sessions.get(entry.shopId) !== entry || entry.manuallyDisconnected) return;
      setState(entry, 'not_linked', error);
      console.error(`WhatsApp could not start for shop ${entry.shopId}:`, error?.message || error);
    }
  }

  async function handleConnectionUpdate(entry, socket, update = {}) {
    if (sessions.get(entry.shopId) !== entry || entry.socket !== socket || entry.manuallyDisconnected) return;
    if (update.qr) {
      setState(entry, 'connecting');
      try {
        const qrDataUrl = await qrEncoder(update.qr);
        if (sessions.get(entry.shopId) !== entry || entry.socket !== socket || entry.manuallyDisconnected) return;
        entry.qrDataUrl = qrDataUrl;
        entry.status = 'qr_ready';
        entry.error = null;
      } catch (error) {
        setState(entry, 'not_linked', error);
        console.error(`WhatsApp QR generation failed for shop ${entry.shopId}:`, error?.message || error);
      }
    }

    if (update.connection === 'open') {
      entry.qrDataUrl = null;
      entry.status = 'connected';
      entry.phoneNumber = String(socket.user?.id || '').split('@')[0].split(':')[0] || null;
      entry.error = null;
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }

    if (update.connection === 'close') {
      entry.socket = null;
      entry.qrDataUrl = null;
      const disconnectError = update.lastDisconnect?.error;
      const statusCode = disconnectError?.output?.statusCode
        ?? (disconnectError ? new Boom(disconnectError).output.statusCode : null);
      if (statusCode === DisconnectReason.loggedOut) {
        if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = null;
        try { await (entry.authStore || await authStateFactory(entry.shopId)).clearState(); } catch (error) {
          console.error(`WhatsApp auth state could not be cleared for shop ${entry.shopId}:`, error?.message || error);
        }
        setState(entry, 'not_linked', 'WhatsApp logged out. Link the device again to reconnect.');
        return;
      }

      setState(entry, 'connecting', disconnectError || null);
      if (!entry.reconnectTimer) {
        entry.reconnectTimer = setTimeout(() => {
          entry.reconnectTimer = null;
          if (sessions.get(entry.shopId) === entry && !entry.manuallyDisconnected) {
            void startSocket(entry);
          }
        }, reconnectDelay);
        entry.reconnectTimer.unref?.();
      }
    }
  }

  async function ensureSession(shopId) {
    const id = String(shopId || '').trim();
    if (!id) throw new Error('Shop ID is required to connect WhatsApp.');
    let entry = sessions.get(id);
    if (!entry) {
      entry = createEntry(id);
      sessions.set(id, entry);
      entry.startPromise = startSocket(entry);
      await entry.startPromise;
    } else if (entry.status === 'not_linked' && !entry.socket && !entry.manuallyDisconnected) {
      entry.manuallyDisconnected = false;
      setState(entry, 'connecting');
      entry.startPromise = startSocket(entry);
      await entry.startPromise;
    }
    return entry;
  }

  async function ensureConnectedSession(shopId) {
    const entry = await ensureSession(shopId);
    const deadline = Date.now() + connectionWaitTimeoutMs;
    while (Date.now() < deadline) {
      if (sessions.get(entry.shopId) !== entry) {
        throw new Error('WhatsApp session changed while reconnecting. Try again.');
      }
      if (entry.status === 'connected' && entry.socket) return entry;
      if (entry.status === 'qr_ready') {
        throw new Error('This shop WhatsApp session needs linking. Scan the QR code in Settings.');
      }
      if (entry.status === 'not_linked' && !entry.socket) {
        throw new Error(entry.error || 'This shop has no linked WhatsApp device. Link WhatsApp in Settings.');
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('WhatsApp is still reconnecting on this server. Try sending again shortly.');
  }

  async function getStatus(shopId) {
    const id = String(shopId || '').trim();
    if (!id) return publicStatus(id);
    const existing = sessions.get(id);
    if (existing) return publicStatus(id, existing);
    try {
      const saved = await authStateFactory(id);
      if (!saved.state.creds.registered) return publicStatus(id);
      const entry = createEntry(id);
      sessions.set(id, entry);
      entry.startPromise = startSocket(entry);
      await entry.startPromise;
      return publicStatus(id, entry);
    } catch (error) {
      return { ...publicStatus(id), error: String(error?.message || error) };
    }
  }

  async function link(shopId) {
    const entry = await ensureSession(shopId);
    return publicStatus(shopId, entry);
  }

  async function disconnect(shopId) {
    const id = String(shopId || '').trim();
    if (!id) return publicStatus(id);
    const entry = sessions.get(id);
    if (entry) {
      entry.manuallyDisconnected = true;
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
      sessions.delete(id);
      try { await entry.socket?.logout(); } catch { /* Auth state is cleared below even if the socket has already closed. */ }
      try { await entry.socket?.end(new Error('WhatsApp device disconnected by the shop owner.')); } catch { /* Socket may already be closed. */ }
    }
    try {
      await (entry?.authStore || await authStateFactory(id)).clearState();
    } catch (error) {
      console.error(`WhatsApp auth state could not be cleared for shop ${id}:`, error?.message || error);
      throw new Error('Could not clear this shop’s WhatsApp session from MongoDB.');
    }
    return publicStatus(id);
  }

  async function sendTextMessage({ shopId, to, text }) {
    const entry = await ensureConnectedSession(shopId);
    const jid = formatWhatsAppJid(to);
    if (!jid) throw new Error('Recipient WhatsApp number is invalid.');
    return entry.socket.sendMessage(jid, { text: String(text || '') });
  }

  async function sendInvoiceDocument({ shopId, invoiceNo, to, pdf, fileName, caption = '' }) {
    if (!Buffer.isBuffer(pdf) || !pdf.length || pdf.length > 10 * 1024 * 1024) {
      throw new Error('Invoice PDF must be between 1 byte and 10 MiB.');
    }
    const id = String(shopId || '');
    const dedupeKey = `${id}:${String(invoiceNo || '')}`;
    const previous = sentInvoices.get(dedupeKey);
    if (previous && previous.expiresAt > Date.now()) return previous.promise;
    const entry = await ensureConnectedSession(id);
    const jid = formatWhatsAppJid(to);
    if (!jid) throw new Error('Customer WhatsApp number is invalid.');
    const safeName = String(fileName || `${invoiceNo || 'invoice'}.pdf`).replace(/[^\w.-]/g, '_').slice(0, 120) || 'invoice.pdf';
    const promise = entry.socket.sendMessage(jid, {
      document: pdf,
      mimetype: 'application/pdf',
      fileName: safeName,
      caption: String(caption || '').slice(0, 1024),
    });
    sentInvoices.set(dedupeKey, { promise, expiresAt: Date.now() + messageDedupeMs });
    try {
      const result = await promise;
      sentInvoices.set(dedupeKey, { promise: Promise.resolve(result), expiresAt: Date.now() + messageDedupeMs });
      return result;
    } catch (error) {
      sentInvoices.delete(dedupeKey);
      throw error;
    }
  }

  async function restoreSavedSessions(shopIds) {
    const ids = shopIds || await listSavedShopIds();
    let started = 0;
    for (const shopId of ids) {
      try {
        const authStore = await authStateFactory(shopId);
        if (!authStore.state.creds.registered) continue;
        const entry = await ensureSession(shopId);
        if (entry.status !== 'not_linked') started += 1;
      } catch (error) {
        console.error(`WhatsApp saved session restore failed for shop ${shopId}:`, error?.message || error);
      }
    }
    return started;
  }

  async function shutdown() {
    const entries = [...sessions.values()];
    sessions.clear();
    for (const entry of entries) {
      entry.manuallyDisconnected = true;
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      try { await entry.socket?.end(new Error('Backend is shutting down.')); } catch { /* Preserve MongoDB auth state for restart. */ }
    }
  }

  return { getStatus, link, disconnect, sendTextMessage, sendInvoiceDocument, restoreSavedSessions, shutdown };
}

export let whatsappService = createWhatsAppService();

export function setWhatsAppServiceForTests(service) {
  const previous = whatsappService;
  whatsappService = service;
  return () => { whatsappService = previous; };
}
