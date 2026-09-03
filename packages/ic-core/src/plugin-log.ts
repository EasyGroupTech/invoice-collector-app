import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { PluginLogApi } from 'invoice-collector-plugin-sdk';
import { sanitizeMessageForLog, sanitizeValueForLog } from './log-sanitize.js';

/**
 * File-backed PluginLogApi — appends one sanitized line per call to the shared app log
 * (paths.ts's `appLogFile(baseDir)`). `info`/`warn`/`error` are synchronous per the SDK's own
 * contract, so the actual write is fire-and-forget; a write failure is swallowed (never surfaced
 * back to the plugin, never an unhandled rejection) rather than crashing the caller over a logging
 * problem.
 */
export function createPluginLog(filePath: string, pluginId: string): PluginLogApi {
  function write(level: string, message: string, data?: Record<string, unknown>): void {
    const sanitizedMessage = sanitizeMessageForLog(message);
    const sanitizedData = data ? (sanitizeValueForLog(data) as Record<string, unknown>) : undefined;
    const suffix = sanitizedData ? ` ${JSON.stringify(sanitizedData)}` : '';
    const line = `[${new Date().toISOString()}] [${level}] [${pluginId}] ${sanitizedMessage}${suffix}\n`;

    void mkdir(path.dirname(filePath), { recursive: true })
      .then(() => appendFile(filePath, line, 'utf-8'))
      .catch(() => {
        // Logging is best-effort — a disk/permission problem here must never crash or surface
        // back to the plugin that only wanted to log a message.
      });
  }

  return {
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  };
}
