import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { WhatsAppAuth } from '../models/whatsappAuth.js';

const shopPrefix = (shopId) => `shop:${encodeURIComponent(String(shopId))}:`;
const credsKey = (shopId) => `${shopPrefix(shopId)}creds`;
const serialize = (value) => JSON.stringify(value, BufferJSON.replacer);
const deserialize = (value) => JSON.parse(value, BufferJSON.reviver);

export async function useMongoAuthState(shopId) {
  const prefix = shopPrefix(shopId);
  const savedCreds = await WhatsAppAuth.findOne({ key: credsKey(shopId) }).lean();
  const creds = savedCreds?.value ? deserialize(savedCreds.value) : initAuthCreds();

  const keys = {
    async get(type, ids) {
      if (!ids.length) return {};
      const rows = await WhatsAppAuth.find({
        key: { $in: ids.map((id) => `${prefix}key:${type}:${encodeURIComponent(id)}`) },
      }).lean();
      const values = {};
      for (const row of rows) {
        const id = decodeURIComponent(row.key.slice(`${prefix}key:${type}:`.length));
        const value = deserialize(row.value);
        values[id] = type === 'app-state-sync-key' && value
          ? proto.Message.AppStateSyncKeyData.fromObject(value)
          : value;
      }
      return values;
    },
    async set(data) {
      const writes = [];
      const removals = [];
      for (const [type, entries] of Object.entries(data || {})) {
        for (const [id, value] of Object.entries(entries || {})) {
          const key = `${prefix}key:${type}:${encodeURIComponent(id)}`;
          if (value === null) {
            removals.push(key);
          } else {
            writes.push({
              updateOne: {
                filter: { key },
                update: { $set: { value: serialize(value) } },
                upsert: true,
              },
            });
          }
        }
      }
      if (writes.length) await WhatsAppAuth.bulkWrite(writes, { ordered: false });
      if (removals.length) await WhatsAppAuth.deleteMany({ key: { $in: removals } });
    },
    async clear() {
      await WhatsAppAuth.deleteMany({ key: { $regex: `^${escapeRegex(prefix)}` } });
    },
  };

  return {
    state: { creds, keys },
    async saveCreds(update = {}) {
      Object.assign(creds, update || {});
      await WhatsAppAuth.updateOne(
        { key: credsKey(shopId) },
        { $set: { value: serialize(creds) } },
        { upsert: true },
      );
    },
    async clearState() {
      await WhatsAppAuth.deleteMany({ key: { $regex: `^${escapeRegex(prefix)}` } });
    },
  };
}

export async function listSavedWhatsAppShopIds() {
  const rows = await WhatsAppAuth.find({ key: /^shop:.+:creds$/ }).select({ key: 1, _id: 0 }).lean();
  return [...new Set(rows.map(({ key }) => decodeURIComponent(key.slice(5, -6))))];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
