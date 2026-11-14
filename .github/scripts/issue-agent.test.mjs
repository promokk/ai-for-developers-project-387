import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentResponse, validateLabelTransition } from "./issue-agent.mjs";

function createAction(overrides = {}) {
  return {
    type: "create_issue",
    title: "Новая задача",
    body: "Критерии приёмки",
    labels: ["enhancement", "ready-for-agent"],
    parent: 9,
    ...overrides,
  };
}

function updateAction(overrides = {}) {
  return {
    type: "update_labels",
    issue: 9,
    add: ["enhancement"],
    remove: ["needs-triage"],
    ...overrides,
  };
}

test("обычный ответ не запускает действия", () => {
  assert.deepEqual(parseAgentResponse("• Обычный ответ"), {
    body: "• Обычный ответ",
    actions: [],
  });
});

test("блок действий извлекается из ответа CLI", () => {
  const payload = JSON.stringify({ actions: [createAction()] });
  const parsed = parseAgentResponse(`• Готово\n  • GITHUB_ACTIONS: ${payload}`);
  assert.equal(parsed.body, "• Готово");
  assert.deepEqual(parsed.actions, [createAction()]);
});

test("действия могут создать дочернюю задачу и обновить метки", () => {
  const payload = JSON.stringify({ actions: [createAction(), updateAction()] });
  const parsed = parseAgentResponse(`GITHUB_ACTIONS: ${payload}`);
  assert.equal(parsed.body, "");
  assert.deepEqual(parsed.actions, [createAction(), updateAction()]);
});

for (const [name, action] of [
  ["неизвестное действие", { type: "delete_issue" }],
  ["неизвестная метка", createAction({ labels: ["question", "ready-for-agent"] })],
  ["две категории", createAction({ labels: ["bug", "enhancement", "ready-for-agent"] })],
  ["два состояния", createAction({ labels: ["enhancement", "needs-info", "ready-for-agent"] })],
  ["нет категории", createAction({ labels: ["ready-for-agent"] })],
  ["неизвестное поле", createAction({ repository: "other/repository" })],
  ["одновременные add и remove", updateAction({ add: ["bug"], remove: ["bug"] })],
]) {
  test(`отклоняется ${name}`, () => {
    const payload = JSON.stringify({ actions: [action] });
    assert.throws(() => parseAgentResponse(`GITHUB_ACTIONS: ${payload}`));
  });
}

test("несколько блоков действий отклоняются", () => {
  const marker = 'GITHUB_ACTIONS: {"actions":[]}';
  assert.throws(() => parseAgentResponse(`${marker}\n${marker}`), /несколько блоков/);
});

test("несколько действий и лишние поля верхнего уровня отклоняются", () => {
  assert.throws(
    () => parseAgentResponse('GITHUB_ACTIONS: {"actions":[],"extra":true}'),
    /недопустимые поля/i,
  );
});

test("изменение меток сохраняет остальные и исключает конфликт состояний", () => {
  const action = updateAction({ add: ["ready-for-agent"], remove: ["needs-triage"] });
  const labels = validateLabelTransition(["bug", "needs-triage", "documentation"], action);
  assert.deepEqual(new Set(labels), new Set(["bug", "ready-for-agent", "documentation"]));
  assert.throws(
    () =>
      validateLabelTransition(
        ["needs-info"],
        updateAction({ add: ["ready-for-agent"], remove: [] }),
      ),
    /несколько состояний/,
  );
});
