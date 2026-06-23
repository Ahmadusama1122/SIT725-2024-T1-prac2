# Apollo Searcher Skill

When searching for prospects:

1. Load ICP criteria (titles, industries, locations, company size)
2. Build Apollo search query with filters
3. Execute search (max 25 results per query)
4. Extract: name, title, company, email, LinkedIn, location
5. Deduplicate against previous searches (check agent memory)
6. Score each lead using the lead-scorer skill

Output: Structured list of qualified leads with scores.
