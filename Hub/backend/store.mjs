import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const now = () => new Date().toISOString();
export const digest = (value) => createHash('sha256').update(value).digest('hex');
const TABLES = new Set(['buildings','devices','alerts','patrols','deliveries','approvals','attendance','automations','commands','agent_runs','hub_tasks','rooms','responders','bookings','notifications']);
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8'));
  }
  table(name) { if (!TABLES.has(name)) throw new Error('Unknown entity'); return name; }
  all(table) { return this.db.prepare(`SELECT data FROM ${this.table(table)} ORDER BY rowid`).all().map(r => JSON.parse(r.data)); }
  get(table, id) { const r = this.db.prepare(`SELECT data FROM ${this.table(table)} WHERE id=?`).get(id); return r ? JSON.parse(r.data) : null; }
  put(table, item) {
    const columns = ['id','data']; const vals = [item.id, JSON.stringify(item)];
    const extra = table === 'devices' ? {building_id:item.buildingId,type:item.type} : table === 'alerts' ? {building_id:item.buildingId} : table === 'patrols' ? {robot_id:item.robotId} : table === 'deliveries' ? {vehicle_id:item.vehicleId || null} : table === 'commands' ? {device_id:item.deviceId,status:item.status,created_at:item.createdAt} : {};
    for (const [k,v] of Object.entries(extra)) { columns.push(k); vals.push(v ?? null); }
    this.db.prepare(`INSERT INTO ${this.table(table)} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map(c=>`${c}=excluded.${c}`).join(',')}`).run(...vals);
    return item;
  }
  setting(key, value) {
    if (value !== undefined) { this.db.prepare('INSERT INTO settings(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value)); return value; }
    const r = this.db.prepare('SELECT data FROM settings WHERE key=?').get(key); return r ? JSON.parse(r.data) : null;
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  audit(actor, action, target, detail = {}) {
    const at = now(); const who = typeof actor === 'string' ? actor : actor.name;
    const previous = this.db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get()?.hash || 'GENESIS';
    const text = JSON.stringify(detail); const hash = digest(JSON.stringify([at,who,action,target,text,previous]));
    this.db.prepare('INSERT INTO audit(at,actor,action,target,detail,prev_hash,hash) VALUES (?,?,?,?,?,?,?)').run(at,who,action,target,text,previous,hash);
    return hash;
  }
  audits(limit=100) { return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit).map(r=>({id:r.id,at:r.at,actor:r.actor,action:r.action,target:r.target,detail:JSON.parse(r.detail),prevHash:r.prev_hash,hash:r.hash})); }
  verifyAudit() {
    let previous = 'GENESIS'; let count = 0;
    for (const r of this.db.prepare('SELECT * FROM audit ORDER BY id').iterate()) {
      if (r.prev_hash !== previous || digest(JSON.stringify([r.at,r.actor,r.action,r.target,r.detail,r.prev_hash])) !== r.hash) return {valid:false,count,brokenAt:r.id};
      previous=r.hash; count++;
    }
    return {valid:true,count,head:previous,protection:'SQLite append-only triggers + SHA-256 chain; external immutable anchoring is required for production'};
  }
}
