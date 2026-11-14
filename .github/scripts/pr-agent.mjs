import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function parseAgentCommand(body) {
  if (!body?.startsWith("/agent")) {
    return null;
  }
  const suffix = body.slice("/agent".length);
  if (!/^\s/.test(suffix) || !/\S/.test(suffix)) {
    return null;
  }
  const request = suffix.trim();
  return request === "implement-spec"
    ? { mode: "implement-spec", request }
    : { mode: "pr", request };
}

export function classifyAgentEvent(eventName, event) {
  const comment = event.comment;
  if (
    !comment ||
    !TRUSTED_ASSOCIATIONS.has(comment.author_association) ||
    comment.user?.type === "Bot"
  ) {
    return null;
  }
  const command = parseAgentCommand(comment.body);
  if (!command) {
    return null;
  }
  if (eventName === "pull_request_review_comment") {
    return command.mode === "pr" && event.pull_request
      ? { ...command, number: event.pull_request.number }
      : null;
  }
  if (eventName !== "issue_comment" || !event.issue) {
    return null;
  }
  if (event.issue.pull_request) {
    return command.mode === "pr" ? { ...command, number: event.issue.number } : null;
  }
  return command.mode === "implement-spec"
    ? { ...command, number: event.issue.number }
    : null;
}

export function selectSpecIssue(sourceIssue, children) {
  const openChildren = children.filter((issue) => issue.state === "open" && !issue.pull_request);
  if (openChildren.length === 1) {
    return openChildren[0];
  }
  if (openChildren.length === 0) {
    return sourceIssue;
  }
  throw new Error("implement-spec требует ровно одну открытую дочернюю спецификацию");
}

function ghJson(args) {
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    }),
  );
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

function event() {
  return JSON.parse(readFileSync(requiredEnv("GITHUB_EVENT_PATH"), "utf8"));
}

function repository() {
  return requiredEnv("GITHUB_REPOSITORY");
}

function validate() {
  const name = requiredEnv("GITHUB_EVENT_NAME");
  const payload = event();
  const command = classifyAgentEvent(name, payload);
  if (!command) {
    output({ valid: "false" });
    console.log("Команда пропущена: неподдерживаемый источник, автор или формат.");
    return;
  }
  if (command.mode === "pr") {
    const pr = ghJson(["api", `repos/${repository()}/pulls/${command.number}`]);
    if (
      pr.state !== "open" ||
      pr.head.repo.full_name !== repository() ||
      !/^[0-9a-f]{40}$/.test(pr.head.sha) ||
      !/^[A-Za-z0-9._/-]+$/.test(pr.head.ref) ||
      pr.head.ref.includes("..")
    ) {
      output({ valid: "false" });
      console.log("Write-агент допускает только открытый same-repo PR; fork и устаревший источник пропущены.");
      return;
    }
    output({
      valid: "true",
      mode: command.mode,
      number: String(command.number),
      headSha: pr.head.sha,
      headRef: pr.head.ref,
    });
    console.log(`Same-repo PR #${command.number} подтверждён на ${pr.head.sha}.`);
    return;
  }
  output({ valid: "true", mode: command.mode, number: String(command.number) });
  console.log(`Issue #${command.number} принят для implement-spec.`);
}

function readIssue(number) {
  return ghJson(["api", `repos/${repository()}/issues/${number}`]);
}

function readIssueComments(number) {
  return ghJson([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository()}/issues/${number}/comments?per_page=100`,
  ])
    .flat()
    .slice(-50)
    .map((comment) => ({ author: comment.user.login, body: comment.body }));
}

function context() {
  const mode = requiredEnv("AGENT_MODE");
  const number = Number(requiredEnv("TARGET_NUMBER"));
  const command = parseAgentCommand(event().comment.body);
  if (!command || command.mode !== mode) {
    throw new Error("Команда изменилась или не соответствует режиму");
  }
  let prompt;
  if (mode === "implement-spec") {
    const source = readIssue(number);
    const children = ghJson(["api", `repos/${repository()}/issues/${number}/sub_issues`]);
    const spec = selectSpecIssue(source, children);
    prompt = [
      "Выполни проверенную команду /agent implement-spec. Новая ветка уже создана от origin/main.",
      "Реализуй спецификацию и тесты, но не коммить и не создавай PR: это сделает workflow.",
      `Исходный Issue:\n${JSON.stringify({ ...source, comments: readIssueComments(number) }, null, 2)}`,
      `Связанная спецификация:\n${JSON.stringify({ ...spec, comments: readIssueComments(spec.number) }, null, 2)}`,
      "Следуй основному, негативному и соседнему сценариям спецификации. Не реализуй другие задачи.",
    ].join("\n\n");
    output({ specNumber: String(spec.number) });
  } else {
    const pr = ghJson(["api", `repos/${repository()}/pulls/${number}`]);
    if (pr.head.sha !== requiredEnv("HEAD_SHA") || pr.head.repo.full_name !== repository()) {
      throw new Error("PR head изменился после проверки");
    }
    prompt = [
      `Выполни текущую проверенную команду в same-repo PR #${number}: ${command.request}`,
      `PR и последние комментарии:\n${JSON.stringify({ ...pr, comments: readIssueComments(number) }, null, 2)}`,
      `Checkout соответствует точному head ${pr.head.sha}. Измени код и тесты по запросу, не меняй main, не коммить и не делай push.`,
      "Если запрос требует выйти за ограничения профиля или неясен, не изменяй файлы и объясни причину.",
    ].join("\n\n");
  }
  writeFileSync(`${requiredEnv("RUNNER_TEMP")}/agent-prompt.txt`, prompt);
}

function runCli() {
  const command = process.argv[2];
  if (command === "validate") {
    validate();
  } else if (command === "context") {
    context();
  } else {
    throw new Error(`Неизвестная команда: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
