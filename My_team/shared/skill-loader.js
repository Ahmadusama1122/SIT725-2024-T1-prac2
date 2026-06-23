const fs = require('fs');
const path = require('path');
const { AGENTS_DIR } = require('./config');

function loadPersona(agentName) {
  const personaPath = path.join(AGENTS_DIR, agentName, 'persona.md');
  if (!fs.existsSync(personaPath)) {
    throw new Error(`Persona not found for agent: ${agentName}`);
  }
  return fs.readFileSync(personaPath, 'utf-8');
}

function loadSkills(agentName) {
  const skillsDir = path.join(AGENTS_DIR, agentName, 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  return fs.readdirSync(skillsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      name: path.basename(f, '.md'),
      content: fs.readFileSync(path.join(skillsDir, f), 'utf-8'),
    }));
}

function buildSystemPrompt(agentName, projectContext) {
  const persona = loadPersona(agentName);
  const skills = loadSkills(agentName);

  let prompt = `${persona}\n\n`;

  if (skills.length > 0) {
    prompt += `## Available Skills\n\n`;
    for (const skill of skills) {
      prompt += `### ${skill.name}\n${skill.content}\n\n`;
    }
  }

  if (projectContext && Object.keys(projectContext).length > 0) {
    prompt += `## Project Context\n\n`;
    for (const [key, value] of Object.entries(projectContext)) {
      prompt += `### ${key}\n${value}\n\n`;
    }
  }

  return prompt;
}

module.exports = { loadPersona, loadSkills, buildSystemPrompt };
