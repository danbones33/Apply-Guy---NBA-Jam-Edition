/**
 * AI Provider Abstraction Layer
 * Supports OpenAI structured outputs for application answers and cover letters.
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const {
    readApplicantProfile,
    getResumeContextPath,
    getPortfolioUrl,
    getDesiredSalary,
    getCoverLetterSignature
} = require('./applicant-config');

// Load resume context once at module load
const applicantProfile = readApplicantProfile();
const resumeContextPath = getResumeContextPath(applicantProfile);
const resumeText = fs.existsSync(resumeContextPath)
    ? fs.readFileSync(resumeContextPath, 'utf8')
    : 'No resume context provided.';
const portfolioUrl = getPortfolioUrl(applicantProfile);
const desiredSalary = getDesiredSalary(applicantProfile);
const locationExample = applicantProfile.location || 'Your City, ST';
const coverLetterSignature = getCoverLetterSignature(applicantProfile);

const CONFIG_FILE = path.join(__dirname, 'ui-config.json');

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
        catch (e) { }
    }
    return {};
}

function logInfo(msg) {
    console.log(`[AI-PROVIDER] ${msg}`);
}

// ─── Structured Output Schema ───────────────────────────────────────────────
// Used by OpenAI's strict JSON schema mode. The model literally cannot produce
// tokens that violate this schema — eliminates JSON parsing failures entirely.

const FORM_FILL_SCHEMA = {
    type: "object",
    properties: {
        decisions: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id:    { type: "string", description: "The HTML element id (empty string if none)" },
                    name:  { type: "string", description: "The HTML element name attribute (empty string if none)" },
                    label: { type: "string", description: "The human-readable field label" },
                    value: { type: "string", description: "The value to fill in (always a string, even for numbers and booleans)" },
                    type:  { type: "string", enum: ["text", "textarea", "number", "select", "radio", "checkbox"] }
                },
                required: ["id", "name", "label", "value", "type"],
                additionalProperties: false
            }
        }
    },
    required: ["decisions"],
    additionalProperties: false
};

const COVER_LETTER_SCHEMA = {
    type: "object",
    properties: {
        coverLetterText: { type: "string", description: "The complete cover letter text, plain text, no markdown" }
    },
    required: ["coverLetterText"],
    additionalProperties: false
};

const ERROR_FIX_SCHEMA = {
    type: "object",
    properties: {
        fixes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id:    { type: "string" },
                    name:  { type: "string" },
                    label: { type: "string" },
                    value: { type: "string" },
                    type:  { type: "string", enum: ["text", "textarea", "number", "select", "radio", "checkbox"] }
                },
                required: ["id", "name", "label", "value", "type"],
                additionalProperties: false
            }
        }
    },
    required: ["fixes"],
    additionalProperties: false
};

// ─── Shared Prompt Builders ──────────────────────────────────────────────────

function buildFormFillPrompt(fields) {
    return `You are an expert AI agent applying for a job on LinkedIn on behalf of the user.
Here is their resume/context:
---
${resumeText}
---
The current form has the following fields that need to be filled. Review the field context and decide what to answer for each.
Context of the fields:
${JSON.stringify(fields, null, 2)}

CRITICAL RULES:
- Answer EVERY single field. Never skip one. Always include both "id", "name", and "label" in your response even if they are empty strings.
- For text/textarea fields: Be creative but truthful to the resume.
- For number-type fields (like years of experience): Return ONLY digits as a string (e.g., "20" not "20 years" or "twenty").
- For select/dropdown fields: Return the EXACT text of one of the available options listed. Pick the closest matching option.
- For radio fields: Return the exact label text of the option to select (like "Yes" or "No").
- For checkbox fields: Return "true" to check, "false" to leave unchecked. ALWAYS check authorization, right-to-work, terms acceptance, and follow-company checkboxes ("true"). Only use "false" for things like "I am a current employee".
- For textarea fields asking open-ended questions (experience, philosophy, values, why interested, etc.), write a full, confident, professional 2-4 sentence answer drawn from the resume context above. Do NOT leave these blank or give one-word answers.
- If a field already has a currentValue that looks correct, keep it (return the same value). Only change pre-filled values if they are clearly wrong.
- If the field has isTypeahead: true, provide a short, clear value that will match a dropdown suggestion (e.g., "${locationExample}" for city, not a long description).
- If the resume does not contain the information (like a portfolio link, random specific skill, desired pay, or demographic questions), make up a highly professional, plausible answer that heavily favors the applicant. For links, use "${portfolioUrl}". For "Yes/No", strongly bias towards "Yes". For text fields requiring a date, use today's date. For Desired Pay, use "${desiredSalary}" or "100000". NEVER SKIP A FIELD.`;
}

function buildExternalFormFillPrompt(fields, pageText) {
    return `You are an expert AI agent applying for a job on behalf of the user.
Here is their resume/context:
---
${resumeText}
---
Here is the text content of the job application page (use this to tailor answers to the specific role):
---
${pageText.substring(0, 4000)}
---
The current form has the following fields that need to be filled:
${JSON.stringify(fields, null, 2)}

CRITICAL RULES:
- Answer EVERY field. Never skip one.
- For textarea/open-ended questions, write a full 2-4 sentence professional answer tailored to this specific job using the resume context and job page content.
- For "cover letter" or "why do you want to work here" fields, write a genuine, role-specific cover letter paragraph.
- For number-type fields (years of experience): Return ONLY digits as a string (e.g., "20").
- For select/dropdown fields: Return the EXACT text of one of the available options listed.
- For Yes/No, strongly bias towards Yes.
- For links/portfolio, use "${portfolioUrl}".
- For salary, use "${desiredSalary}" or "Negotiable".
- For referral/how did you hear, use "LinkedIn job search".`;
}

function buildCoverLetterPrompt(jobTitle, companyName, pageText) {
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    return `Write a professional, tailored cover letter for the following job application.
Job Title: ${jobTitle}
Company: ${companyName}
Job page text (use for context): ${pageText.substring(0, 2000)}

Applicant Resume:
${resumeText}

Write 3-4 tight paragraphs that:
1. Open with a strong hook naming the specific role and company
2. Highlight 2-3 of the most relevant experiences from the resume that match this job
3. Show genuine enthusiasm specific to this company/role
4. Close with a confident, professional call to action

Rules:
- Plain text only. No markdown. No bullet points. No [placeholder brackets].
- Start with the date: ${today}
- Address to: Hiring Manager
- Sign off with: ${coverLetterSignature}
- Keep it under 400 words. Sound human, not templated.`;
}

function buildErrorFixPrompt(errors) {
    return `You are an expert AI agent filling out a job application form. Some fields failed validation and need to be corrected.

Here is the applicant's resume/context:
---
${resumeText}
---

The following fields had validation errors. For each one, I will give you the field details, your previous answer, and the error message. Provide a CORRECTED value.

${errors.map((e, i) => `Field ${i + 1}:
- Label: "${e.fieldLabel}"
- Type: ${e.fieldType}
- Your previous answer: "${e.currentValue}"
- Validation error: "${e.errorMessage}"
${e.options ? `- Available options: ${JSON.stringify(e.options)}` : ''}
${e.min !== undefined ? `- Minimum: ${e.min}` : ''}
${e.max !== undefined ? `- Maximum: ${e.max}` : ''}
${e.required ? '- This field is REQUIRED' : ''}`).join('\n\n')}

RULES:
- Fix each field based on the error message. For example, if it says "Please enter a number", provide only digits.
- For select fields, you MUST pick one of the exact available options listed.
- For number fields, return only digits as a string.
- Return the corrected values only for the fields that had errors.`;
}

// ─── OpenAI Provider ──────────────────────────────────────────────────────────

class OpenAIProvider {
    constructor() {
        const OpenAI = require('openai');
        this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const config = loadConfig();
        this.model = config.openaiModel || 'gpt-4.1';
        logInfo(`OpenAI provider initialized with model: ${this.model}`);
    }

    async _callStructured(prompt, schema, schemaName) {
        try {
            const response = await this.client.responses.create({
                model: this.model,
                input: [{ role: 'user', content: prompt }],
                text: {
                    format: {
                        type: 'json_schema',
                        name: schemaName,
                        schema: schema,
                        strict: true
                    }
                }
            });
            return JSON.parse(response.output_text);
        } catch (e) {
            logInfo(`OpenAI structured call failed: ${e.message}`);
            throw e;
        }
    }

    async getFormFillAnswers(fields) {
        const prompt = buildFormFillPrompt(fields);
        const result = await this._callStructured(prompt, FORM_FILL_SCHEMA, 'form_fill_decisions');
        logInfo(`OpenAI returned ${result.decisions.length} form fill decisions`);
        return result.decisions;
    }

    async getExternalFormFillAnswers(fields, pageText) {
        const prompt = buildExternalFormFillPrompt(fields, pageText);
        const result = await this._callStructured(prompt, FORM_FILL_SCHEMA, 'external_form_fill_decisions');
        logInfo(`OpenAI returned ${result.decisions.length} external form fill decisions`);
        return result.decisions;
    }

    async generateCoverLetterText(jobTitle, companyName, pageText) {
        const prompt = buildCoverLetterPrompt(jobTitle, companyName, pageText);
        const result = await this._callStructured(prompt, COVER_LETTER_SCHEMA, 'cover_letter');
        return result.coverLetterText;
    }

    async fixFormErrors(errors) {
        const prompt = buildErrorFixPrompt(errors);
        const result = await this._callStructured(prompt, ERROR_FIX_SCHEMA, 'error_fixes');
        logInfo(`OpenAI returned ${result.fixes.length} error fixes`);
        return result.fixes;
    }
}

// ─── Provider Factory ─────────────────────────────────────────────────────────

let _providerInstance = null;
let _providerType = null;

function getProvider() {
    if (_providerInstance && _providerType === 'openai') {
        return _providerInstance;
    }

    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set in .env');
    }

    _providerInstance = new OpenAIProvider();
    _providerType = 'openai';
    return _providerInstance;
}

// ─── Exported Interface ───────────────────────────────────────────────────────

module.exports = {
    async getFormFillAnswers(fields) {
        return getProvider().getFormFillAnswers(fields);
    },
    async getExternalFormFillAnswers(fields, pageText) {
        return getProvider().getExternalFormFillAnswers(fields, pageText);
    },
    async generateCoverLetterText(jobTitle, companyName, pageText) {
        return getProvider().generateCoverLetterText(jobTitle, companyName, pageText);
    },
    async fixFormErrors(errors) {
        return getProvider().fixFormErrors(errors);
    },
    getResumeText() {
        return resumeText;
    }
};
