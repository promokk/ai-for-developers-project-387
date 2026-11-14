import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceSuiteForSpec,
  buildImplementationPrBody,
  classifyAgentEvent,
  parseAgentCommand,
  selectSpecIssue,
  validateTestOnlyPaths,
} from "./pr-agent.mjs";

function comment(overrides = {}) {
  return {
    body: "/agent исправь тест",
    author_association: "MEMBER",
    user: { type: "User" },
    ...overrides,
  };
}

test("команда требует /agent без ведущих пробелов и непустой запрос", () => {
  assert.equal(parseAgentCommand(" /agent test"), null);
  assert.equal(parseAgentCommand("/agent"), null);
  assert.equal(parseAgentCommand("/agentfoo"), null);
  assert.deepEqual(parseAgentCommand("/agent\nисправь тест"), {
    mode: "pr",
    request: "исправь тест",
  });
});

test("implement-spec распознаётся отдельно", () => {
  assert.deepEqual(parseAgentCommand("/agent implement-spec\n"), {
    mode: "implement-spec",
    request: "implement-spec",
  });
});

test("доверенный не-бот может писать в PR через оба типа комментариев", () => {
  assert.deepEqual(
    classifyAgentEvent("issue_comment", {
      issue: { number: 12, pull_request: {} },
      comment: comment(),
    }),
    { mode: "pr", request: "исправь тест", number: 12 },
  );
  assert.equal(
    classifyAgentEvent("pull_request_review_comment", {
      pull_request: { number: 12 },
      comment: comment(),
    }).number,
    12,
  );
});

test("implement-spec работает в обычном Issue, но не дублируется в PR", () => {
  const implement = comment({ body: "/agent implement-spec" });
  assert.deepEqual(
    classifyAgentEvent("issue_comment", { issue: { number: 9 }, comment: implement }),
    { mode: "implement-spec", request: "implement-spec", number: 9 },
  );
  assert.equal(
    classifyAgentEvent("issue_comment", {
      issue: { number: 9, pull_request: {} },
      comment: implement,
    }),
    null,
  );
});

for (const untrusted of [
  comment({ author_association: "NONE" }),
  comment({ user: { type: "Bot" } }),
  comment({ body: "@kimi исправь" }),
]) {
  test("небезопасный автор или формат пропускается", () => {
    assert.equal(
      classifyAgentEvent("issue_comment", {
        issue: { number: 12, pull_request: {} },
        comment: untrusted,
      }),
      null,
    );
  });
}

test("implement-spec выбирает единственную открытую дочернюю спецификацию", () => {
  const source = { number: 9, state: "open" };
  const child = { number: 15, state: "open" };
  assert.equal(selectSpecIssue(source, [child]), child);
  assert.equal(selectSpecIssue(source, []), source);
  assert.throws(() => selectSpecIssue(source, [child, { number: 16, state: "open" }]));
});

test("спецификация #15 выбирает frontend acceptance suite", () => {
  assert.deepEqual(
    acceptanceSuiteForSpec({ body: "Дополнить frontend/tests/upcoming-events.spec.ts" }),
    { scope: "frontend", testDirectory: "frontend/tests" },
  );
  assert.deepEqual(acceptanceSuiteForSpec({ body: "Добавить backend/tests/test_bookings.py" }), {
    scope: "backend",
    testDirectory: "backend/tests",
  });
  assert.throws(() => acceptanceSuiteForSpec({ body: "Добавить тесты" }));
});

test("фаза 1 разрешает только тесты и отклоняет скрытую реализацию", () => {
  assert.doesNotThrow(() =>
    validateTestOnlyPaths(["frontend/tests/upcoming-events.spec.ts"], "frontend"),
  );
  assert.throws(
    () =>
      validateTestOnlyPaths(
        ["frontend/tests/upcoming-events.spec.ts", "frontend/src/UpcomingEventsPage.tsx"],
        "frontend",
      ),
    /недопустимые файлы/,
  );
  assert.throws(() => validateTestOnlyPaths([], "frontend"), /не изменила файлы/);
});

test("PR body использует русский шаблон и закрывает только спецификацию", () => {
  const body = buildImplementationPrBody({
    phase: "implementation",
    response: "Реализовано описание события.",
    issueNumber: 9,
    specNumber: 15,
    runUrl: "https://example.test/writer",
    redCommit: "a".repeat(40),
    redCiUrl: "https://example.test/red",
    greenCommit: "b".repeat(40),
  });
  assert.match(body, /## Краткое описание/);
  assert.match(body, /## Проверки/);
  assert.match(body, /## Риск слияния/);
  assert.match(body, /Closes #15/);
  assert.match(body, /Refs #9/);
  assert.doesNotMatch(body, /Closes #9|## Summary|## Evidence|## Merge Danger/);
  assert.match(body, /https:\/\/example\.test\/red/);
  assert.match(body, /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
});
