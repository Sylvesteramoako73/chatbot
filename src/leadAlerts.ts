import type { Business } from "./businesses";
import type { Conversation } from "./conversations";
import type { CapturedLead } from "./chat";
import {
  applyCapturedLeadDetails,
  claimClientConfirmation,
  claimLeadAlert,
  getLeadAlertState,
  Lead,
  LeadAlertState,
} from "./leads";
import { listTeamMembers } from "./auth";
import { sendPushToTeamMember } from "./push";
import { sendEmail } from "./email";
import { sendSms, parsePhoneList, normalisePhone } from "./sms";

const CHANNEL_LABELS: Record<string, string> = {
  widget: "website chat",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Never more than one sales alert per lead in this window, whatever the chat does. */
export const ALERT_THROTTLE_MS = 2 * HOUR;
/** A lead showing interest again after this long is worth a fresh alert even for the same project. */
export const RETURNING_AFTER_MS = 7 * DAY;
/** Clients get at most one confirmation in this window. */
export const CLIENT_CONFIRMATION_GAP_MS = DAY;

function dashboardUrl(conversationId: string): string {
  const base = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  return `${base}/dashboard/index.html?conversation=${conversationId}`;
}

function parseEmailList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[,\n;\s]+/).map((e) => e.trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
}

function firstName(name: string | null): string {
  return (name ?? "").trim().split(/\s+/)[0] || "there";
}

/** Keeps an SMS to at most two parts (306 chars for GSM text) so a long note can't run up costs. */
function capSms(text: string, max = 306): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
}

