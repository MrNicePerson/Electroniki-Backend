import mongoose from 'mongoose';

const whatsappAuthSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  value: { type: String, required: true },
}, { versionKey: false });

export const WhatsAppAuth = mongoose.models.WhatsAppAuth
  || mongoose.model('WhatsAppAuth', whatsappAuthSchema);
