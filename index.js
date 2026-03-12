require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const aiProvider = require('./ai-provider');
const formLogger = require('./form-logger');
const { readConfig: readUiConfig, DEFAULT_CONFIG } = require('./bot-config');
const {
    readApplicantProfile,
    getResumePath,
    getCoverLetterContactLine
} = require('./applicant-config');

// Add stealth plugin to playwright-extra
chromium.use(stealth);

// Parse environment variables
const AGENT_ID = process.env.AGENT_ID || 'solo';
const AGENT_INDEX = Number.parseInt(process.env.AGENT_INDEX || '1', 10) || 1;
const USER_DATA_DIR = process.env.USER_DATA_DIR || path.join(__dirname, 'chrome_profile');
const applicantProfile = readApplicantProfile();
const RESUME_PATH = getResumePath(applicantProfile);
let branchCounter = 0;

// UI Config and Stats files
const STATS_FILE = path.join(__dirname, 'daily-stats.json');

function parseJsonEnv(name) {
    if (!process.env[name]) return null;
    try {
        return JSON.parse(process.env[name]);
    } catch (error) {
        return null;
    }
}

function emitAgentEvent(kind, payload = {}) {
    const event = {
        kind,
        agentId: AGENT_ID,
        agentIndex: AGENT_INDEX,
        timestamp: new Date().toISOString(),
        ...payload
    };
    process.stdout.write(`[AGENT_EVENT] ${JSON.stringify(event)}\n`);
}

function emitActivity(message, payload = {}) {
    emitAgentEvent('activity', { message, ...payload });
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function beginBranch(branchType, title, detail = '', payload = {}) {
    const branchId = `${branchType}-${Date.now()}-${++branchCounter}`;
    emitAgentEvent('branch', {
        branchId,
        branchType,
        title,
        detail,
        status: 'active',
        ...payload
    });
    return branchId;
}

function updateBranch(branchId, detail = '', payload = {}) {
    if (!branchId) return;
    emitAgentEvent('branch', {
        branchId,
        status: 'active',
        detail,
        ...payload
    });
}

function finishBranch(branchId, status = 'completed', detail = '', payload = {}) {
    if (!branchId) return;
    emitAgentEvent('branch', {
        branchId,
        status,
        detail,
        ...payload
    });
}

// Load UI config (set by dashboard), then overlay per-agent runtime overrides
function loadConfig() {
    const activeKeywordsOverride = parseJsonEnv('ACTIVE_KEYWORDS_JSON');
    const runtimeConfig = {
        ...DEFAULT_CONFIG,
        ...readUiConfig()
    };

    if (Array.isArray(activeKeywordsOverride) && activeKeywordsOverride.length > 0) {
        runtimeConfig.activeKeywords = activeKeywordsOverride.filter(Boolean);
        runtimeConfig.keywords = Array.from(new Set([
            ...(runtimeConfig.keywords || []),
            ...runtimeConfig.activeKeywords
        ]));
    }

    if (process.env.APPLY_MODE) {
        runtimeConfig.applyMode = process.env.APPLY_MODE;
    }

    if (process.env.HEADLESS) {
        runtimeConfig.headless = /^true$/i.test(process.env.HEADLESS);
    }

    return runtimeConfig;
}

// Increment a named counter in the daily stats JSON (auto-resets each day)
function incrementDailyStat(field) {
    const today = new Date().toISOString().split('T')[0];
    let stats = { date: today, easyApplyCount: 0, externalApplyCount: 0, skippedCount: 0, rateLimitedCount: 0 };
    if (fs.existsSync(STATS_FILE)) {
        try {
            const s = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
            if (s.date === today) stats = s;
        } catch (e) { }
    }
    stats[field] = (stats[field] || 0) + 1;
    stats.date = today;
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

// Logger mechanism into Markdown List
function logSuccess(companyName, jobTitle, status, jobUrl) {
    const timestamp = new Date().toLocaleString();
    console.log(`\x1b[32m[AGENT ${AGENT_ID}] [${timestamp}] COMPANY: ${companyName} | ROLE: ${jobTitle} | STATUS: ${status}\x1b[0m`);
    emitAgentEvent('result', { companyName, jobTitle, status, jobUrl });

    // Build Markdown bullet
    const mdLine = `- **[${timestamp}]** [${jobTitle} at ${companyName}](${jobUrl || 'No URL Available'}) - Status: **${status}**\n`;
    fs.appendFileSync('applied_jobs.md', mdLine, 'utf8');

    // Track daily stats for the dashboard
    if (status === 'APPLIED') incrementDailyStat('easyApplyCount');
    else if (status === 'APPLIED_EXTERNAL') incrementDailyStat('externalApplyCount');
    else if (/RATE.?LIMIT/i.test(status)) incrementDailyStat('rateLimitedCount');
    else if (/SKIPPED|INELIGIBLE|COMPLEX/i.test(status)) incrementDailyStat('skippedCount');

    emitActivity(`${status}: ${jobTitle} @ ${companyName}`, {
        stage: 'result',
        companyName,
        jobTitle,
        jobUrl,
        status
    });
}

function logInfo(message) {
    console.log(`[AGENT ${AGENT_ID}] [INFO] ${message}`);
    emitAgentEvent('log', { level: 'info', message });
}

// Anti-detection random human jitter (Wait times)
async function humanJitter(page, min = 1000, max = 3000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await page.waitForTimeout(delay);
}

// AI Provider is initialized in ai-provider.js — supports OpenAI GPT-5.4 and Gemini Flash

// Extract form data from the current modal
async function extractFormFields(page) {
    return await page.evaluate(() => {
        const fields = [];
        const modal = document.querySelector('div[role="dialog"]') || document.body;

        // Robust label finder: tries aria-label, label[for], DOM walking, then placeholder as last resort
        function findLabelText(el) {
            // aria-label is the most direct signal
            if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
            if (el.id) {
                const direct = modal.querySelector(`label[for="${el.id}"]`);
                if (direct) return direct.innerText.trim();
            }
            // Walk up to 6 parent levels looking for a label or descriptive text
            let parent = el.parentElement;
            for (let i = 0; i < 6; i++) {
                if (!parent || parent === modal) break;
                const label = parent.querySelector('label:not(:has(input)):not(:has(select)):not(:has(textarea)), legend');
                if (label) return label.innerText.trim();
                const span = parent.querySelector('span[class*="label"], div[class*="label"], p[class*="label"]');
                if (span) return span.innerText.trim();
                parent = parent.parentElement;
            }
            // Last resort: placeholder text is better than nothing
            if (el.placeholder) return el.placeholder.trim();
            return '';
        }

        // Scroll inside the modal to trigger any lazy-rendered fields before extracting
        try {
            const scrollable = modal.querySelector('.jobs-easy-apply-modal__content, [class*="easy-apply"], .artdeco-modal__content') || modal;
            scrollable.scrollTop = scrollable.scrollHeight;
            scrollable.scrollTop = 0;
        } catch (e) { }

        // Walk up DOM to find section heading context (e.g., "Work Experience", "Education")
        function findGroupContext(el) {
            let parent = el.parentElement;
            for (let i = 0; i < 10; i++) {
                if (!parent || parent === modal) break;
                const heading = parent.querySelector('h3, h4, .t-16, .t-bold');
                if (heading && heading.innerText.trim()) return heading.innerText.trim();
                parent = parent.parentElement;
            }
            return '';
        }

        // Find text inputs — cast a wide net: LinkedIn-specific class + generic type selectors
        // Skip hidden or invisible empty inputs (UI chrome, not actual form fields)
        const inputs = modal.querySelectorAll([
            'input.artdeco-text-input--input',
            'input[type="text"]',
            'input[type="number"]',
            'input[type="tel"]',
            'input[type="email"]',
            'textarea'
        ].join(', '));
        // IDs and labels that belong to LinkedIn's search bar / page chrome — NOT application fields
        const SKIP_IDS = ['jobs-search-box-keyword', 'jobs-search-box-location', 'global-nav'];
        const SKIP_LABELS = ['search by title', 'city, state, or zip', 'search jobs'];

        inputs.forEach(input => {
            if (input.offsetParent === null && !input.value) return; // skip invisible+empty
            // Skip LinkedIn search bar and nav inputs
            if (input.id && SKIP_IDS.some(s => input.id.includes(s))) return;
            const labelText = findLabelText(input);
            if (labelText && SKIP_LABELS.some(s => labelText.toLowerCase().includes(s))) return;
            if (labelText) {
                const isTypeahead = !!(input.closest('[class*="typeahead"]') ||
                    input.getAttribute('role') === 'combobox' ||
                    input.closest('[class*="autocomplete"]'));
                const fieldType = input.type === 'number' ? 'number' :
                    input.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text';
                fields.push({
                    id: input.id || '',
                    type: fieldType,
                    label: labelText,
                    placeholder: input.placeholder || '',
                    currentValue: input.value || '',
                    required: input.required || input.getAttribute('aria-required') === 'true',
                    maxLength: input.maxLength > 0 && input.maxLength < 100000 ? input.maxLength : undefined,
                    min: input.min !== '' ? input.min : undefined,
                    max: input.max !== '' ? input.max : undefined,
                    isTypeahead: isTypeahead,
                    groupContext: findGroupContext(input)
                });
            }
        });

        // Find required checkboxes (e.g. "I authorize", "right to work", follow company)
        modal.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            if (cb.offsetParent === null) return; // skip invisible
            const labelText = findLabelText(cb);
            if (labelText) {
                fields.push({
                    id: cb.id || '',
                    name: cb.name || '',
                    type: 'checkbox',
                    label: labelText,
                    checked: cb.checked
                });
            }
        });

        // Find Select Dropdowns
        const selects = modal.querySelectorAll('select');
        selects.forEach(select => {
            const labelText = findLabelText(select);
            const options = Array.from(select.options).map(o => o.innerText.trim()).filter(t => t !== 'Select an option');
            if (labelText && options.length > 0) {
                fields.push({
                    id: select.id || '',
                    type: 'select',
                    label: labelText,
                    options: options
                });
            }
        });

        // Find Radio buttons
        // Skip known LinkedIn UI controls that aren't application form fields
        const SKIP_RADIO_NAMES = ['date-posted-filter-value', 'sortBy', 'f_TPR', 'f_WT'];
        const fieldsets = modal.querySelectorAll('fieldset');
        fieldsets.forEach(fieldset => {
            const legend = fieldset.querySelector('legend');
            if (legend) {
                const radios = fieldset.querySelectorAll('input[type="radio"]');
                const radioOptions = [];
                let nameStr = "";
                radios.forEach(r => {
                    nameStr = r.name;
                    const rLabel = fieldset.querySelector(`label[for="${r.id}"]`);
                    if (rLabel) radioOptions.push(rLabel.innerText.trim());
                });

                if (radioOptions.length > 0 && !SKIP_RADIO_NAMES.includes(nameStr)) {
                    fields.push({
                        name: nameStr,
                        type: 'radio',
                        label: legend.innerText.trim(),
                        options: radioOptions
                    });
                }
            }
        });

        return fields;
    });
}