function normaliseInterest(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** "Serenity Estate" and "the Serenity Estate villas" count as the same project; Springfield doesn't. */
export function sameInterest(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normaliseInterest(a);
  const y = normaliseInterest(b);
  if (!x || !y) return x === y;
  return x === y || x.includes(y) || y.includes(x);
}

export type AlertReason = "new" | "new_interest" | "new_contact" | "returning";

export interface AlertDecision {
  alertSales: boolean;
  reason: AlertReason | null;
  previousInterest: string | null;
  confirmClient: boolean;
}

/**
 * The rules, kept pure so they can be tested on their own:
 * - first time a lead is complete: alert;
 * - otherwise, at most once every 2 hours, alert when they ask about a different project, give a
 *   different phone/email, or come back more than 7 days after their last alert;
 * - confirm to the client only for a first contact or a new project, and at most once a day.
 */
export function decideLeadAlert(
  state: LeadAlertState,
  lead: Pick<Lead, "phone" | "email">,
  captured: CapturedLead,
  now: Date = new Date()
): AlertDecision {
  const previousInterest = state.lastAlertInterest;

  if (!state.alertedAt) {
    return { alertSales: true, reason: "new", previousInterest: null, confirmClient: confirmAllowed(state, now) };
  }

  const sinceAlert = now.getTime() - new Date(state.alertedAt).getTime();
  const newInterest = !!captured.interest && !sameInterest(captured.interest, previousInterest);
  const phoneChanged =
    !!lead.phone && !!state.lastAlertPhone && normalisePhone(lead.phone) !== normalisePhone(state.lastAlertPhone);
  const emailChanged =
    !!lead.email && !!state.lastAlertEmail && lead.email.toLowerCase() !== state.lastAlertEmail.toLowerCase();
  const returning = sinceAlert > RETURNING_AFTER_MS;

  if (sinceAlert < ALERT_THROTTLE_MS) {
    return { alertSales: false, reason: null, previousInterest, confirmClient: false };
  }

  const reason: AlertReason | null = newInterest
    ? "new_interest"
    : phoneChanged || emailChanged
      ? "new_contact"
      : returning
        ? "returning"
        : null;

  return {
    alertSales: reason !== null,
    reason,
    previousInterest,
    confirmClient: reason === "new_interest" && confirmAllowed(state, now),
  };
}

function confirmAllowed(state: LeadAlertState, now: Date): boolean {
  if (!state.lastClientConfirmationAt) return true;
  return now.getTime() - new Date(state.lastClientConfirmationAt).getTime() >= CLIENT_CONFIRMATION_GAP_MS;
}

export function salesAlertSms(
  lead: Lead,
  captured: CapturedLead,
  channel: string,
  reason: AlertReason = "new",
  previousInterest: string | null = null
): string {
  const contact = [lead.phone, lead.email].filter(Boolean).join(", ");
  const parts: string[] = [];
  if (reason === "new") {
    parts.push(`New lead: ${lead.name}, ${contact}`);
    if (captured.interest) parts.push(`Interested in ${captured.interest}${captured.unit ? `, ${captured.unit}` : ""}`);
  } else {
    parts.push(`Returning lead: ${lead.name}, ${contact}`);
    if (reason === "new_interest" && captured.interest) {
      const before = previousInterest ? ` (before: ${previousInterest})` : "";
      parts.push(`Now asking about ${captured.interest}${captured.unit ? `, ${captured.unit}` : ""}${before}`);
    } else {
      if (captured.interest) parts.push(`Interested in ${captured.interest}${captured.unit ? `, ${captured.unit}` : ""}`);
      if (reason === "new_contact") parts.push("New contact details");
      if (reason === "returning") parts.push("Back after more than a week");
    }
  }
  if (captured.location) parts.push(`Location: ${captured.location}`);
  if (captured.preferredTime) parts.push(`Prefers ${captured.preferredTime}`);
  parts.push(`Via ${CHANNEL_LABELS[channel] ?? channel}.`);
  return capSms(parts.join(". "));
}

export function clientConfirmationSms(lead: Lead, captured: CapturedLead, businessName: string): string {
  const greeting = `Hi ${firstName(lead.name)}, thank you for your interest${captured.interest ? ` in ${captured.interest}` : ""}.`;
  const about = captured.unit ? ` about the ${captured.unit}` : "";
  return capSms(`${greeting} Our sales team will contact you shortly${about}. ${businessName}`);
}

function salesAlertEmail(
  lead: Lead,
  captured: CapturedLead,
  conversation: Conversation,
  reason: AlertReason,
  previousInterest: string | null
): { subject: string; body: string } {
  const lines = [
    reason === "new" ? undefined : `This is a returning lead${previousInterest ? `, previously interested in ${previousInterest}` : ""}.\n`,
    `Name: ${lead.name ?? ""}`,
    lead.phone && `Phone: ${lead.phone}`,
    lead.email && `Email: ${lead.email}`,
    captured.interest && `Interested in: ${captured.interest}`,
    captured.unit && `Unit: ${captured.unit}`,
    captured.location && `Location: ${captured.location}`,
    captured.preferredTime && `Preferred time: ${captured.preferredTime}`,
    `Channel: ${CHANNEL_LABELS[conversation.channel] ?? conversation.channel}`,
    lead.notes ? `\nEnquiry history:\n${lead.notes}` : undefined,
    "",
    `Open the conversation: ${dashboardUrl(conversation.id)}`,
  ].filter((l): l is string => typeof l === "string");
  const label = reason === "new" ? "New lead" : "Returning lead";
  return {
    subject: `${label}: ${lead.name}${captured.interest ? ` (${captured.interest})` : ""}`,
    body: lines.join("\n"),
  };
}

function clientConfirmationEmail(lead: Lead, captured: CapturedLead, businessName: string): { subject: string; body: string } {
  const interest = captured.interest ? ` in ${captured.interest}` : "";
  const about = captured.unit ? ` about the ${captured.unit}` : "";
  return {
    subject: `Thank you for contacting ${businessName}`,
    body:
      `Hi ${firstName(lead.name)},\n\n` +
      `Thank you for your interest${interest}. We have received your details and a member of our sales team will contact you shortly${about}.\n\n` +
      `If anything changes in the meantime, just send us a message in the chat.\n\n` +
      `Warm regards,\n${businessName}`,
  };
}

/**
 * Called after every bot reply that carried a lead tag. Always saves the captured details; whether
 * anyone is alerted is decided by decideLeadAlert(), and claimed atomically so the same alert can
 * never go out twice. Best-effort throughout: a failed SMS or email never breaks the chat itself.
 */
export async function handleCapturedLead(
  business: Business,
  conversation: Conversation,
  captured: CapturedLead
): Promise<void> {
  try {
    if (!conversation.leadId) return;
    const lead = await applyCapturedLeadDetails(conversation.leadId, captured);
    if (!lead.name || !(lead.phone || lead.email)) return;

    const state = await getLeadAlertState(lead.id);
    const decision = decideLeadAlert(state, lead, captured);
    if (!decision.alertSales || !decision.reason) return;

    const claimed = await claimLeadAlert(lead.id, state.alertedAt, {
      interest: captured.interest ?? null,
      phone: lead.phone,
      email: lead.email,
    });
    if (!claimed) return;

    const team = await listTeamMembers(business.id);
    const salesPhones = parsePhoneList(business.alertPhones);
    const configuredEmails = parseEmailList(business.alertEmails);
    const salesEmails = configuredEmails.length ? configuredEmails : team.map((m) => m.email);
    const email = salesAlertEmail(lead, captured, conversation, decision.reason, decision.previousInterest);

    const tasks: Promise<unknown>[] = [
      salesPhones.length
        ? sendSms(
            salesPhones,
            salesAlertSms(lead, captured, conversation.channel, decision.reason, decision.previousInterest),
            business.smsSenderId
          )
        : Promise.resolve(),
      ...salesEmails.map((to) => sendEmail(to, email.subject, email.body)),
      ...team.map((m) =>
        sendPushToTeamMember(m.id, {
          title: email.subject,
          body: [lead.phone, lead.email, captured.interest].filter(Boolean).join(" | "),
          conversationId: conversation.id,
        })
      ),
    ];

    if (
      business.clientConfirmationEnabled &&
      decision.confirmClient &&
      (await claimClientConfirmation(lead.id, state.lastClientConfirmationAt))
    ) {
      if (lead.phone) tasks.push(sendSms([lead.phone], clientConfirmationSms(lead, captured, business.name), business.smsSenderId));
      if (lead.email) {
        const confirm = clientConfirmationEmail(lead, captured, business.name);
        tasks.push(sendEmail(lead.email, confirm.subject, confirm.body));
      }
    }

    const results = await Promise.allSettled(tasks);
    for (const r of results) if (r.status === "rejected") console.error("Lead alert delivery failed:", r.reason);
  } catch (err) {
    console.error("handleCapturedLead failed:", err);
  }
}
