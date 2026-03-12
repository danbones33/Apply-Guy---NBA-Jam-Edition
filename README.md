# ApplyGuy 🏀

> *"HE'S ON FIRE!"*

ApplyGuy is a local, AI-powered job application bot with a real-time dashboard, multi-agent parallel workers, and a full NBA Jam arcade easter egg hidden inside.

It uses Playwright to drive Chrome, OpenAI (or Gemini) to fill out forms intelligently, and a live Express dashboard so you can watch all the agents work in real time — or just vibe in the arcade.

---

## What it actually does

When you click **Start**, the app:

1. Reads your resume, background, and preferences
2. Spawns multiple independent Chrome workers in parallel
3. Each worker searches LinkedIn for its assigned keywords
4. For each job posting, it decides: Easy Apply, external ATS, or skip
5. If applying, it extracts every form field, sends them to the AI, and fills them out
6. If LinkedIn rejects a field, it reads the exact validation error and asks the AI to fix just that field — not the whole form
7. Generates a tailored cover letter PDF on the fly
8. Logs every outcome in real time back to the dashboard

Everything runs locally. No cloud. No subscription. No black box.

---

## The Secret Characters 🕹️

Here's the part nobody expects.

Hidden inside the dashboard is a **full NBA Jam arcade easter egg**. This isn't just a button with a sound effect. It's a proper arcade sequence:

**How to find it:** Look for the **Press Start** button in the dashboard. It's there. It's waiting.

**What happens:**
- An **initials entry screen** appears — exactly like the one on arcade cabinets in the 90s
- You pick your 3 initials using an on-screen grid keyboard
- Valid initials unlock a **player card** — styled like NBA Jam athlete cards — with a dunk animation
- The crowd goes wild. Literally. There are audio files for this.

**The sound roster:**
- `boomshakalaka.mp3` — the classic. You know the one.
- `cheers.mp3` — crowd reaction
- `Voicy_Welcome to NBA Jam.mp3` — welcome voice
- `Voicy_End of Game - NBA Jam.mp3` — when the run ends

**The visuals:**
- Animated pixel fire strips along the edges (canvas-based, real-time)
- Arcade-style grid borders and scanline effects
- Player dunk animations
- A full **Final Score screen** at the end of a run — styled like the game-over card from NBA Jam — with your application stats and a *"PRESS TIP OFF TO PLAY AGAIN"* prompt

**Why is this here?**

Because *HE'S ON FIRE* is basically the correct description of submitting 40 job applications in one session. The whole thing is a joke about momentum. If you've ever played NBA Jam and got on a streak, you know the feeling. This tool is that, but for LinkedIn.

### Adding your own characters

The player cards are defined in `public/index.html`. Look for the initials-to-player-card mapping. Each entry has:

- A 3-letter initials key (e.g., `"DAN"`)
- A player name
- An image path pointing to a `.png` in the `public/` folder
- An optional animation (`.mp4`) for the dunk sequence

To add your own character:
1. Drop a `.png` (player card image) and optional `.mp4` (dunk animation) in `public/`
2. Find the character map in `index.html`
3. Add your entry with your chosen initials, a name, and the asset filenames
4. Enter those initials at the arcade screen

You can make yourself a character, make your recruiter a character, make your nemesis from a past job a character. It's your arcade cabinet now.

---

## How the system is built

### The server (`server.js`)

The control tower. It:

- Serves the dashboard
- Reads and writes config
- Splits keywords across workers (6 keywords + 3 agents = 2 keywords per agent)
- Clones the base Chrome profile for each agent so they don't fight over the same session file
- Spawns actual separate Node processes — not fake parallel loops
- Parses structured event lines coming back from those workers
- Streams everything to the browser via Server-Sent Events

The dashboard updates you're watching are real events from real worker processes, not front-end animations.

### The agents (`index.js`)

Each agent is a real Node.js child process with its own:

- Keyword lane
- Chrome session (cloned from your base profile)
- State, counters, and logs

It loops through job cards, decides what to do, and emits structured `AGENT_EVENT` JSON lines back to the server as it works.

