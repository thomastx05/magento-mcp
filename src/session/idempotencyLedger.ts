/**
 * Idempotency ledger — prevents duplicate commits.
 * Persists to a JSON file for crash recovery.
 */

import * as fs from 'fs';
import * as path from 'path';
import { IdempotencyEntry } from '../protocol/types';

export class IdempotencyLedger {
  private entries = new Map<string, IdempotencyEntry>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.load();
  }

  /**
   * Check if an idempotency key has already been used.
   */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Get an existing entry.
   */
  get(key: string): IdempotencyEntry | undefined {
    return this.entries.get(key);
  }

  /**
   * Record a new idempotency entry.
   */
  record(key: string, action: string, resultSummary: string): void {
    const entry: IdempotencyEntry = {
      key,
      action,
      created_at: new Date().toISOString(),
      result_summary: resultSummary,
    };
    this.entries.set(key, entry);
    this.persist();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const entry of data) {
            this.entries.set(entry.key, entry);
          }
        }
      }
    } catch {
      // Start fresh if file is corrupted
      this.entries.clear();
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = Array.from(this.entries.values());
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
