// Tasks in memory: one record for each run of executeTask (background or synchronous).
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.mjs';

export const TASK_TTL_MS = 60 * 60 * 1000;
const FINISHED = ['done', 'error', 'stopped'];

export class TaskRegistry {
  /**
   * @param {{maxParallel: number, ttlMs?: number, now?: () => number}} opts
   */
  constructor({ maxParallel, ttlMs = TASK_TTL_MS, now = Date.now }) {
    this.maxParallel = maxParallel;
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, ReturnType<TaskRegistry['create']>>} */
    this.tasks = new Map();
  }

  /** How many tasks are running now. */
  get running() {
    let n = 0;
    for (const rec of this.tasks.values()) if (rec.status === 'running') n++;
    return n;
  }

  /**
   * A new running task. JS is single-threaded: the check and the insert cannot interleave.
   * @throws {HttpError} 429 when MAX_PARALLEL tasks are running
   */
  create({ prompt, mode, sessionId = null, browser = false, allowedSites = [] }) {
    if (this.running >= this.maxParallel) throw new HttpError(429, `max parallel tasks (${this.maxParallel})`);
    const rec = {
      id: randomUUID(),
      prompt,
      mode,
      sessionId,
      browser,
      allowedSites,
      release: null,
      status: 'running',
      answer: '',
      steps: [],
      usage: null,
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      error: null,
      abort: new AbortController(),
      ctx: null,
    };
    this.tasks.set(rec.id, rec);
    return rec;
  }

  get(id) {
    return this.tasks.get(id);
  }

  remove(id) {
    return this.tasks.delete(id);
  }

  /** Removes finished tasks that are older than the TTL. @returns {number} how many */
  sweep() {
    let n = 0;
    for (const [id, rec] of this.tasks) {
      if (FINISHED.includes(rec.status) && rec.finishedAt && this.now() - Date.parse(rec.finishedAt) > this.ttlMs) {
        this.tasks.delete(id);
        n++;
      }
    }
    return n;
  }

  /** Asks every running task to stop. */
  abortAll() {
    for (const rec of this.tasks.values()) if (rec.status === 'running') rec.abort.abort();
  }

  /** What GET /status/:id answers. */
  static view(rec) {
    const { status, answer, steps, usage, startedAt, finishedAt, error, sessionId } = rec;
    return { status, answer, steps, usage, startedAt, finishedAt, error, ...(sessionId ? { session_id: sessionId } : {}) };
  }
}
