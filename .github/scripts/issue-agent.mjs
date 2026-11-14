import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CATEGORIES = new Set(["bug", "enhancement"]);
const STATES = new Set([
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
]);
const ALLOWED_LABELS = new Set([...CATEGORIES, ...STATES]);
const ACTION_MARKER = /^(?:•\s*)?GITHUB_ACTIONS:\s*(\{.*\})$/;

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} должен быть объектом`);
  }
}

function assertKeys(value, allowed) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Недопустимые поля действия: ${unexpected.join(", ")}`);
  }
}

function validateLabels(labels, name = "labels") {
  if (!Array.isArray(labels)) {
    throw new Error(`Поле ${name} должно быть массивом меток`);
  }
  if (new Set(labels).size !== labels.length) {
    throw new Error(`Поле ${name} содержит повторяющиеся метки`);
  }
  for (const label of labels) {
    if (typeof label !== "string" || !ALLOWED_LABELS.has(label)) {
      throw new Error(`Недопустимая метка: ${label}`);
    }
  }
  return [...labels];
}

function assertRoleCompatibility(labels) {
  if (labels.filter((label) => CATEGORIES.has(label)).length > 1) {
    throw new Error("Нельзя установить несколько категорий");
  }
  if (labels.filter((label) => STATES.has(label)).length > 1) {
    throw new Error("Нельзя установить несколько состояний triage");
  }
}

function validateAction(action) {
  assertObject(action, "Действие");
  if (action.type === "create_issue") {
    assertKeys(action, new Set(["type", "title", "body", "labels", "parent"]));
    if (typeof action.title !== "string" || !action.title.trim() || action.title.length > 256) {
      throw new Error("Название новой задачи должно быть непустой строкой до 256 символов");
    }
    if (typeof action.body !== "string" || action.body.length > 60000) {
      throw new Error("Описание новой задачи должно быть строкой до 60000 символов");
    }
    if (action.parent !== undefined && (!Number.isInteger(action.parent) || action.parent < 1)) {
      throw new Error("Родительская задача должна быть положительным номером issue");
    }
    const labels = validateLabels(action.labels);
    if (
      labels.filter((label) => CATEGORIES.has(label)).length !== 1 ||
      labels.filter((label) => STATES.has(label)).length !== 1
    ) {
      throw new Error("Новая задача должна получить одну категорию и одно состояние triage");
    }
    return { ...action, title: action.title.trim(), labels };
  }

  if (action.type === "update_labels") {
    assertKeys(action, new Set(["type", "issue", "add", "remove"]));
    if (!Number.isInteger(action.issue) || action.issue < 1) {
      throw new Error("Изменяемая задача должна быть положительным номером issue");
    }
    const add = validateLabels(action.add, "add");
    const remove = validateLabels(action.remove, "remove");
    if (add.length + remove.length === 0) {
      throw new Error("Изменение меток должно содержать add или remove");
    }
    if (add.some((label) => remove.includes(label))) {
      throw new Error("Одна метка не может одновременно добавляться и удаляться");
    }
    return { ...action, add, remove };
  }

  throw new Error(`Недопустимый тип действия: ${action.type}`);
}

export function parseAgentResponse(raw) {
  const lines = [];
  let payload;
  for (const line of raw.split("\n")) {
    const match = line.trim().match(ACTION_MARKER);
    if (!match) {
      lines.push(line);
      continue;
    }
    if (payload !== undefined) {
      throw new Error("Ответ содержит несколько блоков GITHUB_ACTIONS");
    }
    try {
      payload = JSON.parse(match[1]);
    } catch {
      throw new Error("GITHUB_ACTIONS должен содержать однострочный JSON-объект");
    }
  }

  if (payload === undefined) {
    return { body: raw.trim(), actions: [] };
  }
  assertObject(payload, "GITHUB_ACTIONS");
  assertKeys(payload, new Set(["actions"]));
  if (!Array.isArray(payload.actions) || payload.actions.length > 5) {
    throw new Error("actions должен быть массивом не более чем из пяти действий");
  }
  return { body: lines.join("\n").trim(), actions: payload.actions.map(validateAction) };
}

export function validateLabelTransition(currentLabels, action) {
  const labels = new Set(currentLabels);
  for (const label of action.remove) {
    labels.delete(label);
  }
  for (const label of action.add) {
    labels.add(label);
  }
  assertRoleCompatibility([...labels]);
  return [...labels];
}

function ghApi(method, path, payload) {
  const args = ["api", "--method", method, path];
  if (payload !== undefined) {
    args.push("--input", "-");
  }
  return execFileSync("gh", args, {
    input: payload === undefined ? undefined : JSON.stringify(payload),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
}

function executeAction(action, repository) {
  if (action.type === "create_issue") {
    const created = JSON.parse(
      ghApi("POST", `repos/${repository}/issues`, {
        title: action.title,
        body: action.body,
        labels: action.labels,
      }),
    );
    if (action.parent !== undefined) {
      ghApi("POST", `repos/${repository}/issues/${action.parent}/sub_issues`, {
        sub_issue_id: created.id,
      });
    }
    const link = `[#${created.number}](${created.html_url})`;
    return `Создана задача ${link} «${created.title}»${action.parent ? ` и связана с #${action.parent}` : ""}.`;
  }

  const path = `repos/${repository}/issues/${action.issue}`;
  const current = JSON.parse(ghApi("GET", path));
  validateLabelTransition(
    current.labels.map((label) => label.name),
    action,
  );
  if (action.add.length > 0) {
    ghApi("POST", `${path}/labels`, { labels: action.add });
  }
  for (const label of action.remove) {
    ghApi("DELETE", `${path}/labels/${encodeURIComponent(label)}`);
  }
  const changes = [
    action.add.length > 0 ? `добавлены: ${action.add.join(", ")}` : "",
    action.remove.length > 0 ? `удалены: ${action.remove.join(", ")}` : "",
  ].filter(Boolean);
  return `Обновлены метки #${action.issue}: ${changes.join("; ")}.`;
}

function runCli() {
  if (process.argv[2] !== "apply") {
    throw new Error(`Неизвестная команда: ${process.argv[2]}`);
  }
  const temp = process.env.RUNNER_TEMP;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!temp || !repository) {
    throw new Error("Переменные RUNNER_TEMP и GITHUB_REPOSITORY обязательны");
  }

  const raw = readFileSync(`${temp}/agent-response.md`, "utf8");
  const { body, actions } = parseAgentResponse(raw);
  const results = actions.map((action) => executeAction(action, repository));
  const comment = [body, ...results].filter(Boolean).join("\n\n");
  if (!comment) {
    throw new Error("Пустой ответ Kimi Code");
  }
  writeFileSync(`${temp}/agent-comment.json`, JSON.stringify({ body: comment }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