### The AI layer (`ai-provider.js`)

Abstracts OpenAI and Gemini behind one interface. The AI is called for:

- **Form filling** — extracts field labels, types, options, and asks for structured JSON answers
- **Cover letter generation** — writes a PDF tailored to the specific job posting
- **Validation repair** — when LinkedIn rejects a field, passes only the broken fields and their error messages back to the AI for a targeted fix

OpenAI uses strict JSON schema mode so the output is always parseable. Gemini is a fallback.

### The dashboard (`public/index.html`)

Vanilla HTML/CSS/JS. No framework. Real-time via SSE. Shows:

- Live agent cards with status, branch, and activity
- Global log stream
- Run stats (applied, skipped, failed, rate-limited)
- Config controls (keywords, AI provider, agent count, headless toggle)
- The arcade easter egg

---

## Files you need to create

These four files are required and are **not included in the repo** (they contain your private data):

| File | What it is |
|---|---|
| `.env` | Your API keys |
| `applicant-profile.json` | Your name, email, phone, portfolio URL |
| `resumeContext.txt` | The AI's briefing document about you |
| `resume.pdf` | Your actual resume |

Copy the `.example` versions and fill them in. The example files have placeholder values and inline comments explaining each field.

---

## The most important file: `resumeContext.txt`

This is not just your resume in text form. It's the strategic brain fuel for the entire app.

The AI reads this file every time it fills out an application. The better this file is, the better your applications will be. Think of it less as a resume and more as the pre-game prep session where you tell your coach exactly who you are and what you want.

Put in:

- Years of experience with specific tools
- Industries you've worked in
- Notable projects and achievements
- Work authorization / sponsorship status (write this explicitly — it comes up constantly)
- Preferred job types and locations
- Your portfolio, LinkedIn, and GitHub URLs
- Pre-written answers to common recurring questions

**Good rule:** if a recruiter might ask it in a form, put it in `resumeContext.txt`.

The difference between a mediocre AI fill and a great one is almost entirely in this file.

---

## Setup

### Requirements

- Node.js 20+
- npm
- Google Chrome installed
- OpenAI API key (Gemini optional)
- Your own resume PDF
- Your own background context written in plain text

### Install

```bash
npm install
```

If Playwright doesn't already have Chromium:

```bash
npx playwright install chromium
```

### Create your local files

macOS/Linux:
```bash
cp .env.example .env
cp applicant-profile.example.json applicant-profile.json
cp resumeContext.example.txt resumeContext.txt
cp ui-config.example.json ui-config.json
```

Windows (PowerShell):
```powershell
Copy-Item .env.example .env
Copy-Item applicant-profile.example.json applicant-profile.json
Copy-Item resumeContext.example.txt resumeContext.txt
Copy-Item ui-config.example.json ui-config.json
```

Edit all four files. Add your resume PDF as `resume.pdf`.

### Start

```bash
npm start
```

Open `http://localhost:3000`.

---

## First run

First launch opens a real Chrome window. You'll need to:

1. Log into LinkedIn
2. Solve any captcha or security check
3. Let the session get saved to the local `chrome_profile/` folder

After that, subsequent runs will reuse the saved session and won't need a manual login.

If you set `USER_DATA_DIR` in `.env` to your actual Chrome profile path, close all Chrome windows using that profile before starting — Chrome locks profile directories when it's open.

---

## Configuration

`ui-config.json` controls runtime behavior:

```json
{
  "activeKeywords": ["UI Designer", "Product Designer", "Creative Technologist"],
  "applyMode": "easy_only",
  "easyApplyDailyLimit": 40,
  "aiProvider": "openai",
  "openaiModel": "gpt-4.1",
  "maxConcurrentAgents": 3,
  "headless": false
}
```

| Field | What it does |
|---|---|
| `activeKeywords` | What the agents search for. Spread evenly across workers. |
| `applyMode` | `easy_only`, `external_only`, or `all` |
| `easyApplyDailyLimit` | Stops after this many Easy Apply submissions per day |
| `aiProvider` | `openai` or `gemini` |
| `maxConcurrentAgents` | How many parallel Chrome workers to spawn |
| `headless` | `true` to hide browser windows, `false` to see them |

