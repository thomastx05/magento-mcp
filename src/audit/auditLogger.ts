/**
 * Audit logger — writes JSONL audit trail for all MCP actions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AuditRecord } from '../protocol/types';

export class AuditLogger {
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = path.resolve(logPath);
    // Ensure directory exists
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Log an audit record.
   */
  log(record: AuditRecord): void {
    // Sanitize params — remove sensitive fields
    const sanitized = { ...record };
    if (sanitized.params) {
      const p = { ...sanitized.params };
      delete p['password'];
      delete p['token'];
      sanitized.params = p;
    }

    const line = JSON.stringify(sanitized) + '\n';
    fs.appendFileSync(this.logPath, line, 'utf-8');
  }

  /**
   * Read recent audit records.
   */
  readRecent(count: number = 50): AuditRecord[] {
    if (!fs.existsSync(this.logPath)) return [];
    const content = fs.readFileSync(this.logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const recent = lines.slice(-count);
    return recent.map((line) => JSON.parse(line) as AuditRecord);
  }
}
