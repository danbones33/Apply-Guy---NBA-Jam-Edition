const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'ui-config.json');

const DEFAULT_CONFIG = {
    keywords: [
        'Frontend Developer',
        'Product Designer',
        'Project Manager'
    ],
    activeKeywords: [
        'Frontend Developer',
        'Product Designer',
        'Project Manager'
    ],
    applyMode: 'easy_only',
    easyApplyDailyLimit: 40,
    aiProvider: 'openai',
    openaiModel: 'gpt-4.1',
    maxConcurrentAgents: 5,
    headless: false
};

function readConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return { ...DEFAULT_CONFIG };
    }

    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return { ...DEFAULT_CONFIG, ...raw };
    } catch (error) {
        return { ...DEFAULT_CONFIG };
    }
}

function writeConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...DEFAULT_CONFIG, ...config }, null, 2));
}

module.exports = {
    CONFIG_FILE,
    DEFAULT_CONFIG,
    readConfig,
    writeConfig
};
