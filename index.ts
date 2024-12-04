import { Octokit } from "@octokit/rest"
import * as fs from "fs"
import Anthropic from "@anthropic-ai/sdk"
import { Level } from "level"
import { getRepos } from "./lib/getRepos"
import { generateMarkdown } from "./lib/generateMarkdown"
import { getMergedPRs, type MergedPullRequest } from "./lib/getMergedPRs"
import filterDiff from "./lib/filterDiff"
import { getAllPRs } from "./lib/getAllPRs"
import { getBountiedIssues } from "./lib/getBountiedIssues"
import { getIssuesCreated } from "./lib/getIssuesCreated"

export const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

// Initialize LevelDB
const db = new Level("./pr-analysis-cache", { valueEncoding: "json" })

export interface AnalyzedPR {
  number: number
  title: string
  description: string
  impact: "Major" | "Minor" | "Tiny"
  contributor: string
  repo: string
  url: string
}

async function analyzePRWithClaude(
  pr: MergedPullRequest,
  repo: string,
): Promise<AnalyzedPR> {
  const cacheKey = `${repo}:${pr.number}`

  try {
    // Try to get the analysis from cache
    const cachedAnalysis = JSON.parse(
      await db.get(cacheKey, { valueEncoding: "json" }),
    )
    return cachedAnalysis
  } catch (error) {
    const reducedDiff = filterDiff(pr.diff)

    // If not in cache, perform the analysis
    const prompt = `Analyze the following pull request and provide a one-line description of the change. Also, classify the impact as "Major", "Minor", or "Tiny".

Major Impact: Introduces a huge feature, fixes a critical or difficult bug. Generally difficult to implement.
Minor Impact: Bug fixes, simple feature additions, small improvements. Typically more than 100 lines of code changes. Adding a new symbol.
Tiny Impact: Minor documentation changes, typo fixes, small cosmetic fixes, updates to dependencies.

Title: ${pr.title}
Body: ${pr.body}
Diff:
${reducedDiff.slice(0, 8000)}

Response format:
Description: [One-line description]
Impact: [Major/Minor/Tiny]`

    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    })

    const content = message.content[0].text
    const description =
      content.split("Description:")?.[1]?.split("Impact:")[0] ?? ""
    const impact = content.split("Impact:")?.[1] ?? ""

    const analysis: AnalyzedPR = {
      number: pr.number,
      title: pr.title,
      description: description.replace("Description: ", "").trim(),
      impact: impact?.replace("Impact: ", "")?.trim() as
        | "Major"
        | "Minor"
        | "Tiny",
      contributor: pr.user.login,
      repo,
      url: pr.html_url,
    }

    // Store the analysis in cache
    await db.put(cacheKey, analysis, { valueEncoding: "json" })

    return analysis
  }
}

export async function generateOverview(startDate: string) {
  const startDateString = startDate

  const repos = await getRepos()
  const allPRs: AnalyzedPR[] = []
  const contributorData: Record<
    string,
    {
      reviewsReceived: number
      reviewsRequested: number
      approvals: number
      changesRequested: number
      prsOpened: number
      prsClosed: number
      issuesCreated: number
      bountiedIssuesCount?: number
      bountiedIssuesTotal?: number
    }
  > = {}

  for (const repo of repos) {
    console.log(`Analyzing ${repo}`)

    const prsWithReviews = await getAllPRs(repo, startDate)
    console.log(`Found ${prsWithReviews.length} total PRs`)
    for (const pr of prsWithReviews) {
      if (pr.user.login.includes("renovate")) {
        continue
      }

      const contributor = pr.user.login
      if (!contributorData[contributor]) {
        contributorData[contributor] = {
          reviewsReceived: 0,
          reviewsRequested: 0,
          approvals: 0,
          changesRequested: 0,
          prsOpened: 0,
          prsClosed: 0,
          issuesCreated: 0,
          bountiedIssuesCount: 0,
          bountiedIssuesTotal: 0,
        }
      }

      contributorData[contributor].reviewsReceived += pr.reviewsReceived
      contributorData[contributor].reviewsRequested += pr.reviewsRequested
      contributorData[contributor].approvals += pr.approvals
      contributorData[contributor].changesRequested += pr.changesRequested
      contributorData[contributor].prsOpened += 1
      if (pr.isClosed) contributorData[contributor].prsClosed += 1
    }

    const prs = await getMergedPRs(repo, startDateString)
    console.log(`Found ${prs.length} merged PRs`)
    for (const pr of prs) {
      if (pr.user.login.includes("renovate")) {
        continue
      }
      const analysis = await analyzePRWithClaude(pr, repo)
      allPRs.push(analysis)
    }

    // Fetch and process bountied issues for all contributors in parallel
    const bountiedIssuesPromises = Object.keys(contributorData).map(
      async (contributor) => {
        const bountiedIssues = await getBountiedIssues(
          repo,
          contributor,
          startDateString,
        )

        contributorData[contributor].bountiedIssuesCount =
          (contributorData[contributor].bountiedIssuesCount || 0) +
          bountiedIssues.length
        contributorData[contributor].bountiedIssuesTotal =
          (contributorData[contributor].bountiedIssuesTotal || 0) +
          bountiedIssues.reduce((total, issue) => total + issue.amount, 0)
      },
    )

    // Wait for all bounty fetching to complete
    await Promise.all(bountiedIssuesPromises)

    const getIssuesCreatedPromises = Object.keys(contributorData).map(
      async (contributor) => {
        const issuesCreated = await getIssuesCreated(
          repo,
          contributor,
          startDateString,
        )

        contributorData[contributor].issuesCreated =
          (contributorData[contributor].issuesCreated || 0) + issuesCreated
      },
    )

    await Promise.all(getIssuesCreatedPromises)
  }

  // Group PRs by contributor
  const contributorPRs = allPRs.reduce(
    (acc, pr) => {
      if (!acc[pr.contributor]) {
        acc[pr.contributor] = []
      }
      acc[pr.contributor].push(pr)
      return acc
    },
    {} as Record<string, AnalyzedPR[]>,
  )

  // Sort each contributor's PRs by impact
  const impactOrder = { Major: 3, Minor: 2, Tiny: 1 }
  for (const contributor in contributorPRs) {
    contributorPRs[contributor].sort(
      (a, b) => impactOrder[b.impact] - impactOrder[a.impact],
    )
  }

  // Flatten the sorted PRs back into a single array
  const sortedPRs = Object.values(contributorPRs).flat()

  const markdown = await generateMarkdown(
    sortedPRs,
    contributorData,
    startDateString,
  )
  fs.writeFileSync(`contribution-overviews/${startDateString}.md`, markdown)
  console.log(`Generated contribution-overviews/${startDateString}.md`)

  // Edit the README.md file
  const readme = fs.readFileSync("README.md", "utf8")
  const updatedReadme = readme.replace(
    /<!-- START_CURRENT_WEEK -->[\s\S]*<!-- END_CURRENT_WEEK -->/m,
    `<!-- START_CURRENT_WEEK -->\n\n${markdown}\n\n<!-- END_CURRENT_WEEK -->`,
  )
  fs.writeFileSync("README.md", updatedReadme)

  // Close the database
  await db.close()
}

export async function generateWeeklyOverview() {
  const weekStart = new Date()
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() - 4) // Set to last Wednesday
  const weekStartString = weekStart.toISOString().split("T")[0]
  await generateOverview(weekStartString)
}
