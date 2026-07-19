import session from "express-session";
import createPgSession from "connect-pg-simple";
import bcrypt from "bcryptjs";
import { Request, Response, NextFunction } from "express";
import { pool } from "./db";
import { createBusiness } from "./businesses";

declare module "express-session" {
  interface SessionData {
    businessId?: string;
    teamMemberId?: string;
    role?: "admin" | "agent";
  }
}

export function createSessionMiddleware() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set — copy .env.example to .env and fill it in.");
  }

  const PgStore = createPgSession(session);
  return session({
    store: new PgStore({ pool, createTableIfMissing: true }),
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  });
}

export async function signup(req: Request, res: Response): Promise<void> {
  const { businessName, email, password, name } = req.body as {
    businessName?: string;
    email?: string;
    password?: string;
    name?: string;
  };
  if (!businessName || !email || !password || !name) {
    res.status(400).json({ error: "businessName, email, password, and name are required" });
    return;
  }

  const existing = await pool.query("SELECT id FROM team_members WHERE email = $1", [email]);
  if (existing.rows.length) {
    res.status(409).json({ error: "An account with that email already exists" });
    return;
  }

  const business = await createBusiness(businessName);
  const passwordHash = await bcrypt.hash(password, 10);
  const teamMemberResult = await pool.query<{ id: string }>(
    "INSERT INTO team_members (business_id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, 'admin') RETURNING id",
    [business.id, email, passwordHash, name]
  );

  req.session.businessId = business.id;
  req.session.teamMemberId = teamMemberResult.rows[0].id;
  req.session.role = "admin";
  res.json({ business, teamMemberId: teamMemberResult.rows[0].id, role: "admin" });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  const result = await pool.query<{
    id: string;
    business_id: string;
    password_hash: string;
    role: "admin" | "agent";
  }>("SELECT id, business_id, password_hash, role FROM team_members WHERE email = $1", [email]);

  const row = result.rows[0];
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  req.session.businessId = row.business_id;
  req.session.teamMemberId = row.id;
  req.session.role = row.role;
  res.json({ businessId: row.business_id, teamMemberId: row.id, role: row.role });
}

export function logout(req: Request, res: Response): void {
  req.session.destroy(() => res.json({ status: "ok" }));
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.businessId || !req.session.teamMemberId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session.role !== "admin") {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  next();
}

export interface TeamMemberSummary {
  id: string;
  email: string;
  name: string;
  role: "admin" | "agent";
}

export async function listTeamMembers(businessId: string): Promise<TeamMemberSummary[]> {
  const result = await pool.query<TeamMemberSummary>(
    "SELECT id, email, name, role FROM team_members WHERE business_id = $1 ORDER BY created_at ASC",
    [businessId]
  );
  return result.rows;
}

export async function addTeamMember(
  businessId: string,
  email: string,
  password: string,
  name: string,
  role: "admin" | "agent"
): Promise<string> {
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await pool.query<{ id: string }>(
    "INSERT INTO team_members (business_id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [businessId, email, passwordHash, name, role]
  );
  return result.rows[0].id;
}
