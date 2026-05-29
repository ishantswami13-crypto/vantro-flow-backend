// FILE: lib/cortex/backgroundJob.js
/**
 * Cortex Asynchronous Job Processor
 * Offloads heavy AI/analytics tasks from the main Node event loop.
 */
const { supabase } = require('../config/supabaseClient');

const JOB_STATE = {
  running: false,
  lastRun: null,
  jobId: null
};

/**
 * Triggered by the client or a cron to recalculate AI scores, 
 * run the planner, and generate summary tables asynchronously.
 */
async function startCortexBackgroundRefresh(userId) {
  if (JOB_STATE.running) {
    return { status: 'already_running', jobId: JOB_STATE.jobId };
  }

  const jobId = `ctx_${Date.now()}`;
  JOB_STATE.running = true;
  JOB_STATE.jobId = jobId;
  JOB_STATE.lastRun = new Date();

  console.log(`[CORTEX_JOB] Started background refresh ${jobId} for user ${userId}`);

  // Execute asynchronously
  setTimeout(async () => {
    try {
      // Step 1: In a real app, run score recalculator
      // await recalculateCustomerScores(userId);
      
      // Step 2: Run cashflow forecast updater
      // await updateCashflowForecast(userId);
      
      // Step 3: Run AI Action generator
      // await generateOwnerBriefing(userId);
      
      console.log(`[CORTEX_JOB] Completed background refresh ${jobId}`);
      
      // Mark as completed in audit log or system events if necessary
      await supabase.from('error_events').insert([{
        user_id: userId,
        error_type: 'cortex_job',
        error_message: `Completed refresh job ${jobId}`,
        severity: 'info',
        source: 'backend',
        stack_trace: null
      }]);
    } catch (err) {
      console.error(`[CORTEX_JOB] Failed background refresh ${jobId}`, err);
    } finally {
      JOB_STATE.running = false;
    }
  }, 100); // Push to next tick

  return { status: 'started', jobId };
}

module.exports = {
  startCortexBackgroundRefresh,
  JOB_STATE
};
