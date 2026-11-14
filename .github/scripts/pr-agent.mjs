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

export function acceptanceSuiteForSpec(spec) {
  const text = `${spec.title ?? ""}\n${spec.body ?? ""}`;
  const frontend = text.includes("frontend/tests");
  const backend = text.includes("backend/tests");
  if (frontend === backend) {
    throw new Error("Спецификация должна однозначно указать frontend/tests или backend/tests");
  }
  return frontend
    ? { scope: "frontend", testDirectory: "frontend/tests" }
    : { scope: "backend", testDirectory: "backend/tests" };
}

export function validateTestOnlyPaths(paths, scope) {
  const directory = scope === "frontend" ? "frontend/tests/" : "backend/tests/";
  if (paths.length === 0) {
    throw new Error("Фаза приёмочных тестов не изменила файлы");
  }
  const forbidden = paths.filter((path) => !path.startsWith(directory));
  if (forbidden.length > 0) {
    throw new Error(`Фаза приёмочных тестов изменила недопустимые файлы: ${forbidden.join(", ")}`);
  }
}

export function buildImplementationPrBody({
  phase,
  response,
  issueNumber,
  specNumber,
  runUrl,
  redCommit,
  redCiUrl,
  greenCommit,
}) {
  const green = phase === "implementation";
  const evidence = green
    ? `- **До:** приёмочные тесты в \`${redCommit}\` завершились ожидаемой ошибкой: [red CI](${redCiUrl}).\n  **После:** \`mise run check\` пройден в [прогоне writer](${runUrl}); feature commit \`${greenCommit}\`.`
    : `- **До:** приёмочные тесты спецификации отсутствовали.\n  **После:** тестовый commit \`${redCommit}\` отправлен; релевантный тест локально завершился ожидаемой ошибкой. Red CI запускается для draft PR; прогон writer: ${runUrl}.`;
  return [
    "# Описание PR",
    "",
    "## Краткое описание",
    "",
    response,
    "",
    "Реализация разделена на commit с приёмочными тестами и последующий feature commit.",
    "",
    "## Связанные Issue и спецификация",
    "",
    `- Closes #${specNumber}. Источник команды: Refs #${issueNumber}.`,
    "- Человеческое согласование: команда `/agent implement-spec` доверенного участника и готовая спецификация.",
    "",
    "## Проверки",
    "",
    evidence,
    "- Глубина проверок: основной, негативный и соседний сценарии спецификации; красный результат до реализации обязателен.",
    green
      ? "- Полный `mise run check` выполнен после реализации; PR переведён из draft в ready for review."
      : "- Реализация ещё не выполнялась; PR остаётся draft до зелёного полного `mise run check`.",
    "",
    "## Риск слияния",
    "",
    "**Обратимость:** обратимое.",
    "",
    "**Масштаб влияния:** изменения ограничены связанной спецификацией.",
    "",
    "**Риск:** автоматические проверки не заменяют ревью; слияние выполняет человек.",
    "",
    `**Откат:** revert ${green ? `коммитов \`${redCommit}\` и \`${greenCommit}\`` : `коммита \`${redCommit}\``} через отдельный PR после ревью.`,
  ].join("\n");
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
    const phase = requiredEnv("AGENT_PHASE");
    if (!new Set(["acceptance", "implementation"]).has(phase)) {
      throw new Error(`Неизвестная фаза implement-spec: ${phase}`);
    }
    const source = readIssue(number);
    const children = ghJson(["api", `repos/${repository()}/issues/${number}/sub_issues`]);
    const spec = selectSpecIssue(source, children);
    const suite = acceptanceSuiteForSpec(spec);
    const phaseInstruction =
      phase === "acceptance"
        ? [
            "Фаза 1 из 2: добавь ТОЛЬКО приёмочные тесты спецификации, не меняй реализацию.",
            `Разрешены изменения только в ${suite.testDirectory}. Новые тесты должны воспроизводить основной и требуемые негативный/соседний сценарии и сейчас завершаться ошибкой.`,
            "Не делай тесты зелёными через реализацию или ослабление утверждений. Workflow сам запустит suite, потребует nonzero, закоммитит тесты и создаст draft PR.",
          ]
        : [
            "Фаза 2 из 2: приёмочные тесты уже закоммичены в текущей ветке, а red CI подтверждён.",
            "Реализуй спецификацию поверх этих тестов. Не удаляй и не ослабляй приёмочные утверждения; исправляй реализацию, а не ожидания ради прохождения.",
            "Workflow выполнит полный mise run check, создаст feature commit, отправит его в ту же ветку и переведёт существующий draft PR в ready for review.",
          ];
    prompt = [
      "Выполни проверенную команду /agent implement-spec. Не коммить, не создавай PR и не делай push: это контролирует workflow.",
      ...phaseInstruction,
      `Исходный Issue:\n${JSON.stringify({ ...source, comments: readIssueComments(number) }, null, 2)}`,
      `Связанная спецификация:\n${JSON.stringify({ ...spec, comments: readIssueComments(spec.number) }, null, 2)}`,
      "Следуй основному, негативному и соседнему сценариям спецификации. Не реализуй другие задачи.",
    ].join("\n\n");
    output({ specNumber: String(spec.number), testScope: suite.scope });
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

function assertTestOnly() {
  const output = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "-z"],
    { encoding: "utf8" },
  );
  const paths = [];
  for (const entry of output.split("\0").filter(Boolean)) {
    paths.push(entry.slice(3));
  }
  validateTestOnlyPaths(paths, requiredEnv("TEST_SCOPE"));
  console.log(`Фаза 1 изменила только приёмочные тесты: ${paths.join(", ")}.`);
}

function prBody() {
  const phase = requiredEnv("BODY_PHASE");
  const runUrl = `${requiredEnv("GITHUB_SERVER_URL")}/${repository()}/actions/runs/${requiredEnv("GITHUB_RUN_ID")}`;
  const body = buildImplementationPrBody({
    phase,
    response: readFileSync(`${requiredEnv("RUNNER_TEMP")}/agent-response.md`, "utf8"),
    issueNumber: Number(requiredEnv("ISSUE_NUMBER")),
    specNumber: Number(requiredEnv("SPEC_NUMBER")),
    runUrl,
    redCommit: requiredEnv("RED_COMMIT"),
    redCiUrl: process.env.RED_CI_URL || runUrl,
    greenCommit: phase === "implementation" ? requiredEnv("GREEN_COMMIT") : undefined,
  });
  writeFileSync(`${requiredEnv("RUNNER_TEMP")}/agent-pr-body.md`, body);
}

function runCli() {
  const command = process.argv[2];
  if (command === "validate") {
    validate();
  } else if (command === "context") {
    context();
  } else if (command === "assert-test-only") {
    assertTestOnly();
  } else if (command === "pr-body") {
    prBody();
  } else {
    throw new Error(`Неизвестная команда: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
