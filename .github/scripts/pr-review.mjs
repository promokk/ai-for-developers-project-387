import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REVIEW_BUDGET = 5;
const BUDGET_MARKER = /<!-- kimi-pr-review:budget (\{[^\n]+\}) -->/g;

export function planReviewBudget(comments, { prNumber, runId, runAttempt, headSha }) {
  const runKey = `${runId}:${runAttempt}`;
  const reservations = new Map();
  for (const comment of comments) {
    for (const match of (comment.body ?? "").matchAll(BUDGET_MARKER)) {
      try {
        const marker = JSON.parse(match[1]);
        if (
          marker.pr === prNumber &&
          typeof marker.runId === "string" &&
          typeof marker.runAttempt === "string" &&
          /^[0-9a-f]{40}$/.test(marker.headSha)
        ) {
          reservations.set(`${marker.runId}:${marker.runAttempt}`, marker);
        }
      } catch {
        // Повреждённый служебный маркер не является резервированием.
      }
    }
  }

  const count = reservations.size;
  if (reservations.has(runKey)) {
    return { allowed: true, count, duplicate: true };
  }
  if (count >= REVIEW_BUDGET) {
    return { allowed: false, count, duplicate: false };
  }
  return {
    allowed: true,
    count: count + 1,
    duplicate: false,
    marker: `<!-- kimi-pr-review:budget ${JSON.stringify({
      pr: prNumber,
      runId,
      runAttempt,
      headSha,
    })} -->`,
  };
}

export function buildRefusalComment({ count, headSha, runUrl, runId, runAttempt }) {
  return [
    `<!-- kimi-pr-review:refusal {"runId":"${runId}","runAttempt":"${runAttempt}"} -->`,
    `Авторевью отклонено: бюджет из ${REVIEW_BUDGET} запусков для этого PR исчерпан (${count}/${REVIEW_BUDGET}). Модель не вызывалась.`,
    "",
    `Проверявшийся head: \`${headSha}\`.`,
    `Причина и состояние бюджета: [прогон Actions](${runUrl}). Новые коммиты не сбрасывают лимит; для нового решения нужен новый PR.`,
  ].join("\n");
}

export function extractIssueNumbers(texts) {
  const numbers = new Set();
  for (const text of texts) {
    for (const match of (text ?? "").matchAll(/(?:^|\s|[([])#(\d+)\b/g)) {
      numbers.add(Number(match[1]));
    }
    for (const match of (text ?? "").matchAll(
      /github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)\b/g,
    )) {
      numbers.add(Number(match[1]));
    }
  }
  return [...numbers].slice(0, 10);
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function repository() {
  if (!process.env.GITHUB_REPOSITORY) {
    throw new Error("GITHUB_REPOSITORY обязателен");
  }
  return process.env.GITHUB_REPOSITORY;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} обязателен`);
  }
  return value;
}

function output(values) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
    );
  }
}

function runUrl() {
  return `${requiredEnv("GITHUB_SERVER_URL")}/${repository()}/actions/runs/${requiredEnv("GITHUB_RUN_ID")}`;
}

function listIssueComments(prNumber) {
  return ghJson([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository()}/issues/${prNumber}/comments?per_page=100`,
  ]).flat();
}

function currentPr(prNumber) {
  return ghJson(["api", `repos/${repository()}/pulls/${prNumber}`]);
}

function assertCurrentHead(pr, headSha) {
  if (pr.draft || pr.state !== "open" || pr.head.sha !== headSha) {
    output({ allowed: "false", reason: "stale-head" });
    console.log(`Запуск устарел: ожидался ${headSha}, актуальный ${pr.head.sha}; модель не вызывается.`);
    return false;
  }
  return true;
}

function reserve() {
  const prNumber = Number(requiredEnv("PR_NUMBER"));
  const headSha = requiredEnv("HEAD_SHA");
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("HEAD_SHA должен быть полным SHA");
  }
  const pr = currentPr(prNumber);
  if (!assertCurrentHead(pr, headSha)) {
    return;
  }
  const input = {
    prNumber,
    headSha,
    runId: requiredEnv("GITHUB_RUN_ID"),
    runAttempt: requiredEnv("GITHUB_RUN_ATTEMPT"),
  };
  const comments = listIssueComments(prNumber);
  const plan = planReviewBudget(comments, input);
  if (!plan.allowed) {
    const refusal = buildRefusalComment({ ...input, count: plan.count, runUrl: runUrl() });
    const refusalMarker = `<!-- kimi-pr-review:refusal {"runId":"${input.runId}","runAttempt":"${input.runAttempt}"} -->`;
    if (!comments.some((comment) => comment.body?.includes(refusalMarker))) {
      gh([
        "api",
        "--method",
        "POST",
        `repos/${repository()}/issues/${prNumber}/comments`,
        "--raw-field",
        `body=${refusal}`,
      ]);
    }
    output({ allowed: "false", reason: "budget-exhausted", count: String(plan.count) });
    console.log(`Бюджет исчерпан (${plan.count}/${REVIEW_BUDGET}); отказ опубликован, модель не вызывается. Head: ${headSha}; run: ${runUrl()}`);
    return;
  }

  if (!plan.duplicate) {
    const body = `${plan.marker}\nАвторевью зарезервировало запуск ${plan.count}/${REVIEW_BUDGET} для \`${headSha}\`: [прогон Actions](${runUrl()}).`;
    gh([
      "api",
      "--method",
      "POST",
      `repos/${repository()}/issues/${prNumber}/comments`,
      "--raw-field",
      `body=${body}`,
    ]);
  }
  output({ allowed: "true", reason: plan.duplicate ? "duplicate-delivery" : "reserved", count: String(plan.count) });
  console.log(`${plan.duplicate ? "Повторная доставка уже зарезервирована" : "Запуск зарезервирован"}: ${plan.count}/${REVIEW_BUDGET}, head ${headSha}.`);
}

