/**
 * Form Diagnostics Logger
 * Logs per-application-attempt details to form-diagnostics.log (NDJSON format).
 * Enables post-run debugging: grep "FAILED" form-diagnostics.log
 */

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'form-diagnostics.log');

function logFormAttempt(jobTitle, companyName, data) {
    const entry = {
        timestamp: new Date().toISOString(),
        jobTitle,
        companyName,
        extractedFields: data.extractedFields || [],
        aiDecisions: data.aiDecisions || [],
        fillResults: data.fillResults || [],
        validationErrors: data.validationErrors || [],
        finalOutcome: data.finalOutcome || 'UNKNOWN',
        page: data.page || 0,
        provider: data.provider || 'unknown'
    };

    try {
        fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
        console.log(`[FORM-LOGGER] Failed to write diagnostic log: ${e.message}`);
    }
}

module.exports = { logFormAttempt };
