<div align="center">

<img src="public/logo2.png" width="120" alt="ApplyGuy Logo" />

# ApplyGuy — NBA Jam Edition

### *"HE'S ON FIRE!"*

**A local, AI-powered job application bot with a real-time dashboard,**
**multi-agent parallel workers, and a full NBA Jam arcade easter egg hidden inside.**

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-Latest-2EAD33?style=flat-square)](https://playwright.dev)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4.1-412991?style=flat-square&logo=openai&logoColor=white)](https://openai.com)

</div>

---

<img src="public/court.png" width="100%" alt="Court" />

---

## What It Does

When you click **Start**, the app:

1. Reads your resume, background context, and preferences
2. Spawns multiple independent Chrome workers in parallel
3. Each worker searches LinkedIn for its assigned keywords
4. For each posting: extract fields → send to AI → fill the form → submit
5. If LinkedIn rejects a field, it reads the exact error and fixes **only that field**
6. Generates a tailored cover letter PDF on the fly
7. Logs everything to the live dashboard in real time

Everything runs locally. No cloud. No subscription. No black box.

---

## The Roster 🏀

Three agents ship out of the box. These are your starters.

<div align="center">

| Agent 1 | Agent 2 | Agent 3 |
|:---:|:---:|:---:|
| <img src="public/Agent one .png" width="160" alt="Agent 1" /> | <img src="public/Agent two. .png" width="160" alt="Agent 2" /> | <img src="public/Agent three. .png" width="160" alt="Agent 3" /> |
| `AGENT 1` | `AGENT 2` | `AGENT 3` |
| Turbo: <img src="public/Agent one turbo.png" width="100" alt="Agent 1 Turbo" /> | Turbo: <img src="public/Agent 2. Turbo .png" width="100" alt="Agent 2 Turbo" /> | Turbo: <img src="public/Agent 3 Turbo .png" width="100" alt="Agent 3 Turbo" /> |

</div>

---

## Secret Characters 🕹️

Hidden inside the dashboard is a **full NBA Jam arcade initials system**.

**How to find it:** Look for the `PRESS START` button on the main screen. It's there. It's waiting.

**How it works:**
- An arcade-style initials entry screen appears — exactly like an old cabinet
- Pick your 3 letters from the on-screen grid
- The right combination unlocks a **secret character** and swaps them into your agent lineup
- They get their own dunk animation, player card, and sound effects
- The crowd goes absolutely insane

**The secret roster:**

<div align="center">

| | Character | Initials | Slot |
|:---:|:---:|:---:|:---:|
| <img src="public/stv.png" width="130" alt="Stephen Hawking" /><br><img src="public/stvturbo.png" width="80" alt="Stephen Hawking Turbo" /> | **Stephen Hawking** | `S` `T` `V` | Agent 1 |
| <img src="public/clinton2.png" width="130" alt="Bill Clinton" /><br><img src="public/clinton turbo.png" width="80" alt="Bill Clinton Turbo" /> | **Bill Clinton** | `B` `C` `L` | Agent 2 |
| <img src="public/elon.png" width="130" alt="Elon Musk" /><br><img src="public/elonturbo.png" width="80" alt="Elon Musk Turbo" /> | **Elon Musk** | `E` `L` `N` | Agent 3 |

</div>

Each secret character has their own **dunk video**, **reveal sounds**, and **turbo card**.
Wrong initials? `ACCESS DENIED`. The crowd boos. Try again.

### Adding Your Own Characters

The character map lives in `public/index.html` — look for `SECRET_CHARS`. Each entry is:

```js
{
  code: ['X','Y','Z'],          // 3-letter initials to unlock them
  name: 'Character Name',
  slot: 1,                       // which agent slot they replace (1, 2, or 3)
  normal: '/your-card.png',      // player card image
  turbo: '/your-turbo.png',      // turbo state image
  dunkVideo: '/your-dunk.mp4',   // celebration video
  revealSounds: [...],           // optional audio on reveal
}
```

Drop your `.png`, `.mp4`, and any `.mp3` files in `public/`, add the entry, and your character is in the game. Make yourself a card. Make your old boss a villain. Make your recruiter a power forward. It's your arcade cabinet now.

---

## The Sound System 🔊

The dashboard ships with a full NBA Jam audio roster:

| File | When it plays |
|---|---|
| `boomshakalaka.mp3` | The classic. You know the one. |
| `hes-on-fire-nba-jam.mp3` | On a hot application streak |
| `hes-heating-up_e6Y3nOZ.mp3` | Building momentum |
| `Voicy_Welcome To NBA Jam.mp3` | On run start |
| `Voicy_End of Game - NBA Jam .mp3` | When the run ends |
| `cheers.mp3` / `crowd cheers.mp3` | Successful applications |
| `no-good.mp3` | Rejections |
| `too-easy.mp3` | Easy wins |
| `terrible-shot.mp3` | Bad form fills |
| `rejected.mp3` | Validation failures |
| `referee-whistle.mp3` | Rate limiting |
| `fire.mp3` | Fire effect ambience |
| `menuloop.mp3` | Dashboard idle loop |

---

## How the System Works

### The Server (`server.js`)
The control tower. Serves the dashboard, splits keywords across workers, clones the Chrome profile for each agent, spawns real separate Node processes (not fake parallel loops), and streams live events back to the browser via SSE.

### The Agents (`index.js`)
Each agent is an actual child process with its own keyword lane, its own Chrome session, and its own state. It scans job cards, decides what to do, and emits structured `AGENT_EVENT` lines back to the server as it works.

### The AI Layer (`ai-provider.js`)
Abstracts OpenAI and Gemini behind one interface. Used for:
- **Form filling** — extracts all field labels/types/options, returns structured JSON answers
- **Cover letter generation** — writes a PDF tailored to the specific posting
- **Validation repair** — when LinkedIn rejects a field, sends only the broken fields + error messages back to AI for a targeted fix pass

### The Dashboard (`public/index.html`)
Vanilla HTML/CSS/JS. No framework. Real-time via SSE. Dark arcade theme with pixel fire strips, animated agent cards, live log stream, and the full secret character system.

---

## Setup

### Requirements

- Node.js 20+
- npm
- Google Chrome
- OpenAI API key
- Your resume as a PDF
- Your background written in plain text

### Install

```bash
npm install
npx playwright install chromium
```

### Create your local files

```bash
# macOS/Linux
cp .env.example .env
cp applicant-profile.example.json applicant-profile.json
cp resumeContext.example.txt resumeContext.txt
cp ui-config.example.json ui-config.json
```

```powershell
# Windows (PowerShell)
Copy-Item .env.example .env
Copy-Item applicant-profile.example.json applicant-profile.json
Copy-Item resumeContext.example.txt resumeContext.txt
Copy-Item ui-config.example.json ui-config.json
```

Fill everything in. Add your `resume.pdf`.

### Start

```bash
npm start
```

Open `http://localhost:3000`.

---

## Your Most Important File: `resumeContext.txt`

This isn't just your resume in text form. It's the **AI's full briefing document**.

The AI reads it every single time it fills out a form. The better this file is, the better your applications are. Treat it like the pre-game prep session where you tell your coach everything — years with each tool, work authorization status, salary range, portfolio links, pre-written answers to common recurring questions, the works.

**Good rule:** if a recruiter might ask it in a form, it goes in `resumeContext.txt`.

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
| `activeKeywords` | What the agents search. Split evenly across workers. |
| `applyMode` | `easy_only`, `external_only`, or `all` |
| `easyApplyDailyLimit` | Hard stop after this many Easy Apply submissions |
| `aiProvider` | `openai` or `gemini` |
| `maxConcurrentAgents` | How many parallel Chrome workers to spawn |
| `headless` | `false` to watch them work, `true` to run in background |

---

## Application Statuses

| Status | Meaning |
|---|---|
| `APPLIED` | LinkedIn Easy Apply submitted ✅ |
| `APPLIED_EXTERNAL` | External ATS filled and submitted ✅ |
| `RATE LIMITED` | LinkedIn cut it off for the day |
| `SKIPPED/INELIGIBLE` | Matched a blocked role keyword |
| `SKIPPED_BLOCKED_COMPANY` | Company is on the internal skip list |
| `SKIPPED_COMPLEX_ATS` | External form too complex to handle |
| `FAILED/INCOMPLETE` | Something broke mid-application |

---

## Demo Mode

There's a demo route that generates fake worker events without touching any real jobs — for testing the dashboard, showing someone how it works, or recording without submitting anything.

---

## Stack

- **Node.js** — runtime
- **Playwright** + **playwright-extra stealth** — browser automation with anti-detection
- **Express** + **SSE** — server and real-time dashboard streaming
- **OpenAI SDK** — GPT-4.1 with strict JSON schema mode
- **Google GenAI SDK** — Gemini Flash (optional fallback)
- **Vanilla HTML/CSS/JS** — dashboard UI, no framework, Press Start 2P font

---

## Privacy & Safety

Never commit:
- `.env` (API keys)
- `applicant-profile.json` (your contact info)
- `resumeContext.txt` (your background)
- `resume.pdf`
- `chrome_profile/` or `chrome_profiles/` (browser sessions with saved logins)

The `.gitignore` already covers these.

---

## Limitations

- LinkedIn changes its markup. Selectors may break occasionally.
- Anti-bot detection may interrupt runs. Sometimes you'll need to solve a captcha.
- External ATS sites vary wildly — some work great, some won't.
- Users are responsible for reviewing platform terms before automating applications.

---

<div align="center">

*This project runs entirely on your machine.*
*Your resume, your keys, your browser session. Nothing goes anywhere you didn't send it.*

*Also there's an arcade game in it.*
*Enter your initials. You deserve it.*

<img src="public/logo2.png" width="60" alt="ApplyGuy" />

</div>
