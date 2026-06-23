const { Octokit } = require('@octokit/rest');
const { GITHUB_TOKEN, GITHUB_OWNER } = require('./config');

let octokit = null;

function getOctokit() {
  if (!octokit && GITHUB_TOKEN) {
    octokit = new Octokit({ auth: GITHUB_TOKEN });
  }
  return octokit;
}

async function createIssue(repo, title, body, labels = []) {
  const ok = getOctokit();
  if (!ok) {
    console.log(`[GitHub] (disabled) Would create issue: ${title}`);
    return null;
  }

  try {
    const { data } = await ok.issues.create({
      owner: GITHUB_OWNER,
      repo,
      title,
      body,
      labels,
    });
    return data;
  } catch (error) {
    console.error('[GitHub] Failed to create issue:', error.message);
    return null;
  }
}

async function getOpenIssues(repo, labels = []) {
  const ok = getOctokit();
  if (!ok) return [];

  try {
    const { data } = await ok.issues.listForRepo({
      owner: GITHUB_OWNER,
      repo,
      state: 'open',
      labels: labels.join(','),
      per_page: 50,
    });
    return data.map(issue => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map(l => l.name),
      source: 'github',
      project: repo,
    }));
  } catch (error) {
    console.error('[GitHub] Failed to fetch issues:', error.message);
    return [];
  }
}

async function commentOnIssue(repo, issueNumber, body) {
  const ok = getOctokit();
  if (!ok) return;

  try {
    await ok.issues.createComment({
      owner: GITHUB_OWNER,
      repo,
      issue_number: issueNumber,
      body,
    });
  } catch (error) {
    console.error('[GitHub] Failed to comment on issue:', error.message);
  }
}

async function closeIssue(repo, issueNumber) {
  const ok = getOctokit();
  if (!ok) return;

  try {
    await ok.issues.update({
      owner: GITHUB_OWNER,
      repo,
      issue_number: issueNumber,
      state: 'closed',
    });
  } catch (error) {
    console.error('[GitHub] Failed to close issue:', error.message);
  }
}

module.exports = { getOctokit, createIssue, getOpenIssues, commentOnIssue, closeIssue };
