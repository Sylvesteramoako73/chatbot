import type { Business } from "./businesses";
import type { Conversation } from "./conversations";
import type { CapturedLead } from "./chat";
import { applyCapturedLeadDetails, claimLeadAlert, Lead } from "./leads";
import { listTeamMembers } from "./auth";
import { sendPushToTeamMember } from "./push";
import { sendEmail } from "./email";
import { sendSms, parsePhoneList } from "./sms";

const CHANNEL_LABELS: Record<string, string> = {
  widget: "website chat",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
};

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

export function salesAlertSms(lead: Lead, captured: CapturedLead, channel: string): string {
  const contact = [lead.phone, lead.email].filter(Boolean).join(", ");
  const parts = [`New lead: ${lead.name}, ${contact}`];
  if (captured.interest) parts.push(`Interested in ${captured.interest}`);
  if (captured.location) parts.push(`Location: ${captured.location}`);
  if (captured.preferredTime) parts.push(`Prefers ${captured.preferredTime}`);
  parts.push(`Via ${CHANNEL_LABELS[channel] ?? channel}. See the dashboard for the chat.`);
  return capSms(parts.join(". "));
}

export function clientConfirmationSms(lead: Lead, captured: CapturedLead, businessName: string): string {
  const interest = captured.interest ? ` in ${captured.interest}` : "";
  return capSms(
    `Hi ${firstName(lead.name)}, thank you for your interest${interest}. Our sales team will contact you shortly. ${businessName}`
  );
}

function salesAlertEmail(lead: Lead, captured: CapturedLead, conversation: Conversation): { subject: string; body: string } {
  const lines = [
    `Name: ${lead.name ?? ""}`,
    lead.phone && `Phone: ${lead.phone}`,
    lead.email && `Email: ${lead.email}`,
    captured.interest && `Interested in: ${captured.interest}`,
    captured.location && `Location: ${captured.location}`,
    captured.preferredTime && `Preferred time: ${captured.preferredTime}`,
    `Channel: ${CHANNEL_LABELS[conversation.channel] ?? conversation.channel}`,
    "",
    `Open the conversation: ${dashboardUrl(conversation.id)}`,
  ].filter((l): l is string => typeof l === "string");
  return {
    subject: `New lead: ${lead.name}${captured.interest ? ` (${captured.interest})` : ""}`,
    body: lines.join("\n"),
  };
}

function clientConfirmationEmail(lead: Lead, captured: CapturedLead, businessName: string): { subject: string; body: string } {
  const interest = captured.interest ? ` in ${captured.interest}` : "";
  return {
    subject: `Thank you for contacting ${businessName}`,
    body:
      `Hi ${firstName(lead.name)},\n\n` +
      `Thank you for your interest${interest}. We have received your details and a member of our sales team will contact you shortly.\n\n` +
      `If anything changes in the meantime, just send us a message in the chat.\n\n` +
      `Warm regards,\n${businessName}`,
  };
}

/**
 * Called after every bot reply that carried a lead tag. Always saves the captured details; the
 * alerts only fire once per lead (claimLeadAlert), and only once the lead has a name plus a phone
 * number or email. Best-effort throughout — a failed SMS or email never breaks the chat itself.
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
    if (!(await claimLeadAlert(lead.id))) return;

    const team = await listTeamMembers(business.id);
    const salesPhones = parsePhoneList(business.alertPhones);
    const configuredEmails = parseEmailList(business.alertEmails);
    const salesEmails = configuredEmails.length ? configuredEmails : team.map((m) => m.email);
    const email = salesAlertEmail(lead, captured, conversation);

    const tasks: Promise<unknown>[] = [
      salesPhones.length ? sendSms(salesPhones, salesAlertSms(lead, captured, conversation.channel), business.smsSenderId) : Promise.resolve(),
      ...salesEmails.map((to) => sendEmail(to, email.subject, email.body)),
      ...team.map((m) =>
        sendPushToTeamMember(m.id, {
          title: email.subject,
          body: [lead.phone, lead.email, captured.interest].filter(Boolean).join(" | "),
          conversationId: conversation.id,
        })
      ),
    ];

    if (business.clientConfirmationEnabled) {
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
