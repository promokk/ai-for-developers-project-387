import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRefusalComment,
  extractIssueNumbers,
  planReviewBudget,
  REVIEW_BUDGET,
} from "./pr-review.mjs";

const input = {
  prNumber: 42,
  runId: "100",
  runAttempt: "1",
  headSha: "a".repeat(40),
};

function reservation(runId, headSha = input.headSha, runAttempt = "1") {
  return {
    body: `<!-- kimi-pr-review:budget ${JSON.stringify({
      pr: input.prNumber,
      runId,
      runAttempt,
      headSha,
    })} -->`,
  };
}

test("первый запуск резервируется до модели", () => {
  const plan = planReviewBudget([], input);
  assert.equal(plan.allowed, true);
  assert.equal(plan.count, 1);
  assert.match(plan.marker, /"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/);
});

test("повторная доставка того же run не расходует бюджет повторно", () => {
  const plan = planReviewBudget([reservation("100")], input);
  assert.deepEqual(plan, { allowed: true, count: 1, duplicate: true });
});

test("повторный attempt того же run получает отдельное резервирование", () => {
  const plan = planReviewBudget([reservation("100")], { ...input, runAttempt: "2" });
  assert.equal(plan.allowed, true);
  assert.equal(plan.count, 2);
});

test("ровно пять запусков допускаются без сброса на новом head", () => {
  let comments = [];
  for (let index = 0; index < REVIEW_BUDGET; index += 1) {
    const plan = planReviewBudget(comments, {
      ...input,
      runId: String(index + 1),
      headSha: String(index).repeat(40),
    });
    assert.equal(plan.allowed, true);
    comments = [...comments, reservation(String(index + 1), String(index).repeat(40))];
  }
  assert.equal(planReviewBudget(comments, { ...input, runId: "6" }).allowed, false);
});

test("дубликаты маркеров одного run считаются один раз", () => {
  const comments = [reservation("100"), reservation("100")];
  assert.equal(planReviewBudget(comments, { ...input, runId: "101" }).count, 2);
});

test("чужой PR и повреждённые маркеры не влияют на бюджет", () => {
  const other = {
    body: `<!-- kimi-pr-review:budget ${JSON.stringify({ ...input, runId: "999" })} -->`,
  };
  const broken = { body: "<!-- kimi-pr-review:budget {broken} -->" };
  assert.equal(planReviewBudget([other, broken], input).count, 1);
});

test("отказ содержит причину, полный head и run, а модель не разрешена", () => {
  const comments = Array.from({ length: REVIEW_BUDGET }, (_, index) => reservation(String(index)));
  const plan = planReviewBudget(comments, input);
  assert.equal(plan.allowed, false);
  const body = buildRefusalComment({ ...input, count: plan.count, runUrl: "https://example.test/run/100" });
  assert.match(body, /бюджет из 5 запусков/);
  assert.match(body, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(body, /https:\/\/example\.test\/run\/100/);
  assert.match(body, /Модель не вызывалась/);
});

test("из описания извлекаются Issue и полные ссылки на спецификации", () => {
  assert.deepEqual(
    extractIssueNumbers([
      "Closes #9, refs #15. Повтор #9",
      "https://github.com/promokk/ai-for-developers-project-387/issues/15",
    ]),
    [9, 15],
  );
});
