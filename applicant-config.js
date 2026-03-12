const fs = require('fs');
const path = require('path');

const PROFILE_FILE = path.join(__dirname, 'applicant-profile.json');

const DEFAULT_APPLICANT_PROFILE = {
    fullName: 'Your Name',
    email: 'you@example.com',
    phone: '555-555-5555',
    location: 'Your City, ST',
    portfolioUrl: 'https://portfolio.example.com',
    linkedInUrl: 'https://www.linkedin.com/in/your-handle',
    resumeFile: 'resume.pdf',
    resumeContextFile: 'resumeContext.txt',
    desiredSalary: 'Negotiable'
};

function readApplicantProfile() {
    if (!fs.existsSync(PROFILE_FILE)) {
        return { ...DEFAULT_APPLICANT_PROFILE };
    }

    try {
        const raw = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
        return { ...DEFAULT_APPLICANT_PROFILE, ...raw };
    } catch (error) {
        return { ...DEFAULT_APPLICANT_PROFILE };
    }
}

function getResumePath(profile = readApplicantProfile()) {
    return path.resolve(__dirname, profile.resumeFile || DEFAULT_APPLICANT_PROFILE.resumeFile);
}

function getResumeContextPath(profile = readApplicantProfile()) {
    return path.resolve(__dirname, profile.resumeContextFile || DEFAULT_APPLICANT_PROFILE.resumeContextFile);
}

function getPortfolioUrl(profile = readApplicantProfile()) {
    return profile.portfolioUrl || profile.linkedInUrl || DEFAULT_APPLICANT_PROFILE.portfolioUrl;
}

function getDesiredSalary(profile = readApplicantProfile()) {
    return profile.desiredSalary || DEFAULT_APPLICANT_PROFILE.desiredSalary;
}

function getCoverLetterSignature(profile = readApplicantProfile()) {
    return [
        profile.fullName,
        profile.email,
        profile.phone,
        getPortfolioUrl(profile)
    ].filter(Boolean).join(' | ');
}

function getCoverLetterContactLine(profile = readApplicantProfile()) {
    return [
        profile.email,
        profile.phone,
        getPortfolioUrl(profile),
        profile.location
    ].filter(Boolean).join(' | ');
}

module.exports = {
    PROFILE_FILE,
    DEFAULT_APPLICANT_PROFILE,
    readApplicantProfile,
    getResumePath,
    getResumeContextPath,
    getPortfolioUrl,
    getDesiredSalary,
    getCoverLetterSignature,
    getCoverLetterContactLine
};
