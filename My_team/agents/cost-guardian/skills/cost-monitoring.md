# Cost Monitoring Skill

Monitor and control API spending across all agents in the system.

## Workflow

### Step 1: Gather Data
Use your tools in this order:
1. `get_token_usage_report` — get per-agent token totals for the last 24 hours
2. `get_duplicate_detection` — find agents that fired multiple times in short windows
3. `get_agent_run_history` — get detailed run-by-run breakdown for any suspicious agent

### Step 2: Analyze
- Calculate estimated cost per agent using token rates
- Compare each agent's usage to expected ranges based on schedule frequency
- Look for patterns: is usage spiking? Is one agent dominating costs?
- Check for duplicate runs (same agent, same task title, within 30 minutes)
- Check for runaway tool loops (runs with high tool call counts)

### Step 3: Take Action
Based on your analysis:
- `disable_agent` — disable agents that are wasting money (duplicates, runaways, excessive usage)
- `enable_agent` — re-enable agents that were disabled >48h ago to give them another chance
- Report all actions and findings to Discord via your response

### Step 4: Recommendations
Suggest specific changes:
- Should any schedule frequency be reduced further?
- Should any agent switch to a cheaper model?
- Are there agents that could be turned off entirely?
- What's the projected monthly cost at current burn rate?

## Expected Token Budgets (per 24h)
These are rough guides — flag anything significantly above:
- orchestrator routing: ~500 tokens per run (Haiku)
- scheduled agent runs: ~2,000-5,000 tokens each (Haiku)
- user-triggered tasks: ~5,000-15,000 tokens each (Sonnet, acceptable)
- pipelines: ~1,000-3,000 tokens each (Haiku)

## Cost Calculation
- Sonnet input: $3/1M tokens, output: $15/1M tokens
- Haiku input: $0.25/1M tokens, output: $1.25/1M tokens
- Rough estimate: assume 40% input, 60% output for agent calls
- Formula: tokens * ((0.4 * input_rate + 0.6 * output_rate) / 1,000,000)
