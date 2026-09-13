/**
 * System Database
 *
 * Manages the shared system.sqlite database for user accounts,
 * workspaces, workspace access, and deployment routing.
 * Workspaces are the unit of data isolation and quota enforcement.
 * Users get granted access to workspaces with roles (owner/editor/viewer).
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { enqueueEvent } from '../webhooks/outbox';
import { startDeliveryLoop } from '../webhooks/delivery';

let systemDb: Database.Database | null = null;

function getDataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemUser {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  is_admin: number;
  active: number;
  /** 0 shows the simple view: projects and deployments, and a project opens in quick edit. */
  studio_view: number;
  default_workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SystemWorkspace {
  id: string;
  name: string;
  owner_id: string;
  max_projects: number;
  max_deployments: number;
  max_storage_mb: number;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceAccess {
  user_id: string;
  workspace_id: string;
  role: 'owner' | 'editor' | 'viewer';
  created_at: string;
}

// ---------------------------------------------------------------------------
// Role hierarchy
// ---------------------------------------------------------------------------

const ROLE_LEVELS: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };

// ---------------------------------------------------------------------------
// Database init
// ---------------------------------------------------------------------------

/**
 * Whether the system database file is already there.
 *
 * getSystemDatabase() creates it on first call, so boot-time maintenance that only wants to read
 * existing workspaces asks this first — a browser-mode install has no system database and must not
 * acquire one merely by starting.
 */
export function systemDatabaseExists(): boolean {
  return fs.existsSync(path.join(getDataDir(), 'system.sqlite'));
}

/**
 * Get the system database connection (singleton)
 */
export function getSystemDatabase(): Database.Database {
  if (systemDb) return systemDb;

  const dataDir = getDataDir();
  ensureDir(dataDir);

  const dbPath = path.join(dataDir, 'system.sqlite');
  systemDb = new Database(dbPath);
  const encryptionKey = process.env.DB_ENCRYPTION_KEY;
  if (encryptionKey) {
    systemDb.pragma(`key='${encryptionKey}'`);
  }
  systemDb.pragma('journal_mode = WAL');
  systemDb.pragma('foreign_keys = ON');
  systemDb.pragma('synchronous = NORMAL');

  initSystemSchema(systemDb);

  startDeliveryLoop();

  return systemDb;
}

function initSystemSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      default_workspace_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      max_projects INTEGER NOT NULL DEFAULT 9999,
      max_deployments INTEGER NOT NULL DEFAULT 9999,
      max_storage_mb INTEGER NOT NULL DEFAULT 99999,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS workspace_access (
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, workspace_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS deployment_routing (
      deployment_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      slug TEXT UNIQUE,
      custom_domain TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_access_user ON workspace_access(user_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_access_workspace ON workspace_access(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_deployment_routing_workspace ON deployment_routing(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_deployment_routing_slug ON deployment_routing(slug);

    CREATE TABLE IF NOT EXISTS webhook_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS instance_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspace_mail (
      workspace_id TEXT PRIMARY KEY,
      -- Whether this workspace sends at all, and the state a workspace starts in. Off composes
      -- nothing rather than queueing it up for later. Unlike the instance tier's switch, absence is
      -- not a signal here: nothing provisions a workspace from an environment, so a row is only ever
      -- written by an owner who was looking at the switch. See lib/mail/settings.ts.
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'instance',  -- 'instance' | 'own'
      display_name TEXT,          -- instance mode only; overrides the From display name
      smtp_host TEXT,
      smtp_port INTEGER,
      smtp_secure TEXT,           -- 'starttls' | 'ssl' | 'none'
      smtp_user TEXT,
      smtp_password TEXT,         -- own mode only; never returned to a client
      from_address TEXT,          -- own mode only
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Which workspace's mail settings send this. NULL = instance mail (e.g. an admin test).
      -- Deliberately not a foreign key: a queued message names the transport that should carry it,
      -- and a workspace deleted mid-flight should not silently drop mail already composed for it.
      workspace_id TEXT,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      body_html TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- 'delivered' mirrors webhook_outbox so the two queues read alike, but SMTP can only tell us
      -- a mail server *accepted* the message; a later bounce arrives out of band and nothing reads
      -- it. Treat this column as "handed off", never as "it reached a person".
      delivered INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_email_outbox_pending ON email_outbox(delivered, attempts);
    CREATE INDEX IF NOT EXISTS idx_email_outbox_workspace ON email_outbox(workspace_id);
  `);

  // Migration: add custom_domain column if missing (existing databases)
  try {
    db.prepare('SELECT custom_domain FROM deployment_routing LIMIT 0').get();
  } catch {
    db.prepare('ALTER TABLE deployment_routing ADD COLUMN custom_domain TEXT').run();
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_routing_domain ON deployment_routing(custom_domain)').run();
  }

  // Migration: add workspace_mail.enabled if missing (existing databases). Existing rows take the
  // column default of 0: they were written by a page that had no such switch on it, so they carry
  // no decision to preserve, and off is the same holding state a workspace that has never been
  // configured is already in.
  try {
    db.prepare('SELECT enabled FROM workspace_mail LIMIT 0').get();
  } catch {
    db.prepare('ALTER TABLE workspace_mail ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0').run();
  }

  // Migration: add users.studio_view if missing. Defaults to 1 so every account that predates the
  // simple view keeps the studio it has been using; only a member added through the workspace users
  // page is seeded with 0.
  try {
    db.prepare('SELECT studio_view FROM users LIMIT 0').get();
  } catch {
    db.prepare('ALTER TABLE users ADD COLUMN studio_view INTEGER NOT NULL DEFAULT 1').run();
  }

  // Migration: raise old restrictive workspace defaults (3/1/100) to generous values.
  // Quota enforcement now runs in all server mode, not only managed mode, so workspaces
  // created with the old defaults would hit limits their admin never chose. Managed
  // instances are unaffected — the gateway sets explicit quotas on every workspace.
  db.prepare(`
    UPDATE workspaces
    SET max_projects = 9999, max_deployments = 9999, max_storage_mb = 99999
    WHERE max_projects = 3 AND max_deployments = 1 AND max_storage_mb = 100
  `).run();
}

// ---------------------------------------------------------------------------
// User functions
// ---------------------------------------------------------------------------

/**
 * Create a new user. Returns the user ID.
 */
export function createUser(
  email: string,
  passwordHash: string,
  displayName?: string,
  studioView: number = 1
): string {
  const db = getSystemDatabase();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO users (id, email, password_hash, display_name, studio_view)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, email.toLowerCase().trim(), passwordHash, displayName || null, studioView);

  enqueueEvent('user.created', { userId: id, email: email.toLowerCase().trim(), displayName: displayName || null });

  return id;
}

/**
 * Find a user by email
 */
export function getUserByEmail(email: string): SystemUser | undefined {
  const db = getSystemDatabase();
  return db.prepare('SELECT * FROM users WHERE email = ? AND active = 1')
    .get(email.toLowerCase().trim()) as SystemUser | undefined;
}

/**
 * Find a user by ID
 */
export function getUserById(id: string): SystemUser | undefined {
  const db = getSystemDatabase();
  return db.prepare('SELECT * FROM users WHERE id = ? AND active = 1')
    .get(id) as SystemUser | undefined;
}

/**
 * Get the number of user accounts (for bootstrap detection)
 */
export function getUserCount(): number {
  const db = getSystemDatabase();
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  return row.count;
}

/**
 * Deactivate a user (soft delete)
 */
export function deactivateUser(id: string): void {
  const db = getSystemDatabase();
  db.prepare("UPDATE users SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
  enqueueEvent('user.deactivated', { userId: id });
}

/**
 * List all users (for admin). Excludes password_hash.
 */
export function listUsers(): Omit<SystemUser, 'password_hash'>[] {
  const db = getSystemDatabase();
  return db.prepare(`
    SELECT id, email, display_name, is_admin, active, studio_view,
           default_workspace_id, created_at, updated_at
    FROM users ORDER BY created_at DESC
  `).all() as Omit<SystemUser, 'password_hash'>[];
}

/**
 * Update user properties
 */
export function updateUser(id: string, updates: { display_name?: string; active?: number; password_hash?: string; is_admin?: number; studio_view?: number }): void {
  const db = getSystemDatabase();
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const values: (string | number)[] = [];

  if (updates.display_name !== undefined) { setClauses.push('display_name = ?'); values.push(updates.display_name); }
  if (updates.active !== undefined) { setClauses.push('active = ?'); values.push(updates.active); }
  if (updates.password_hash !== undefined) { setClauses.push('password_hash = ?'); values.push(updates.password_hash); }
  if (updates.is_admin !== undefined) { setClauses.push('is_admin = ?'); values.push(updates.is_admin); }
  if (updates.studio_view !== undefined) { setClauses.push('studio_view = ?'); values.push(updates.studio_view); }

  values.push(id);
  db.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

  const updated = getUserById(id);
  if (updated) {
    enqueueEvent('user.updated', { userId: id, email: updated.email, displayName: updated.display_name });
  }
}

// ---------------------------------------------------------------------------
// Workspace functions
// ---------------------------------------------------------------------------

/**
 * Create a workspace, create its data directory, return workspace ID.
 */
export function createWorkspace(name: string, ownerId: string): string {
  const db = getSystemDatabase();
  const id = randomUUID();

  db.prepare(`INSERT INTO workspaces (id, name, owner_id) VALUES (?, ?, ?)`).run(id, name, ownerId);

  // Grant owner access
  db.prepare(`
    INSERT INTO workspace_access (user_id, workspace_id, role)
    VALUES (?, ?, 'owner')
  `).run(ownerId, id);

  // Create workspace data directory
  const workspaceDir = path.join(getDataDir(), 'workspaces', id);
  ensureDir(workspaceDir);

  enqueueEvent('workspace.created', { workspaceId: id, name, ownerId });

  return id;
}

/**
 * Get workspace by ID
 */
export function getWorkspaceById(id: string): SystemWorkspace | undefined {
  const db = getSystemDatabase();
  return db.prepare('SELECT * FROM workspaces WHERE id = ?')
    .get(id) as SystemWorkspace | undefined;
}

/**
 * List all workspaces (admin)
 */
export function listWorkspaces(): SystemWorkspace[] {
  const db = getSystemDatabase();
  return db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC')
    .all() as SystemWorkspace[];
}

/**
 * List workspaces a user has access to (with their role)
 */
export function listUserWorkspaces(userId: string): (SystemWorkspace & { role: string })[] {
  const db = getSystemDatabase();
  return db.prepare(`
    SELECT w.*, wa.role
    FROM workspaces w
    JOIN workspace_access wa ON wa.workspace_id = w.id
    WHERE wa.user_id = ?
    ORDER BY w.created_at DESC
  `).all(userId) as (SystemWorkspace & { role: string })[];
}

/**
 * Update workspace properties
 */
export function updateWorkspace(id: string, updates: {
  name?: string;
  max_projects?: number;
  max_deployments?: number;
  max_storage_mb?: number;
}): void {
  const db = getSystemDatabase();
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const values: (string | number)[] = [];

  if (updates.name !== undefined) { setClauses.push('name = ?'); values.push(updates.name); }
  if (updates.max_projects !== undefined) { setClauses.push('max_projects = ?'); values.push(updates.max_projects); }
  if (updates.max_deployments !== undefined) { setClauses.push('max_deployments = ?'); values.push(updates.max_deployments); }
  if (updates.max_storage_mb !== undefined) { setClauses.push('max_storage_mb = ?'); values.push(updates.max_storage_mb); }

  values.push(id);
  db.prepare(`UPDATE workspaces SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

  if (updates.name !== undefined) {
    enqueueEvent('workspace.updated', { workspaceId: id, name: updates.name });
  }
}

/**
 * Delete workspace (removes from DB, caller handles filesystem cleanup)
 */
export function deleteWorkspace(id: string): void {
  const db = getSystemDatabase();
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  enqueueEvent('workspace.deleted', { workspaceId: id });
}

// ---------------------------------------------------------------------------
// Workspace access functions
// ---------------------------------------------------------------------------

/**
 * Grant a user access to a workspace
 */
export function grantWorkspaceAccess(userId: string, workspaceId: string, role: 'owner' | 'editor' | 'viewer'): void {
  const db = getSystemDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO workspace_access (user_id, workspace_id, role)
    VALUES (?, ?, ?)
  `).run(userId, workspaceId, role);

  const grantedUser = getUserById(userId);
  if (grantedUser) {
    enqueueEvent('workspace.access_granted', { workspaceId, email: grantedUser.email, role });
  }
}

/**
 * Revoke a user's access to a workspace
 */
export function revokeWorkspaceAccess(userId: string, workspaceId: string): void {
  const db = getSystemDatabase();
  const revokedUser = getUserById(userId);
  db.prepare('DELETE FROM workspace_access WHERE user_id = ? AND workspace_id = ?')
    .run(userId, workspaceId);

  if (revokedUser) {
    enqueueEvent('workspace.access_revoked', { workspaceId, email: revokedUser.email });
  }
}

/**
 * Get a user's access to a specific workspace
 */
export function getWorkspaceAccess(userId: string, workspaceId: string): WorkspaceAccess | undefined {
  const db = getSystemDatabase();
  return db.prepare('SELECT * FROM workspace_access WHERE user_id = ? AND workspace_id = ?')
    .get(userId, workspaceId) as WorkspaceAccess | undefined;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: 'owner' | 'editor' | 'viewer';
  studioView: number;
  createdAt: string;
}

/**
 * Everyone with access to a workspace, and the address to reach them at.
 *
 * Deactivated accounts are left out: a removed colleague cannot act on a notification, and their
 * address is usually the first thing an employer turns off.
 */
export function listWorkspaceMembers(workspaceId: string): WorkspaceMember[] {
  const db = getSystemDatabase();
  const rows = db.prepare(`
    SELECT wa.user_id, wa.role, wa.created_at, u.email, u.display_name, u.studio_view
    FROM workspace_access wa
    JOIN users u ON u.id = wa.user_id
    WHERE wa.workspace_id = ? AND u.active = 1
    ORDER BY wa.created_at ASC
  `).all(workspaceId) as {
    user_id: string; role: WorkspaceMember['role']; created_at: string;
    email: string; display_name: string | null; studio_view: number;
  }[];

  return rows.map(row => ({
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    studioView: row.studio_view,
    createdAt: row.created_at,
  }));
}

/**
 * Verify user has access to workspace, throws Error if not.
 * Admin users (is_admin=1) always have access.
 * Legacy admin/desktop/instance-api users always have access.
 */
export function verifyWorkspaceAccess(
  userId: string,
  workspaceId: string,
  requiredRole: 'owner' | 'editor' | 'viewer' = 'viewer'
): void {
  // Admin users always have access
  const user = getUserById(userId);
  if (user?.is_admin) return;

  // Also allow legacy admin and desktop users
  if (userId === 'admin' || userId === 'desktop' || userId === 'instance-api') return;

  const access = getWorkspaceAccess(userId, workspaceId);
  if (!access) throw new Error('Workspace access denied');

  const userLevel = ROLE_LEVELS[access.role] || 0;
  const requiredLevel = ROLE_LEVELS[requiredRole] || 0;
  if (userLevel < requiredLevel) throw new Error('Insufficient workspace permissions');
}

/**
 * Set user's default workspace
 */
export function setDefaultWorkspace(userId: string, workspaceId: string): void {
  const db = getSystemDatabase();
  db.prepare("UPDATE users SET default_workspace_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(workspaceId, userId);
}

/**
 * Get user's default workspace ID
 */
export function getUserDefaultWorkspace(userId: string): string | undefined {
  const db = getSystemDatabase();
  const row = db.prepare('SELECT default_workspace_id FROM users WHERE id = ?')
    .get(userId) as { default_workspace_id: string | null } | undefined;
  return row?.default_workspace_id ?? undefined;
}

// ---------------------------------------------------------------------------
// Deployment routing functions
// ---------------------------------------------------------------------------

/**
 * Register a deployment for routing
 */
export function registerDeploymentRoute(deploymentId: string, workspaceId: string, slug?: string, customDomain?: string): void {
  const db = getSystemDatabase();

  // Check if another workspace already owns this deployment
  const existing = db.prepare('SELECT workspace_id FROM deployment_routing WHERE deployment_id = ?')
    .get(deploymentId) as { workspace_id: string } | undefined;
  if (existing && existing.workspace_id !== workspaceId) {
    throw new Error('Deployment is owned by another workspace');
  }

  if (customDomain) {
    const domainOwner = db.prepare(
      'SELECT deployment_id FROM deployment_routing WHERE custom_domain = ? AND deployment_id != ?'
    ).get(customDomain, deploymentId) as { deployment_id: string } | undefined;
    if (domainOwner) {
      throw new Error('Domain is already registered to another deployment');
    }
  }

  db.prepare(`
    INSERT OR REPLACE INTO deployment_routing (deployment_id, workspace_id, slug, custom_domain)
    VALUES (?, ?, ?, ?)
  `).run(deploymentId, workspaceId, slug || null, customDomain || null);
}

/**
 * Register a deployment for routing only if it is not registered yet.
 *
 * Unlike registerDeploymentRoute this never rewrites an existing row, so it is safe to call from
 * paths that do not know the deployment's slug or custom domain — INSERT OR REPLACE with a null
 * slug would otherwise erase them. Used to make sure a deployment is resolvable to its workspace
 * from the moment it exists, not only once it has been published.
 */
export function ensureDeploymentRoute(deploymentId: string, workspaceId: string): void {
  const db = getSystemDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO deployment_routing (deployment_id, workspace_id)
    VALUES (?, ?)
  `).run(deploymentId, workspaceId);
}

/**
 * Remove a deployment route
 */
export function removeDeploymentRoute(deploymentId: string): void {
  const db = getSystemDatabase();
  db.prepare('DELETE FROM deployment_routing WHERE deployment_id = ?').run(deploymentId);
}

/**
 * Get the full routing record for a deployment
 */
export function getDeploymentRoute(deploymentId: string): { deployment_id: string; workspace_id: string; slug: string | null; custom_domain: string | null } | undefined {
  const db = getSystemDatabase();
  return db.prepare('SELECT deployment_id, workspace_id, slug, custom_domain FROM deployment_routing WHERE deployment_id = ?')
    .get(deploymentId) as { deployment_id: string; workspace_id: string; slug: string | null; custom_domain: string | null } | undefined;
}

/**
 * Look up which workspace owns a deployment
 */
export function getDeploymentWorkspace(deploymentId: string): string | undefined {
  const db = getSystemDatabase();
  const row = db.prepare('SELECT workspace_id FROM deployment_routing WHERE deployment_id = ?')
    .get(deploymentId) as { workspace_id: string } | undefined;
  return row?.workspace_id;
}

/**
 * Look up a deployment by subdomain slug
 */
export function getDeploymentBySlug(slug: string): { deployment_id: string; workspace_id: string } | undefined {
  const db = getSystemDatabase();
  return db.prepare('SELECT deployment_id, workspace_id FROM deployment_routing WHERE slug = ?')
    .get(slug) as { deployment_id: string; workspace_id: string } | undefined;
}

/**
 * Look up a deployment by custom domain
 */
export function getDeploymentByDomain(domain: string): { deployment_id: string; workspace_id: string } | undefined {
  const db = getSystemDatabase();
  return db.prepare(
    'SELECT deployment_id, workspace_id FROM deployment_routing WHERE custom_domain = ?'
  ).get(domain) as { deployment_id: string; workspace_id: string } | undefined;
}

/**
 * Get all deployments with custom domains (for Caddy config generation)
 */
export function getAllDomainRoutes(): { deployment_id: string; workspace_id: string; custom_domain: string }[] {
  const db = getSystemDatabase();
  return db.prepare(
    'SELECT deployment_id, workspace_id, custom_domain FROM deployment_routing WHERE custom_domain IS NOT NULL ORDER BY custom_domain'
  ).all() as { deployment_id: string; workspace_id: string; custom_domain: string }[];
}

/**
 * Get all deployments with slugs (for Caddy subdomain config generation)
 */
export function getAllSlugRoutes(): { deployment_id: string; slug: string }[] {
  const db = getSystemDatabase();
  return db.prepare(
    'SELECT deployment_id, slug FROM deployment_routing WHERE slug IS NOT NULL ORDER BY slug'
  ).all() as { deployment_id: string; slug: string }[];
}

/**
 * Get workspace's deployment count (for quota enforcement)
 */
export function getWorkspaceDeploymentCount(workspaceId: string): number {
  const db = getSystemDatabase();
  const row = db.prepare('SELECT COUNT(*) as count FROM deployment_routing WHERE workspace_id = ?')
    .get(workspaceId) as { count: number };
  return row.count;
}

// ---------------------------------------------------------------------------
// Workspace stats (used by admin APIs)
// ---------------------------------------------------------------------------

/**
 * Get the project count for a workspace by reading its database directly.
 * Opens the workspace DB read-only, does not use the adapter cache.
 */
export function getWorkspaceProjectCount(workspaceId: string): number {
  const dbPath = path.join(getDataDir(), 'workspaces', workspaceId, 'osws.sqlite');
  if (!fs.existsSync(dbPath)) return 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();
    if (!tableExists) { db.close(); return 0; }
    const count = (db.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number }).count;
    db.close();
    return count;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

/**
 * Close system database connection
 */
export function closeSystemDatabase(): void {
  if (systemDb) {
    try { systemDb.close(); } catch {}
    systemDb = null;
  }
}