function checkHead() {
  const prNumber = Number(requiredEnv("PR_NUMBER"));
  const headSha = requiredEnv("HEAD_SHA");
  if (!assertCurrentHead(currentPr(prNumber), headSha)) {
    return;
  }
  output({ allowed: "true", reason: "current-head" });
}

function buildReviewPrompt({ review, pr, files, issues }) {
  return [
    "Проведи независимое read-only ревью PR по профилю github-pr-reviewer.",
    `## REVIEW.md\n\n${review}`,
    `## Pull Request\n\nНомер: ${pr.number}\nНазвание: ${pr.title}\nHead: ${pr.head.sha}\nBase: ${pr.base.sha}\nОписание:\n${pr.body ?? ""}`,
    `## Связанные Issues и спецификации\n\n${JSON.stringify(issues, null, 2)}`,
    `## Diff по файлам\n\n${JSON.stringify(files, null, 2)}`,
  ].join("\n\n");
}

function context() {
  const prNumber = Number(requiredEnv("PR_NUMBER"));
  const headSha = requiredEnv("HEAD_SHA");
  const pr = currentPr(prNumber);
  if (!assertCurrentHead(pr, headSha)) {
    throw new Error("HEAD PR изменился до подготовки контекста");
  }
  const prComments = listIssueComments(prNumber);
  const issueNumbers = extractIssueNumbers([
    pr.title,
    pr.body,
    ...prComments.filter((comment) => comment.user?.type !== "Bot").map((comment) => comment.body),
  ]);
  const issues = issueNumbers.map((number) => {
    const issue = ghJson(["api", `repos/${repository()}/issues/${number}`]);
    if (issue.pull_request) {
      return null;
    }
    const comments = ghJson([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository()}/issues/${number}/comments?per_page=100`,
    ])
      .flat()
      .filter((comment) => comment.user?.type !== "Bot")
      .slice(-50)
      .map((comment) => ({ author: comment.user.login, body: comment.body }));
    return {
      number,
      title: issue.title,
      state: issue.state,
      body: issue.body,
      comments,
    };
  }).filter(Boolean);
  const files = ghJson([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository()}/pulls/${prNumber}/files?per_page=100`,
  ])
    .flat()
    .map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? "Patch omitted by GitHub; inspect the file list and residual risk.",
    }));
  const review = readFileSync("REVIEW.md", "utf8");
  const prompt = buildReviewPrompt({ review, pr, files, issues });
  writeFileSync(`${requiredEnv("RUNNER_TEMP")}/review-prompt.txt`, prompt);
  console.log(`Контекст подготовлен: REVIEW.md, ${files.length} файлов diff, Issues ${issueNumbers.join(", ") || "не указаны"}.`);
}

function prepareFork() {
  const signal = JSON.parse(readFileSync(`${requiredEnv("RUNNER_TEMP")}/fork-signal.json`, "utf8"));
  const prNumber = Number(signal.prNumber);
  if (!Number.isInteger(prNumber) || prNumber < 1 || !/^[0-9a-f]{40}$/.test(signal.headSha ?? "")) {
    throw new Error("Некорректный fork-signal");
  }
  if (String(signal.sourceRunId) !== requiredEnv("SOURCE_RUN_ID")) {
    throw new Error("fork-signal относится к другому workflow run");
  }
  const pr = currentPr(prNumber);
  const valid =
    !pr.draft &&
    pr.state === "open" &&
    pr.head.sha === signal.headSha &&
    pr.base.sha === signal.baseSha &&
    pr.head.repo.full_name !== repository();
  output({
    valid: String(valid),
    prNumber: String(prNumber),
    headSha: signal.headSha,
    baseSha: signal.baseSha,
  });
  console.log(valid ? `Fork PR #${prNumber} подтверждён для read-only ревью ${signal.headSha}.` : "Fork-сигнал устарел или не подтверждён; модель не вызывается.");
}

function runCli() {
  const command = process.argv[2];
  if (command === "reserve") {
    reserve();
  } else if (command === "check-head") {
    checkHead();
  } else if (command === "context") {
    context();
  } else if (command === "prepare-fork") {
    prepareFork();
  } else {
    throw new Error(`Неизвестная команда: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
