/**
 * Calculate a quality score (0-10) for a prospect.
 * Higher scores indicate better-fit prospects.
 */
function calculateQualityScore(prospect) {
  let score = 0;
  const empCount = prospect.employeeCount || 0;
  if (empCount >= 1 && empCount <= 5) score += 2;
  else if (empCount >= 6 && empCount <= 10) score += 1;
  if (prospect.websiteUrl) score += 2;
  const titleLower = (prospect.title || "").toLowerCase();
  if (titleLower.includes("owner") || titleLower.includes("founder")) score += 2;
  else if (titleLower.includes("principal") || titleLower.includes("director")) score += 1;
  if (prospect.emailStatus === "verified") score += 2;
  else if (prospect.source === "web-scraper" && prospect.websiteUrl) score += 1;
  if (prospect.linkedinUrl) score += 1;
  return score;
}

module.exports = { calculateQualityScore };