// Extract form fields from an external company ATS page (generic)
async function extractExternalFormFields(page) {
    return await page.evaluate(() => {
        const fields = [];

        function findLabel(el) {
            if (el.id) {
                const lbl = document.querySelector(`label[for="${el.id}"]`);
                if (lbl) return lbl.innerText.trim();
            }
            if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
            if (el.placeholder) return el.placeholder.trim();
            let parent = el.parentElement;
            for (let i = 0; i < 5; i++) {
                if (!parent) break;
                const lbl = parent.querySelector('label, legend');
                if (lbl && !lbl.contains(el)) return lbl.innerText.trim();
                parent = parent.parentElement;
            }
            if (el.name) return el.name.replace(/[_\-]/g, ' ');
            return '';
        }

        // Text / email / tel / number / url inputs
        document.querySelectorAll('input').forEach(input => {
            if (['hidden', 'file', 'submit', 'button', 'checkbox', 'radio', 'image'].includes(input.type)) return;
            if (input.offsetParent === null && !input.value) return; // skip invisible empty
            const label = findLabel(input);
            if (label) fields.push({ id: input.id || '', name: input.name || '', type: input.type === 'number' ? 'number' : 'text', label, placeholder: input.placeholder || '' });
        });

        // Textareas
        document.querySelectorAll('textarea').forEach(ta => {
            const label = findLabel(ta);
            if (label) fields.push({ id: ta.id || '', name: ta.name || '', type: 'textarea', label });
        });

        // Selects
        document.querySelectorAll('select').forEach(sel => {
            const label = findLabel(sel);
            const options = Array.from(sel.options).map(o => o.text.trim()).filter(t => t && !/^(select|choose|pick|--|please)/i.test(t));
            if (label && options.length > 0) fields.push({ id: sel.id || '', name: sel.name || '', type: 'select', label, options });
        });

        // Radio fieldsets
        document.querySelectorAll('fieldset').forEach(fs => {
            const legend = fs.querySelector('legend');
            const radios = fs.querySelectorAll('input[type="radio"]');
            const options = [];
            let name = '';
            radios.forEach(r => {
                name = r.name;
                const lbl = document.querySelector(`label[for="${r.id}"]`) || r.closest('label');
                if (lbl) options.push(lbl.innerText.trim());
            });
            if (legend && options.length > 0) fields.push({ name, type: 'radio', label: legend.innerText.trim(), options });
        });

        return fields;
    });
}