---

## What the agents can do

Each worker reports one of these outcomes per job:

| Status | Meaning |
|---|---|
| `APPLIED` | LinkedIn Easy Apply submitted |
| `APPLIED_EXTERNAL` | External ATS form filled and submitted |
| `RATE LIMITED` | LinkedIn cut it off for the day |
| `SKIPPED/INELIGIBLE` | Role matched a blocked keyword or blocked company |
| `SKIPPED_BLOCKED_COMPANY` | Company is on the internal skip list |
| `SKIPPED_COMPLEX_ATS` | External form was too complex to handle |
| `FAILED/INCOMPLETE` | Something went wrong mid-application |

There's also a built-in skip list for job titles and company types that are known to be irrelevant or low-quality (data labeling farms, staffing scams, etc.). You can edit this list in `index.js`.

---

## Demo mode

There's a demo start route that generates fake worker events without touching any real job postings. Good for:

- Testing the dashboard UI
- Showing someone how it works
- Recording a demo without submitting anything

Hit `http://localhost:3000` and look for the demo option in the controls.

---

## Customizing the AI prompts

The prompt templates live in `ai-provider.js`. Three main schemas:

- `FORM_FILL_SCHEMA` — structures the response for Easy Apply fields
- `COVER_LETTER_SCHEMA` — controls cover letter format and content
- `ERROR_FIX_SCHEMA` — targeted repair pass for validation failures

Each schema is a JSON Schema passed to OpenAI's structured output mode. You can add new fields, change how answers are formatted, or tune the instructions in the system prompt above each schema.

The core instruction set for form fill currently includes rules like:
- Never skip a field
- For select/radio inputs, return the exact visible option text
- If the context file doesn't have the answer, generate a plausible professional response
- Always check work authorization and right-to-work checkboxes

You can adjust these rules to match your own preferences.

---

## Files created at runtime

These files are generated while the app runs. They're ignored in `.gitignore` and should stay out of git:

| File | What it contains |
|---|---|
| `applied_jobs.md` | Markdown log of every application outcome |
| `daily-stats.json` | Daily counters for easy apply, external, skips, rate limits |
| `cover_letter_current.pdf` | The most recently generated cover letter |
| `form-diagnostics.log` | NDJSON log of form extraction, AI decisions, and validation retries |
| `chrome_profile/` | Base Chrome session (saved login) |
| `chrome_profiles/` | Per-agent cloned sessions for multi-agent runs |

---

## Safety and privacy

Never commit:

- `.env`
- `applicant-profile.json`
- `resumeContext.txt`
- `resume.pdf`
- `cover_letter_current.pdf`
- `chrome_profile/`
- `chrome_profiles/`

The `.gitignore` already covers these, but check before pushing.

---

## Limitations and expectations

- LinkedIn changes its markup periodically. Selectors may break.
- Anti-bot detection may interrupt runs. Sometimes you'll need to solve a captcha.
- External ATS sites are extremely varied. Some will work well, some won't.
- This is an automation assistant, not a universal job-application robot. Expect occasional manual intervention.
- Users are responsible for reviewing platform terms of service before automating applications.

---

## Commands

```bash
npm start       # Start the dashboard server
npm run bot     # Run the LinkedIn bot directly without the dashboard
```

---

## Stack

- **Node.js** — runtime
- **Playwright** + **playwright-extra** + **stealth plugin** — browser automation with anti-detection
- **Express** — server + SSE streaming
- **OpenAI SDK** — GPT-4.1 with strict JSON schema mode
- **Google GenAI SDK** — Gemini Flash (optional fallback)
- **Vanilla HTML/CSS/JS** — dashboard UI, no framework

---

> This project runs entirely on your machine. Your resume, your API keys, your browser session. Nothing goes anywhere you didn't tell it to go.
>
> Also there's an arcade game in it. Enter your initials. You deserve it.
