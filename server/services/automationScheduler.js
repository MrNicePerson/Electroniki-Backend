import mongoose from 'mongoose';
import { db } from '../db.js';
import { normalizeWhatsAppNumber } from '../utils/whatsappPhone.js';
import { whatsappService } from './whatsappService.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const REMINDER_MESSAGE_DELAY_MS = 5 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let schedulerTimer = null;
let cycleRunning = false;

function pakistanDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map(({ type, value }) => [type, value]));
}

function normalizedRecipients(values = []) {
  return [...new Set(values.map(normalizeWhatsAppNumber).filter(Boolean))].slice(0, 2);
}

async function processLowStockAlerts(shop, products, dateKey, hour) {
  const automation = shop.automation || {};
  const recipients = normalizedRecipients(automation.lowStockRecipients || []);
  if (!automation.lowStockAlertsEnabled || recipients.length === 0 || hour !== '08') return;

  const lowStockProducts = products.filter((product) =>
    Number(product.stock || 0) <= Number(product.reorderThreshold ?? 5)
  );
  if (!lowStockProducts.length) return;

  // Claim one daily digest for the shop before sending, so Render restarts or
  // multiple instances cannot send another batch on the same Pakistan date.
  const previousAlertDate = shop.lastLowStockAlertDate || '';
  const claimFilter = { _id: shop.id };
  claimFilter.$or = previousAlertDate
    ? [{ lastLowStockAlertDate: previousAlertDate }]
    : [{ lastLowStockAlertDate: '' }, { lastLowStockAlertDate: { $exists: false } }];
  const claim = await db.Shop.updateOne(claimFilter, { lastLowStockAlertDate: dateKey });
  if (!claim || claim.lastLowStockAlertDate !== dateKey) return;

  for (const [index, recipient] of recipients.entries()) {
    if (index > 0) await sleep(REMINDER_MESSAGE_DELAY_MS);
    const listedProducts = lowStockProducts;
    const lines = listedProducts.map((product) => {
      const stock = Number(product.stock || 0);
      const threshold = Number(product.reorderThreshold ?? 5);
      return `• ${product.name}${product.code ? ` (${product.code})` : ''} — stock ${stock}, reorder at ${threshold}`;
    });
    const message = [`Daily low-stock summary - ${shop.name}`, ...lines, 'Please arrange restocking.'].join('\n');

    try {
      await whatsappService.sendTextMessage({ shopId: shop.id, to: recipient, text: message });
    } catch (error) {
      console.error(`Daily low-stock WhatsApp digest failed for shop ${shop.id}:`, error.message);
    }
  }
}

async function processInstallmentReminders(shop, plans, paidPlanIdsThisMonth, dateKey, monthKey, hour) {
  if (!shop.automation?.installmentRemindersEnabled) return;
  let attempted = 0;

  for (const plan of plans) {
    if (!shouldSendInstallmentReminder(plan, dateKey, monthKey, hour, paidPlanIdsThisMonth.has(String(plan.id)))) continue;
    const recipient = normalizeWhatsAppNumber(plan.whatsapp || plan.phone);
    if (!recipient) continue;

    // Claim the date before sending. Render may run more than one server
    // instance, so a post-send update alone can let both instances send.
    const previousReminderDate = plan.lastWhatsAppReminderDate || '';
    const claimedPlan = await db.InstallmentPlan.updateOne(
      { _id: plan.id, shopId: shop.id, lastWhatsAppReminderDate: previousReminderDate },
      { lastWhatsAppReminderDate: dateKey, lastWhatsAppReminderMonth: monthKey }
    );
    if (!claimedPlan || claimedPlan.lastWhatsAppReminderDate !== dateKey) continue;

    if (attempted > 0) await sleep(REMINDER_MESSAGE_DELAY_MS);
    attempted += 1;

    const customerName = String(plan.customerName || 'Customer').trim();
    const dueAmount = Number(plan.monthlyAmount || plan.balance || 0).toLocaleString('en-PK');
    const remainingBalance = Number(plan.balance || 0).toLocaleString('en-PK');
    const message = [
      `Assalam-o-Alaikum ${customerName},`,
      `Aapki ${shop.name} installment qist Rs. ${dueAmount} ki due date ${plan.nextDueDate} hai.`,
      `Baqaya balance: Rs. ${remainingBalance}.`,
      'Meherbani karke payment jama karwa dein. Agar aap payment kar chuke hain to is paigham ko nazar-andaz karein.',
      `Thank you — ${shop.name}`,
    ].join('\n');

    try {
      await whatsappService.sendTextMessage({ shopId: shop.id, to: recipient, text: message });
    } catch (error) {
      console.error(`Installment WhatsApp reminder failed for plan ${plan.planNo}:`, error.message);
    }
  }
}

export function shouldSendInstallmentReminder(plan, dateKey, monthKey, hour, paymentRecordedThisMonth = false) {
  if (hour !== '08') return false;
  if (paymentRecordedThisMonth) return false;
  if (Number(plan.balance || 0) <= 0 || !plan.whatsappReminderEnabled || !plan.whatsappReminderConsent) return false;
  if (!plan.nextDueDate || plan.nextDueDate === 'Completed' || plan.nextDueDate > dateKey) return false;
  if (plan.lastWhatsAppReminderDate === dateKey) return false;
  if (plan.lastInstallmentPaymentAt) {
    const paymentDate = pakistanDateParts(new Date(plan.lastInstallmentPaymentAt));
    if (`${paymentDate.year}-${paymentDate.month}` === monthKey) return false;
  }
  return true;
}

export async function runAutomationCycle(now = new Date()) {
  if (mongoose.connection.readyState !== 1 || cycleRunning) return;
  cycleRunning = true;
  try {
    const { year, month, day, hour } = pakistanDateParts(now);
    const dateKey = `${year}-${month}-${day}`;
    const monthKey = `${year}-${month}`;
    const shops = await db.Shop.find({});

    for (const shop of shops) {
      const [products, plans, payments] = await Promise.all([
        db.Product.find({ shopId: shop.id }),
        db.InstallmentPlan.find({ shopId: shop.id }),
        db.InstallmentPayment.find({ shopId: shop.id }),
      ]);
      const paidPlanIdsThisMonth = new Set(payments
        .filter((payment) => payment.createdAt && (() => {
          const paymentDate = pakistanDateParts(new Date(payment.createdAt));
          return `${paymentDate.year}-${paymentDate.month}` === monthKey;
        })())
        .map((payment) => String(payment.planId)));
      await processLowStockAlerts(shop, products, dateKey, hour);
      await processInstallmentReminders(shop, plans, paidPlanIdsThisMonth, dateKey, monthKey, hour);
    }
  } finally {
    cycleRunning = false;
  }
}

export function startAutomationScheduler() {
  if (schedulerTimer) return schedulerTimer;
  const run = () => runAutomationCycle().catch((error) => {
    console.error('WhatsApp automation cycle failed:', error.message);
  });
  void run();
  schedulerTimer = setInterval(run, POLL_INTERVAL_MS);
  schedulerTimer.unref?.();
  return schedulerTimer;
}
