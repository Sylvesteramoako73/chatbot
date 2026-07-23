import { pool } from "./db";
import { getLeadStageCounts, LeadStageCounts } from "./leads";

export interface DailyCount {
  date: string; // YYYY-MM-DD
  count: number;
}

export interface ChannelCount {
  channel: string;
  count: number;
}

export interface AgentCount {
  name: string;
  count: number;
}

export interface AnalyticsSummary {
  leadStages: LeadStageCounts;
  leadsByDay: DailyCount[];
  conversationsByChannel: ChannelCount[];
  conversationsByAgent: AgentCount[];
  totalConversations: number;
  conversionRate: number; // won / (won + lost); 0 when there's no decided outcome yet
}

function fillLast30Days(rows: { day: string; count: string }[]): DailyCount[] {
  const counts = new Map(rows.map((r) => [r.day, Number(r.count)]));
  const days: DailyCount[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ date: key, count: counts.get(key) ?? 0 });
  }
  return days;
}

export async function getAnalyticsSummary(businessId: string): Promise<AnalyticsSummary> {
  const leadStages = await getLeadStageCounts(businessId);

  const dayRows = await pool.query<{ day: string; count: string }>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*) AS count
     FROM leads
     WHERE business_id = $1 AND created_at > now() - interval '30 days'
     GROUP BY day
     ORDER BY day`,
    [businessId]
  );
  const leadsByDay = fillLast30Days(dayRows.rows);

  const channelRows = await pool.query<{ channel: string; count: string }>(
    "SELECT channel, count(*) AS count FROM conversations WHERE business_id = $1 GROUP BY channel",
    [businessId]
  );
  const conversationsByChannel = channelRows.rows.map((r) => ({ channel: r.channel, count: Number(r.count) }));
  const totalConversations = conversationsByChannel.reduce((sum, c) => sum + c.count, 0);

  const agentRows = await pool.query<{ name: string; count: string }>(
    `SELECT tm.name, count(c.id) AS count
     FROM conversations c
     JOIN team_members tm ON tm.id = c.claimed_by
     WHERE c.business_id = $1
     GROUP BY tm.name
     ORDER BY count(c.id) DESC`,
    [businessId]
  );
  const conversationsByAgent = agentRows.rows.map((r) => ({ name: r.name, count: Number(r.count) }));

  const decided = leadStages.byStage.won + leadStages.byStage.lost;
  const conversionRate = decided > 0 ? leadStages.byStage.won / decided : 0;

  return { leadStages, leadsByDay, conversationsByChannel, conversationsByAgent, totalConversations, conversionRate };
}
