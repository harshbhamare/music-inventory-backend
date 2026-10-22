import cron from 'node-cron';

// Map of active cron tasks by configId / task key
const scheduledTasks = new Map<string, cron.ScheduledTask>();

/**
 * Automated background cron email scheduling is paused per system configuration.
 * Manual report emailing by recipient is enabled instead.
 */
export async function reloadScheduledJobs(): Promise<void> {
  console.log('[CRON] Automated background email cron runner is paused per system preference.');
  for (const [key, task] of scheduledTasks.entries()) {
    task.stop();
  }
  scheduledTasks.clear();
}

export function initializeScheduledJobs(): void {
  console.log('[CRON] Background email cron runners disabled per user preference. Manual email dispatch active.');
}