// Generate a tailored cover letter as a PDF using AI + Playwright headless rendering
async function generateCoverLetterPDF(jobTitle, companyName, pageText) {
    const coverLetterBranch = beginBranch('cover-letter', 'Cover Letter Agent', `Drafting for ${companyName}`, {
        companyName,
        jobTitle
    });
    logInfo('Generating tailored cover letter...');

    let coverLetterText = '';
    try {
        coverLetterText = await aiProvider.generateCoverLetterText(jobTitle, companyName, pageText);
        if (!coverLetterText) {
            logInfo('Cover letter generation returned empty.');
            finishBranch(coverLetterBranch, 'failed', 'Cover letter text came back empty.', { companyName, jobTitle });
            return null;
        }
        logInfo(`Cover letter generated (${coverLetterText.length} chars).`);
    } catch (e) {
        logInfo(`Cover letter generation error: ${e.message}`);
        finishBranch(coverLetterBranch, 'failed', e.message, { companyName, jobTitle });
        return null;
    }

    // Render as PDF using a headless Playwright browser instance
    const htmlContent = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body { font-family: Georgia, 'Times New Roman', serif; font-size: 12pt; line-height: 1.7; margin: 0; color: #1a1a1a; }
.page { padding: 72px 80px; }
.name { font-size: 20pt; font-weight: bold; margin-bottom: 2px; }
.contact { font-size: 10pt; color: #555; margin-bottom: 32px; border-bottom: 1px solid #ccc; padding-bottom: 12px; }
p { margin: 0 0 14px 0; }
</style></head><body><div class="page">
<div class="name">${escapeHtml(applicantProfile.fullName)}</div>
<div class="contact">${escapeHtml(getCoverLetterContactLine(applicantProfile)).replace(/\|/g, '&nbsp;|&nbsp;')}</div>
${coverLetterText.split('\n').filter(l => l.trim()).map(l => `<p>${escapeHtml(l)}</p>`).join('\n')}
</div></body></html>`;

    const coverLetterPath = path.join(__dirname, 'cover_letter_current.pdf');
    let browser;
    try {
        // Use base playwright (already installed) for headless PDF rendering
        const { chromium: playwrightChromium } = require('playwright');
        browser = await playwrightChromium.launch({ headless: true });
        const pdfCtx = await browser.newContext();
        const pdfPage = await pdfCtx.newPage();
        await pdfPage.setContent(htmlContent, { waitUntil: 'load' });
        await pdfPage.pdf({
            path: coverLetterPath,
            format: 'Letter',
            margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
        });
        logInfo(`Cover letter PDF saved: ${coverLetterPath}`);
        finishBranch(coverLetterBranch, 'completed', 'Tailored cover letter rendered to PDF.', { companyName, jobTitle });
        return coverLetterPath;
    } catch (e) {
        logInfo(`Cover letter PDF render error: ${e.message}`);
        finishBranch(coverLetterBranch, 'failed', e.message, { companyName, jobTitle });
        return null;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// AI calls for form filling are now handled by ai-provider.js

// Handle an external company ATS application page
async function handleExternalApplication(context, page, companyName, jobTitle, jobUrl) {
    const externalBranch = beginBranch('external-ats', 'ATS Agent', `Opening ${companyName} application flow`, {
        companyName,
        jobTitle,
        jobUrl
    });
    emitActivity(`External ATS handoff for ${jobTitle} @ ${companyName}`, {
        stage: 'external-ats',
        companyName,
        jobTitle,
        jobUrl
    });
    logInfo(`Attempting external application for "${jobTitle}" at ${companyName}`);

    // Listen for a new tab before clicking
    const pagePromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
    const applyBtn = page.locator('.jobs-apply-button--top-card button').first();
    await applyBtn.click();
    const newTab = await pagePromise;

    const targetPage = newTab || page;

    // Top-level guard: if the ATS tab closes unexpectedly (e.g. SmartRecruiters auth redirect),
    // we catch the error here. If it was a new tab, we just skip this job — the main LinkedIn
    // page is still alive. If the main page is gone we re-throw to stop the run.
    try {

    try {
        await targetPage.waitForLoadState('domcontentloaded', { timeout: 20000 });
    } catch (e) { }

    const targetUrl = targetPage.url();
    logInfo(`External ATS URL: ${targetUrl}`);

    // Skip platforms too complex to automate reliably
    const tooComplex = ['myworkdayjobs.com', 'workday.com', 'taleo.net', 'icims.com', 'ultipro.com', 'successfactors.com'];
    if (tooComplex.some(p => targetUrl.includes(p))) {
        logInfo(`Complex ATS detected (${targetUrl}). Skipping.`);
        if (newTab) await newTab.close().catch(() => {});
        logSuccess(companyName, jobTitle, "SKIPPED_COMPLEX_ATS", jobUrl);
        finishBranch(externalBranch, 'failed', `Skipped complex ATS: ${targetUrl}`, { companyName, jobTitle, jobUrl });
        return 'SKIPPED_COMPLEX_ATS';
    }

    await humanJitter(targetPage, 2000, 4000);

    // Read the page's visible text so Gemini can tailor answers to this specific job
    const pageText = await targetPage.evaluate(() => document.body.innerText).catch(() => '');
    logInfo(`Read ${pageText.length} characters from external page.`);
    updateBranch(externalBranch, `ATS page loaded and scanned (${pageText.length} chars).`, { companyName, jobTitle, jobUrl });

    // --- COVER LETTER GENERATION ---
    // Generate a tailored cover letter PDF in parallel while we prep the form
    const coverLetterPathPromise = generateCoverLetterPDF(jobTitle, companyName, pageText);

    // --- RESUME + COVER LETTER UPLOAD ---
    const coverLetterPath = await coverLetterPathPromise;

    // --- SMART FILE UPLOAD: match file inputs by label context ---
    if (fs.existsSync(RESUME_PATH)) {
        try {
            // Find all file inputs and their associated labels
            const fileInputInfo = await targetPage.evaluate(() => {
                const inputs = document.querySelectorAll('input[type="file"]');
                return Array.from(inputs).map((input, idx) => {
                    let label = '';
                    if (input.id) {
                        const lbl = document.querySelector(`label[for="${input.id}"]`);
                        if (lbl) label = lbl.innerText.trim();
                    }
                    if (!label && input.getAttribute('aria-label')) label = input.getAttribute('aria-label').trim();
                    if (!label) {
                        let parent = input.parentElement;
                        for (let i = 0; i < 5; i++) {
                            if (!parent) break;
                            const lbl = parent.querySelector('label, .label, h3, h4, legend, span[class*="label"]');
                            if (lbl && !lbl.contains(input)) { label = lbl.innerText.trim(); break; }
                            parent = parent.parentElement;
                        }
                    }
                    if (!label && input.name) label = input.name;
                    return { index: idx, label: label.toLowerCase(), accept: input.accept || '' };
                });
            });
            logInfo(`Found ${fileInputInfo.length} file input(s): ${fileInputInfo.map(f => `"${f.label}"`).join(', ')}`);

            const fileInputs = targetPage.locator('input[type="file"]');
            let resumeUploaded = false;
            let coverLetterUploaded = false;

            for (const info of fileInputInfo) {
                if (!resumeUploaded && /resume|cv|curriculum/i.test(info.label)) {
                    try {
                        await fileInputs.nth(info.index).setInputFiles(RESUME_PATH, { timeout: 5000 });
                        logInfo(`Resume uploaded to file input "${info.label}" (index ${info.index}).`);
                        resumeUploaded = true;
                        await humanJitter(targetPage, 1000, 2000);
                    } catch (e) { logInfo(`Resume upload failed: ${e.message}`); }
                } else if (!coverLetterUploaded && /cover.?letter|letter/i.test(info.label) && coverLetterPath && fs.existsSync(coverLetterPath)) {
                    try {
                        await fileInputs.nth(info.index).setInputFiles(coverLetterPath, { timeout: 5000 });
                        logInfo(`Cover letter PDF uploaded to file input "${info.label}" (index ${info.index}).`);
                        coverLetterUploaded = true;
                        await humanJitter(targetPage, 1000, 2000);
                    } catch (e) { logInfo(`Cover letter upload failed: ${e.message}`); }
                }
            }

            // Fallback: if no label matched, upload resume to first, cover letter to second
            if (!resumeUploaded && fileInputInfo.length >= 1) {
                try {
                    await fileInputs.nth(0).setInputFiles(RESUME_PATH, { timeout: 5000 });
                    logInfo('Resume uploaded to file input 0 (fallback).');
                    resumeUploaded = true;
                    await humanJitter(targetPage, 1000, 2000);
                } catch (e) { logInfo(`Resume fallback upload failed: ${e.message}`); }
            }
            if (!coverLetterUploaded && fileInputInfo.length >= 2 && coverLetterPath && fs.existsSync(coverLetterPath)) {
                try {
                    await fileInputs.nth(1).setInputFiles(coverLetterPath, { timeout: 5000 });
                    logInfo('Cover letter PDF uploaded to file input 1 (fallback).');
                    coverLetterUploaded = true;
                    await humanJitter(targetPage, 1000, 2000);
                } catch (e) { logInfo(`Cover letter fallback upload failed: ${e.message}`); }
            }

            if (fileInputInfo.length === 0) {
                logInfo('No file inputs on page — resume/cover letter upload skipped.');
            }
        } catch (e) {
            logInfo(`File upload error: ${e.message}`);
        }
    } else {
        logInfo(`Resume file not found at: ${RESUME_PATH}`);
    }

    // --- COVER LETTER TEXT FILL: if there's a textarea for cover letter, paste the text ---
    if (coverLetterPath) {
        try {
            const coverLetterTextarea = targetPage.locator('textarea').filter({ has: targetPage.locator('..') });
            const allTextareas = await targetPage.locator('textarea').all();
            for (const ta of allTextareas) {
                const label = await ta.evaluate(el => {
                    if (el.id) { const lbl = document.querySelector(`label[for="${el.id}"]`); if (lbl) return lbl.innerText.trim(); }
                    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
                    if (el.placeholder) return el.placeholder.trim();
                    let p = el.parentElement;
                    for (let i = 0; i < 4; i++) { if (!p) break; const l = p.querySelector('label'); if (l) return l.innerText.trim(); p = p.parentElement; }
                    return '';
                }).catch(() => '');
                if (/cover.?letter/i.test(label)) {
                    // Read the generated cover letter text and paste it
                    const coverText = await aiProvider.generateCoverLetterText(jobTitle, companyName, pageText);
                    if (coverText) {
                        await ta.fill(coverText, { timeout: 5000 });
                        logInfo(`Cover letter text pasted into textarea "${label}".`);
                    }
                    break;
                }
            }
        } catch (e) {
            logInfo(`Cover letter textarea fill: ${e.message}`);
        }
    }

    await humanJitter(targetPage, 1000, 2000);

    // Extract and fill text/select/radio fields
    const fields = await extractExternalFormFields(targetPage);
    logInfo(`Found ${fields.length} field(s) on external page.`);

    if (fields.length > 0) {
        const externalFillBranch = beginBranch('external-form', 'External Form Agent', `Mapping ${fields.length} ATS fields`, {
            companyName,
            jobTitle,
            fieldCount: fields.length
        });
        const aiDecisions = await aiProvider.getExternalFormFillAnswers(fields, pageText);
        finishBranch(externalFillBranch, 'completed', `Prepared ${aiDecisions.length} ATS answers.`, {
            companyName,
            jobTitle,
            fieldCount: fields.length,
            decisionCount: aiDecisions.length
        });
        for (const decision of aiDecisions) {
            try {
                const byId = decision.id ? `[id="${decision.id}"]` : null;
                const byName = decision.name ? `[name="${decision.name}"]` : null;
                const primary = byId || byName;

                if (decision.type === 'text' || decision.type === 'textarea' || decision.type === 'number') {
                    const val = String(decision.value);
                    if (primary) {
                        await targetPage.locator(primary).first().fill(val, { timeout: 5000 });
                    } else if (decision.label) {
                        await targetPage.getByLabel(decision.label, { exact: false }).first().fill(val, { timeout: 5000 });
                    }
                } else if (decision.type === 'select') {
                    if (primary) {
                        await targetPage.locator(primary).first().selectOption({ label: decision.value }, { timeout: 5000 });
                    } else if (decision.label) {
                        await targetPage.getByLabel(decision.label, { exact: false }).first().selectOption({ label: decision.value }, { timeout: 5000 });
                    }
                } else if (decision.type === 'radio' && decision.name) {
                    await targetPage.locator(`input[type="radio"][name="${decision.name}"][value="${decision.value}"]`).check({ force: true, timeout: 5000 }).catch(async () => {
                        await targetPage.locator(`label`).filter({ hasText: new RegExp(`^${decision.value}$`, 'i') }).first().click({ timeout: 5000 });
                    });
                }
                await humanJitter(targetPage, 300, 800);
            } catch (e) {
                logInfo(`External fill error for "${decision.label || decision.id}": ${e.message}`);
            }
        }
    }

    // Try to find and click a submit/apply button
    const submitBtn = targetPage.locator([
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Submit Application")',
        'button:has-text("Submit")',
        'button:has-text("Apply Now")',
        'button:has-text("Apply")',
        'button:has-text("Send Application")',
    ].join(', ')).first();

    if (await submitBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        // Check for empty required fields before submitting
        const emptyRequired = await targetPage.evaluate(() => {
            const required = document.querySelectorAll('input[required], textarea[required], select[required], [aria-required="true"]');
            const empty = [];
            required.forEach(el => {
                if (el.type === 'hidden' || el.type === 'file') return;
                if (!el.value || el.value.trim() === '' || el.value === 'Select an option') {
                    const label = el.getAttribute('aria-label') || el.placeholder || el.name || el.id || 'unknown';
                    empty.push(label);
                }
            });
            return empty;
        }).catch(() => []);

        if (emptyRequired.length > 0) {
            logInfo(`WARNING: ${emptyRequired.length} required field(s) still empty: ${emptyRequired.join(', ')}`);
            logInfo('Leaving page open for manual review instead of submitting incomplete form.');
            logSuccess(companyName, jobTitle, "EXTERNAL_PARTIAL_MISSING_FIELDS", jobUrl);
            finishBranch(externalBranch, 'failed', `Missing required ATS fields: ${emptyRequired.join(', ')}`, { companyName, jobTitle, jobUrl });
            // Don't close the tab — let user see what's missing
            return 'EXTERNAL_PARTIAL';
        }

        const urlBefore = targetPage.url();
        logInfo('Submitting external application...');
        await submitBtn.click();
        await humanJitter(targetPage, 3000, 5000);

        // Verify submission: check for success indicators
        const verification = await targetPage.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            const hasSuccess = /thank you|application (has been |was )?submitted|application received|successfully applied|we('ve| have) received/i.test(text);
            const hasError = /error|failed|please fix|required field|something went wrong/i.test(text);
            return { hasSuccess, hasError, bodySnippet: text.substring(0, 300) };
        }).catch(() => ({ hasSuccess: false, hasError: false, bodySnippet: '' }));

        const urlAfter = targetPage.url();
        const urlChanged = urlAfter !== urlBefore;

        if (verification.hasSuccess || urlChanged) {
            logInfo(`External application VERIFIED — ${verification.hasSuccess ? 'success message found' : 'page URL changed after submit'}.`);
            logSuccess(companyName, jobTitle, "APPLIED_EXTERNAL", jobUrl);
            if (newTab) await newTab.close().catch(() => {});
            finishBranch(externalBranch, 'completed', 'External ATS submission verified.', { companyName, jobTitle, jobUrl });
            return 'APPLIED_EXTERNAL';
        } else if (verification.hasError) {
            logInfo(`Submission may have failed — error message detected on page. Leaving open for review.`);
            logSuccess(companyName, jobTitle, "EXTERNAL_SUBMIT_ERROR", jobUrl);
            finishBranch(externalBranch, 'failed', 'ATS submit returned an error signal.', { companyName, jobTitle, jobUrl });
            return 'EXTERNAL_PARTIAL';
        } else {
            // No clear signal — log as applied but note it's unverified
            logInfo('Submit clicked but no clear success/error signal. Logging as applied (unverified).');
            logSuccess(companyName, jobTitle, "APPLIED_EXTERNAL_UNVERIFIED", jobUrl);
            if (newTab) await newTab.close().catch(() => {});
            finishBranch(externalBranch, 'completed', 'External ATS submit clicked; verification signal was unclear.', { companyName, jobTitle, jobUrl });
            return 'APPLIED_EXTERNAL';
        }
    } else {
        logInfo('No submit button found on external page — leaving it open for manual review.');
        logSuccess(companyName, jobTitle, "EXTERNAL_PARTIAL", jobUrl);
        finishBranch(externalBranch, 'failed', 'No external submit button found.', { companyName, jobTitle, jobUrl });
        return 'EXTERNAL_PARTIAL';
    }

    } catch (e) {
        // If a new tab (ATS tab) was closed by the remote site, skip this job and continue.
        // Only re-throw if the main LinkedIn page is gone (entire browser dead).
        if (e.message && e.message.includes('context or browser has been closed')) {
            if (newTab) {
                logInfo(`External ATS tab closed unexpectedly — skipping "${jobTitle}" at ${companyName}.`);
                await newTab.close().catch(() => {});
                logSuccess(companyName, jobTitle, "FAILED/INCOMPLETE", jobUrl);
                finishBranch(externalBranch, 'failed', 'ATS tab closed by remote site.', { companyName, jobTitle, jobUrl });
                return 'FAILED';
            }
        }
        throw e; // main page gone or unknown error — let the outer handler stop the run
    }
}

// Function to recursively handle the application modal forms
async function handleApplicationModal(page, companyName, jobTitle, jobUrl) {
    emitActivity(`Easy Apply flow opened for ${jobTitle} @ ${companyName}`, {
        stage: 'easy-apply',
        companyName,
        jobTitle,
        jobUrl
    });
    logInfo('Interactive Loop: Modal detected. Processing forms...');

    let maxPages = 10;
    let success = false;

    while (maxPages > 0) {
        await humanJitter(page, 1500, 3000);
        maxPages--;

        // Check for rate limit error
        const rateLimitMsg = page.locator('text=/limit daily submissions/i, text=/apply tomorrow/i');
        if (await rateLimitMsg.count() > 0 && await rateLimitMsg.first().isVisible()) {
            logInfo('\x1b[31m[RATE LIMIT HIT] LinkedIn is capping your Easy Apply submissions for today.\x1b[0m');
            logSuccess(companyName, jobTitle, "RATE LIMITED", jobUrl);

            try {
                const closeBtn = page.locator('button[aria-label="Dismiss"], button.artdeco-modal__dismiss, button[data-test-modal-close-btn]').filter({ hasText: '' }).first();
                if (await closeBtn.isVisible()) {
                    await closeBtn.click({ force: true });
                } else {
                    await page.keyboard.press('Escape');
                }
                await humanJitter(page, 500, 1000);
                const discardBtn = page.locator('button[data-control-name="discard_application_confirm_btn"], button[data-test-dialog-primary-btn]').first();
                if (await discardBtn.isVisible()) {
                    await discardBtn.click({ force: true });
                }
            } catch (e) { }
            return 'RATE_LIMITED';
        }

        // Check for specific buttons
        const submitBtn = page.locator('button[aria-label="Submit application"], button:has-text("Submit application")').first();
        const reviewBtn = page.locator('button[aria-label="Review your application"], button:has-text("Review")').first();
        const nextBtn = page.locator('button[aria-label="Continue to next step"], button:has-text("Next")').first();

        if (await submitBtn.isVisible()) {
            emitActivity(`Submitting application for ${jobTitle} @ ${companyName}`, {
                stage: 'submit',
                companyName,
                jobTitle,
                jobUrl
            });
            logInfo('Clicking Submit Application...');
            await submitBtn.click();
            success = true;
            await humanJitter(page, 2000, 4000);

            // Wait for dismissal of modal (like specific close X on success screen)
            try {
                const postApplyClose = page.locator('button[aria-label="Dismiss"], button.artdeco-modal__dismiss, button:has-text("Done")').first();
                if (await postApplyClose.isVisible()) {
                    await postApplyClose.click({ force: true });
                } else {
                    await page.keyboard.press('Escape');
                }
            } catch (e) {
                logInfo(`Failed to close post-apply modal: ${e.message}`);
            }
            break;
        }

        // 2. Identify fields to fill on current pagination view
        const extractedFields = await extractFormFields(page);
        const fillResults = [];
        let aiDecisions = [];

        if (extractedFields.length > 0) {
            logInfo(`Found ${extractedFields.length} field(s). Consulting AI...`);
            const formFillBranch = beginBranch('form-fill', 'Form Fill Agent', `Solving ${extractedFields.length} Easy Apply fields`, {
                companyName,
                jobTitle,
                fieldCount: extractedFields.length
            });
            aiDecisions = await aiProvider.getFormFillAnswers(extractedFields);
            finishBranch(formFillBranch, 'completed', `Prepared ${aiDecisions.length} Easy Apply answers.`, {
                companyName,
                jobTitle,
                fieldCount: extractedFields.length,
                decisionCount: aiDecisions.length
            });

            for (const decision of aiDecisions) {
                try {
                    if (decision.type === 'text' || decision.type === 'textarea' || decision.type === 'number') {
                        let val = String(decision.value);
                        // For number fields, strip non-digit characters
                        if (decision.type === 'number') val = val.replace(/[^\d.-]/g, '') || '0';

                        // Check if the matching extracted field was flagged as typeahead
                        const matchedField = extractedFields.find(f => (f.id && f.id === decision.id) || (f.label && f.label === decision.label));
                        const isTypeahead = matchedField && matchedField.isTypeahead;

                        if (decision.id) {
                            logInfo(`Filling [${decision.type}] by id [${decision.id}]: ${val.substring(0, 80)}`);
                            const locator = page.locator(`[id="${decision.id}"]`);
                            if (isTypeahead) {
                                // For typeahead fields, use pressSequentially to trigger keystroke events
                                await locator.clear({ timeout: 3000 }).catch(() => {});
                                await locator.pressSequentially(val, { delay: 50, timeout: 8000 });
                            } else {
                                await locator.fill(val, { force: true, timeout: 5000 });
                            }
                        } else if (decision.label) {
                            logInfo(`Filling [${decision.type}] by label ["${decision.label}"]: ${val.substring(0, 80)}`);
                            const locator = page.getByLabel(decision.label, { exact: false }).first();
                            if (isTypeahead) {
                                await locator.clear({ timeout: 3000 }).catch(() => {});
                                await locator.pressSequentially(val, { delay: 50, timeout: 8000 });
                            } else {
                                await locator.fill(val, { timeout: 5000 });
                            }
                        }
                        // Click first typeahead/autocomplete suggestion if one appears (city, school, company fields)
                        await humanJitter(page, 300, 600);
                        try {
                            const suggestion = page.locator('.basic-typeahead__selectable, [class*="typeahead"] li, [class*="autocomplete"] li').first();
                            if (await suggestion.isVisible({ timeout: 1500 })) {
                                await suggestion.click({ force: true });
                                logInfo(`Clicked typeahead suggestion for "${decision.label || decision.id}"`);
                            }
                        } catch (e) { /* no suggestion appeared, that's fine */ }
                        await humanJitter(page, 500, 1200);
                        fillResults.push({ field: decision.label || decision.id, status: 'filled', value: val });
                    } else if (decision.type === 'select') {
                        const selectLoc = decision.id
                            ? page.locator(`[id="${decision.id}"]`)
                            : page.getByLabel(decision.label, { exact: false }).first();

                        logInfo(`Selecting dropdown ["${decision.label || decision.id}"] option: ${decision.value}`);

                        // Try exact match first, then fuzzy match
                        try {
                            await selectLoc.selectOption({ label: decision.value }, { force: true, timeout: 5000 });
                        } catch (exactErr) {
                            // Fuzzy: find the option containing the AI's text
                            try {
                                const options = await selectLoc.locator('option').allTextContents();
                                const match = options.find(o => o.toLowerCase().includes(decision.value.toLowerCase()));
                                if (match) {
                                    await selectLoc.selectOption({ label: match.trim() }, { force: true, timeout: 5000 });
                                    logInfo(`Fuzzy matched select option: "${match.trim()}"`);
                                } else {
                                    throw exactErr; // no fuzzy match, re-throw original
                                }
                            } catch (fuzzyErr) {
                                throw exactErr;
                            }
                        }
                        await humanJitter(page, 500, 1200);
                        fillResults.push({ field: decision.label || decision.id, status: 'filled', value: decision.value });
                    } else if (decision.type === 'radio' && decision.name) {
                        logInfo(`Selecting radio group [${decision.name}] option: ${decision.value}`);
                        // Use lenient matching instead of strict ^value$ regex
                        await page.locator(`fieldset:has(input[name="${decision.name}"]) label`)
                            .filter({ hasText: decision.value })
                            .first()
                            .click({ force: true, timeout: 5000 });
                        await humanJitter(page, 500, 1200);
                        fillResults.push({ field: decision.name, status: 'filled', value: decision.value });
                    } else if (decision.type === 'checkbox') {
                        const shouldCheck = String(decision.value).toLowerCase() === 'true';
                        const cbLoc = decision.id
                            ? page.locator(`[id="${decision.id}"]`)
                            : page.getByLabel(decision.label, { exact: false }).first();
                        const isChecked = await cbLoc.isChecked({ timeout: 3000 }).catch(() => false);
                        if (shouldCheck && !isChecked) {
                            logInfo(`Checking checkbox: "${decision.label}"`);
                            await cbLoc.check({ force: true, timeout: 5000 });
                        } else if (!shouldCheck && isChecked) {
                            await cbLoc.uncheck({ force: true, timeout: 5000 });
                        }
                        await humanJitter(page, 300, 800);
                        fillResults.push({ field: decision.label || decision.id, status: 'filled', value: decision.value });
                    }
                } catch (e) {
                    logInfo(`Failed to fill field "${decision.label || decision.id || decision.name}": ${e.message}`);
                    fillResults.push({ field: decision.label || decision.id || decision.name, status: 'error', error: e.message });
                }
            }
        }

        // 3. Move forward (Review or Next)
        if (await reviewBtn.isVisible()) {
            logInfo('Clicking Review...');
            await reviewBtn.click();
            continue;
        }

        if (await nextBtn.isVisible()) {
            logInfo('Clicking Next...');
            await nextBtn.click();

            // Wait for LinkedIn to render any validation errors before checking
            await humanJitter(page, 1000, 1800);

            const errorText = page.locator('.artdeco-inline-feedback--error');
            if (await errorText.count() > 0 && await errorText.first().isVisible()) {
                const retryBranch = beginBranch('validation-retry', 'Validation Retry Agent', 'LinkedIn rejected the first pass. Preparing a targeted retry.', {
                    companyName,
                    jobTitle,
                    jobUrl
                });
                logInfo('Validation error detected — using targeted error correction...');

                // Extract SPECIFIC validation errors instead of blindly retrying everything
                const validationErrors = await page.evaluate(() => {
                    const errors = [];
                    const errorElements = document.querySelectorAll('.artdeco-inline-feedback--error');
                    errorElements.forEach(errEl => {
                        if (!errEl.offsetParent) return;
                        const errorText = errEl.innerText.trim();
                        // Walk up to find the associated input/select
                        let container = errEl.parentElement;
                        for (let i = 0; i < 5; i++) {
                            if (!container) break;
                            const input = container.querySelector('input, select, textarea');
                            if (input) {
                                // Get label text
                                let label = '';
                                if (input.getAttribute('aria-label')) label = input.getAttribute('aria-label').trim();
                                else if (input.id) {
                                    const lbl = document.querySelector(`label[for="${input.id}"]`);
                                    if (lbl) label = lbl.innerText.trim();
                                }
                                if (!label && input.placeholder) label = input.placeholder.trim();

                                const fieldInfo = {
                                    fieldId: input.id || '',
                                    fieldLabel: label,
                                    fieldType: input.tagName.toLowerCase() === 'select' ? 'select' :
                                        input.type === 'number' ? 'number' : input.type || 'text',
                                    currentValue: input.value || '',
                                    errorMessage: errorText,
                                    required: input.required || input.getAttribute('aria-required') === 'true',
                                    min: input.min !== '' ? input.min : undefined,
                                    max: input.max !== '' ? input.max : undefined
                                };
                                // Capture select options
                                if (input.tagName === 'SELECT') {
                                    fieldInfo.options = Array.from(input.options)
                                        .map(o => o.text.trim())
                                        .filter(t => t !== 'Select an option');
                                }
                                errors.push(fieldInfo);
                                break;
                            }
                            container = container.parentElement;
                        }
                    });
                    return errors;
                });

                if (validationErrors.length > 0) {
                    logInfo(`Found ${validationErrors.length} specific validation error(s):`);
                    validationErrors.forEach(e => logInfo(`  - "${e.fieldLabel}" (${e.fieldId}): ${e.errorMessage}`));

                    // Ask AI to fix ONLY the broken fields, with error context
                    const fixes = await aiProvider.fixFormErrors(validationErrors);
                    updateBranch(retryBranch, `Prepared ${fixes.length} targeted fixes for ${validationErrors.length} errors.`, {
                        companyName,
                        jobTitle,
                        errorCount: validationErrors.length
                    });

                    // Apply targeted fixes
                    for (const fix of fixes) {
                        try {
                            const val = String(fix.value);
                            if (fix.type === 'text' || fix.type === 'textarea' || fix.type === 'number') {
                                const cleanVal = fix.type === 'number' ? val.replace(/[^\d.-]/g, '') || '0' : val;
                                if (fix.id) await page.locator(`[id="${fix.id}"]`).fill(cleanVal, { force: true, timeout: 5000 });
                                else if (fix.label) await page.getByLabel(fix.label, { exact: false }).first().fill(cleanVal, { timeout: 5000 });
                                // Typeahead handling on fix
                                await humanJitter(page, 300, 600);
                                try {
                                    const suggestion = page.locator('.basic-typeahead__selectable, [class*="typeahead"] li, [class*="autocomplete"] li').first();
                                    if (await suggestion.isVisible({ timeout: 1500 })) {
                                        await suggestion.click({ force: true });
                                    }
                                } catch (e) { /* no suggestion */ }
                            } else if (fix.type === 'select') {
                                const selectLoc = fix.id
                                    ? page.locator(`[id="${fix.id}"]`)
                                    : page.getByLabel(fix.label, { exact: false }).first();
                                try {
                                    await selectLoc.selectOption({ label: val }, { force: true, timeout: 5000 });
                                } catch (e) {
                                    const options = await selectLoc.locator('option').allTextContents();
                                    const match = options.find(o => o.toLowerCase().includes(val.toLowerCase()));
                                    if (match) await selectLoc.selectOption({ label: match.trim() }, { force: true, timeout: 5000 });
                                }
                            } else if (fix.type === 'radio' && fix.name) {
                                await page.locator(`fieldset:has(input[name="${fix.name}"]) label`)
                                    .filter({ hasText: fix.value }).first()
                                    .click({ force: true, timeout: 5000 });
                            } else if (fix.type === 'checkbox') {
                                const shouldCheck = val.toLowerCase() === 'true';
                                const cbLoc = fix.id
                                    ? page.locator(`[id="${fix.id}"]`)
                                    : page.getByLabel(fix.label, { exact: false }).first();
                                const isChecked = await cbLoc.isChecked({ timeout: 3000 }).catch(() => false);
                                if (shouldCheck && !isChecked) await cbLoc.check({ force: true, timeout: 5000 });
                                else if (!shouldCheck && isChecked) await cbLoc.uncheck({ force: true, timeout: 5000 });
                            }
                            await humanJitter(page, 300, 700);
                            logInfo(`Fixed field "${fix.label || fix.id}" → "${val.substring(0, 60)}"`);
                        } catch (e) {
                            logInfo(`Fix failed for "${fix.label || fix.id}": ${e.message}`);
                        }
                    }

                    // Log diagnostics
                    formLogger.logFormAttempt(jobTitle, companyName, {
                        extractedFields, aiDecisions, fillResults, validationErrors,
                        finalOutcome: 'RETRY', page: 10 - maxPages
                    });

                    // Try Next one more time after targeted fix
                    if (await nextBtn.isVisible()) {
                        await nextBtn.click();
                        await humanJitter(page, 1000, 1800);
                        const stillError = await errorText.count() > 0 && await errorText.first().isVisible();
                        if (stillError) {
                            logInfo('Still failing after targeted fix. Discarding this application.');
                            finishBranch(retryBranch, 'failed', 'Validation errors remained after the retry attempt.', {
                                companyName,
                                jobTitle,
                                errorCount: validationErrors.length
                            });
                            formLogger.logFormAttempt(jobTitle, companyName, {
                                extractedFields, aiDecisions, fillResults, validationErrors,
                                finalOutcome: 'FAILED_AFTER_RETRY', page: 10 - maxPages
                            });
                            break;
                        }
                        finishBranch(retryBranch, 'completed', 'Validation retry resolved the blocking errors.', {
                            companyName,
                            jobTitle,
                            errorCount: validationErrors.length
                        });
                        continue;
                    }
                } else {
                    logInfo('Validation errors visible but could not identify specific failing fields. Discarding.');
                    finishBranch(retryBranch, 'failed', 'Validation errors were visible but could not be matched to fields.', {
                        companyName,
                        jobTitle
                    });
                    formLogger.logFormAttempt(jobTitle, companyName, {
                        extractedFields, aiDecisions, fillResults, validationErrors: [],
                        finalOutcome: 'FAILED_UNKNOWN_ERRORS', page: 10 - maxPages
                    });
                    break;
                }
            }
            continue;
        }

        // If we get here, no navigable button was found, might be stuck
        logInfo('No Next/Review/Submit buttons found. Breaking loop.');
        break;
    }

    if (success) {
        logSuccess(companyName, jobTitle, "APPLIED", jobUrl);
        return 'APPLIED';
    } else {
        logSuccess(companyName, jobTitle, "FAILED/INCOMPLETE", jobUrl);
        // Force close modal robustly
        try {
            const closeBtn = page.locator('button[aria-label="Dismiss"], button.artdeco-modal__dismiss, button[data-test-modal-close-btn]').filter({ hasText: '' }).first();
            if (await closeBtn.isVisible()) {
                await closeBtn.click({ force: true });
            } else {
                await page.keyboard.press('Escape');
            }
            await humanJitter(page, 500, 1000);

            const discardBtn = page.locator('button[data-control-name="discard_application_confirm_btn"], button[data-test-dialog-primary-btn]').first();
            if (await discardBtn.isVisible()) {
                await discardBtn.click({ force: true });
            }
            await humanJitter(page, 1000, 2000);
        } catch (e) {
            logInfo(`Failed to force close modal: ${e.message}`);
        }
        return 'FAILED';
    }
}

async function run() {
    // Load UI config (set by the dashboard, or defaults if running standalone)
    const config = loadConfig();
    const activeKeywords = Array.isArray(config.activeKeywords) ? config.activeKeywords.filter(Boolean) : [];

    emitAgentEvent('status', {
        status: 'starting',
        headless: !!config.headless,
        userDataDir: USER_DATA_DIR,
        keywords: activeKeywords
    });

    // Validate that OpenAI is configured before starting the worker
    if (!process.env.OPENAI_API_KEY) {
        console.error('\x1b[31m[ERROR] OPENAI_API_KEY is not set in .env!\x1b[0m');
        process.exit(1);
    }
    logInfo(`Loaded config: ${activeKeywords.length} active keyword(s), apply mode: ${config.applyMode}`);

    logInfo(`Initializing Headless Browser Navigator...`);
    logInfo(`Session persistence directory: ${USER_DATA_DIR}`);

    // Launch Chromium containing the user session
    // Provide stealth args and specific window size
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: !!config.headless,
        viewport: { width: 1280, height: 800 },
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-infobars'
        ]
    });
    emitAgentEvent('status', { status: 'running', keywords: activeKeywords });

    const page = await context.newPage();

    // Build LinkedIn search URLs dynamically from active keywords.
    // Only add f_AL=true (Easy Apply filter) when in easy_only mode — otherwise we'd
    // search a pool of Easy Apply-only jobs and find nothing to externally apply to.
    const easyApplyParam = config.applyMode === 'easy_only' ? '&f_AL=true' : '';
    const BASE_LI_URL = `https://www.linkedin.com/jobs/search/?alertAction=viewjobs&distance=25&f_TPR=r604800&f_WT=2&geoId=102221843&keywords=KEYWORD&origin=JOB_SEARCH_PAGE_JOB_FILTER&refresh=true&sortBy=R&spellCorrectionEnabled=true${easyApplyParam}`;
    const keywordPlans = activeKeywords.map(keyword => ({
        keyword,
        searchUrl: BASE_LI_URL.replace('KEYWORD', encodeURIComponent(keyword))
    }));

    for (const { keyword, searchUrl } of keywordPlans) {
        emitAgentEvent('keyword', { status: 'starting', keyword, searchUrl });
        emitActivity(`Scanning LinkedIn for ${keyword}`, {
            stage: 'keyword-search',
            keyword,
            searchUrl
        });
        logInfo(`Navigating to Job Search: ${searchUrl}`);

        try {
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
        } catch (e) {
            if (e.message && e.message.includes('context or browser has been closed')) {
                logInfo('Browser context closed. Cannot continue. Please restart the script.');
                break;
            }
            logInfo(`Navigation error: ${e.message}`);
            continue;
        }
        await humanJitter(page, 3000, 6000);

        // Initial check if we're on the login page instead of job search
        if (page.url().includes('login')) {
            logInfo('\x1b[33m[ACTION REQUIRED] You are not logged in! Please manually log into LinkedIn on the opened browser.\x1b[0m');
            logInfo('Waiting up to 5 minutes for login completion...');

            try {
                await page.waitForNavigation({ url: /.*?linkedin.com\/(feed|jobs).*/, timeout: 300000 });
                logInfo('Login successful! Proceeding...');
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
                await humanJitter(page, 3000, 6000);
            } catch (e) {
                console.error('[ERROR] Login timeout. Exiting pipeline.');
                await context.close();
                process.exit(1);
            }
        }

        // Iterate Pagination loops
        let pageNum = 1;
        while (true) {
            logInfo(`--- Processing Page ${pageNum} ---`);

            // Wait for job cards to appear, to handle slow network, auth walls, or captchas
            const jobCardsQuery = '.job-card-container';

            // Check initially
            let jobCards = await page.locator(jobCardsQuery).all();

            if (jobCards.length === 0) {
                logInfo('\x1b[33m[ACTION REQUIRED] Found 0 job cards. You might be facing an authwall, captcha, or login prompt.\x1b[0m');
                logInfo('Please interact with the browser window to resolve it. Waiting up to 5 minutes for job cards to appear...');

                try {
                    await page.waitForSelector(jobCardsQuery, { timeout: 300000 });
                    jobCards = await page.locator(jobCardsQuery).all();
                    logInfo('Job cards loaded! Proceeding...');
                } catch (e) {
                    console.error('[ERROR] Timeout waiting for job cards. Please restart the script later or adjust the search query.');
                    break;
                }
            }

            // Scroll the left pane incrementally to lazily load all 25 jobs per page
            try {
                await page.evaluate(async () => {
                    const scrollableDiv = document.querySelector('.jobs-search-results-list') || document.querySelector('.scaffold-layout__list');
                    if (scrollableDiv) {
                        for (let s = 0; s < Math.max(10, document.querySelectorAll('.job-card-container').length); s++) {
                            scrollableDiv.scrollBy(0, 800);
                            await new Promise(r => setTimeout(r, 600));
                        }
                    }
                });
            } catch (e) { }

            // Re-fetch now that we lazily scrolled down
            jobCards = await page.locator(jobCardsQuery).all();
            logInfo(`Found ${jobCards.length} job cards on page ${pageNum}.`);

            let rateLimited = false;
            // Iterate through Job listings
            for (let i = 0; i < jobCards.length; i++) {
                const card = jobCards[i];

                // Scroll the element into view and click
                try {
                    await card.scrollIntoViewIfNeeded();
                    await humanJitter(page, 1000, 2000);
                    await card.click();
                    await humanJitter(page, 2000, 4000);

                    // Fetch Job Title and Company from right pane
                    const titleEl = page.locator('.job-details-jobs-unified-top-card__job-title').first();
                    const companyEl = page.locator('.job-details-jobs-unified-top-card__company-name').first();

                    const jobTitle = await titleEl.isVisible() ? await titleEl.innerText() : 'Unknown Role';
                    const companyName = await companyEl.isVisible() ? await companyEl.innerText() : 'Unknown Company';

                    // Filter out pure engineering/research roles not relevant to multimedia/creative AI
                    if (/\bPhD\b|Machine Learning Engineer|ML Engineer|Data Scientist|Data Engineer|\bSoftware Engineer\b|Backend Engineer|Backend Developer|\bAI Research\b|Research Scientist|\bDevOps\b|Cloud Engineer|Infrastructure Engineer|Cybersecurity/i.test(jobTitle)) {
                        logInfo(`Skipping "${jobTitle}" at ${companyName} because it matches a blocked keyword.`);
                        continue;
                    }

                    // Block spam/scam companies and AI data labeling farms
                    const BLOCKED_COMPANIES = [
                        'Crossing Hurdles', 'Mercor', 'Data Annotation', 'Dataannotation',
                        'Outlier', 'Appen', 'Telus International', 'Scale AI', 'Remotasks',
                        'Labelbox', 'Hive', 'Invisible Technologies', 'Alignerr',
                        'Welocalize', 'RWS Group', 'Mindrift'
                    ];
                    if (BLOCKED_COMPANIES.some(bc => companyName.toLowerCase().includes(bc.toLowerCase()))) {
                        logInfo(`Skipping "${jobTitle}" — blocked company: ${companyName}`);
                        logSuccess(companyName, jobTitle, "SKIPPED_BLOCKED_COMPANY", jobUrl);
                        continue;
                    }

                    // Get the direct URL of the job from the current browser address
                    const jobUrl = page.url();

                    emitActivity(`Reviewing ${jobTitle} @ ${companyName}`, {
                        stage: 'job-review',
                        keyword,
                        companyName,
                        jobTitle,
                        jobUrl
                    });
                    logInfo(`Inspecting Job ${i + 1}/${jobCards.length}: ${jobTitle} at ${companyName}`);

                    // Check for Easy Apply first, then fall back to external Apply
                    // LinkedIn uses various selectors for the apply button area
                    const easyApplyBtn = page.locator('.jobs-apply-button--top-card button, .jobs-apply-button button, button.jobs-apply-button').filter({ hasText: /Easy Apply/i }).first();
                    const regularApplyBtn = page.locator('.jobs-apply-button--top-card button, .jobs-apply-button button, button.jobs-apply-button, .jobs-s-apply button, a.jobs-apply-button--top-card, a[href*="apply"], button[aria-label*="Apply"]').filter({ hasNotText: /Easy Apply/i }).filter({ hasText: /Apply/i }).first();

                    if (await easyApplyBtn.isVisible()) {
                        if (config.applyMode === 'external_only') {
                            logInfo('Easy Apply found but External Only mode is active — skipping.');
                            logSuccess(companyName, jobTitle, "SKIPPED_EASY_APPLY_ONLY_MODE", jobUrl);
                        } else {
                            await easyApplyBtn.click();
                            const status = await handleApplicationModal(page, companyName, jobTitle, jobUrl);
                            if (status === 'RATE_LIMITED') {
                                rateLimited = true;
                                break;
                            }
                        }
                    } else if (await regularApplyBtn.isVisible()) {
                        if (config.applyMode === 'easy_only') {
                            logInfo('No Easy Apply button — skipping (Easy Apply Only mode is active).');
                            logSuccess(companyName, jobTitle, "SKIPPED_NO_EASY_APPLY", jobUrl);
                        } else {
                            // 'all' or 'external_only' — go for the external ATS page
                            logInfo('Using external company application page...');
                            await handleExternalApplication(context, page, companyName, jobTitle, jobUrl);
                        }
                    } else {
                        // Debug: log what buttons actually exist in the apply area
                        const applyAreaDebug = await page.evaluate(() => {
                            const btns = document.querySelectorAll('.jobs-apply-button--top-card button, .jobs-apply-button button, button.jobs-apply-button, .jobs-s-apply button, [class*="apply"] button, [class*="apply"] a');
                            return Array.from(btns).map(b => `"${b.textContent.trim().substring(0, 50)}" (tag=${b.tagName}, class=${b.className.substring(0, 60)})`).join(' | ');
                        }).catch(() => 'N/A');
                        logInfo(`No apply button found — already applied or ineligible. Buttons in area: ${applyAreaDebug || 'none'}`);
                        logSuccess(companyName, jobTitle, "SKIPPED/INELIGIBLE", jobUrl);
                    }

                } catch (e) {
                    if (e.message && e.message.includes('context or browser has been closed')) {
                        logInfo('Browser context was closed mid-run. Ending this search URL early.');
                        rateLimited = true; // reuse flag to break outer while loop
                        break;
                    }
                    logInfo(`Error processing job card ${i}: ${e.message}`);
                }
            }

            if (rateLimited) {
                logInfo('Rate limit hit or browser closed. Exiting page loop.');
                break;
            }

            logInfo(`Finished processing Page ${pageNum} payload.`);

            // Attempt to move to the Next Page
            try {
                await page.keyboard.press('Escape'); // clear lingering generic modals before clicking next
            } catch (e) { }

            try {
                const nextPaginationBtn = page.locator(`button[aria-label="Page ${pageNum + 1}"]`);
                if (await nextPaginationBtn.isVisible()) {
                    logInfo(`Found Page ${pageNum + 1} button. Clicking and waiting...`);
                    await nextPaginationBtn.scrollIntoViewIfNeeded();
                    await humanJitter(page, 1000, 2000);
                    await nextPaginationBtn.click({ force: true });
                    await humanJitter(page, 4000, 8000);
                    pageNum++;
                } else {
                    logInfo(`No more pagination buttons found. Reached the end of the search query at Page ${pageNum}!`);
                    break;
                }
            } catch (e) {
                logInfo(`Pagination error (browser may have closed): ${e.message}`);
                break;
            }
        }
        emitAgentEvent('keyword', { status: 'completed', keyword, searchUrl });
        logInfo('Finished processing all pages for this keyword. Moving to next keyword if any...');
    }

    await context.close();
    emitAgentEvent('status', { status: 'completed' });
}

if (require.main === module) {
    run().catch(error => {
        emitAgentEvent('status', { status: 'failed', error: error.message });
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    run
};
