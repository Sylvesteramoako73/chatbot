import { pool } from "./db";
import { listTeamMembers } from "./auth";
import { sendPushToTeamMember } from "./push";
import { sendEmail } from "./email";
import type { Conversation } from "./conversations";

async function getLatestCustomerMessage(conversationId: string): Promise<string> {
  const result = await pool.query<{ content: string }>(
    "SELECT content FROM conversation_messages WHERE conversation_id = $1 AND role = 'customer' ORDER BY created_at DESC LIMIT 1",
    [conversationId]
  );
  return result.rows[0]?.content ?? "A conversation needs your attention.";
}

/**
 * Best-effort — a notification failure never surfaces back to whoever called requestHuman()
 * (the bot, a webhook, or the widget), same reasoning as the existing auto-handoff error handling.
 */
export async function notifyTeamOfEscalation(conversation: Conversation): Promise<void> {
  try {
    const [team, preview] = await Promise.all([
      listTeamMembers(conversation.businessId),
      getLatestCustomerMessage(conversation.id),
    ]);

    await Promise.allSettled(
      team.flatMap((member) => [
        sendPushToTeamMember(member.id, {
          title: "New conversation needs you",
          body: preview,
          conversationId: conversation.id,
        }),
        sendEmail(member.email, "New conversation needs you", `${preview}\n\nOpen it: ${dashboardUrl(conversation.id)}`),
      ])
    );
  } catch (err) {
    console.error("notifyTeamOfEscalation failed:", err);
  }
}

function dashboardUrl(conversationId: string): string {
  const base = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  return `${base}/dashboard/index.html?conversation=${conversationId}`;
}

/** Same best-effort reasoning as notifyTeamOfEscalation, but targeted at the one assigned rep. */
export async function notifyTeamMemberOfAssignment(
  teamMemberId: string,
  teamMemberEmail: string,
  conversation: Conversation
): Promise<void> {
  try {
    const preview = await getLatestCustomerMessage(conversation.id);
    await Promise.allSettled([
      sendPushToTeamMember(teamMemberId, {
        title: "A conversation was assigned to you",
        body: preview,
        conversationId: conversation.id,
      }),
      sendEmail(
        teamMemberEmail,
        "A conversation was assigned to you",
        `${preview}\n\nOpen it: ${dashboardUrl(conversation.id)}`
      ),
    ]);
  } catch (err) {
    console.error("notifyTeamMemberOfAssignment failed:", err);
  }
}
