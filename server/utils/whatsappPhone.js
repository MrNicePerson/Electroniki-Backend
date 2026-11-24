export function normalizeWhatsAppNumber(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('03')) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith('3')) digits = `92${digits}`;
  return /^\d{7,15}$/.test(digits) ? digits : '';
}

export function formatWhatsAppJid(phone) {
  const digits = normalizeWhatsAppNumber(phone);
  return digits ? `${digits}@s.whatsapp.net` : '';
}
