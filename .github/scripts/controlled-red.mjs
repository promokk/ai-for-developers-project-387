import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const PYTEST_JUNIT_PARSER = fileURLToPath(new URL("./pytest-junit.py", import.meta.url));
const PYTEST_CHANGED_TESTS_PARSER = fileURLToPath(
  new URL("./pytest-changed-tests.py", import.meta.url),
);

export function readBackendControlledRedReport(path) {
  return JSON.parse(
    execFileSync("python", [PYTEST_JUNIT_PARSER, path], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    }),
  );
}

export function readChangedBackendTests(changes) {
  return JSON.parse(
    execFileSync("python", [PYTEST_CHANGED_TESTS_PARSER], {
      encoding: "utf8",
      input: JSON.stringify(changes),
      stdio: ["pipe", "pipe", "inherit"],
    }),
  );
}

function reportSpecs(report) {
  const specs = [];
  function visit(suite) {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) {
      visit(child);
    }
  }
  for (const suite of report.suites ?? []) {
    visit(suite);
  }
  return specs;
}

export function validateBackendControlledRed(report, changedTests) {
  if (report.tests.some((entry) => entry.status === "error")) {
    throw new Error("Backend controlled red отклонён: fixture/setup/collection ERROR");
  }
  if (report.tests.some((entry) => entry.status === "skipped")) {
    throw new Error("Backend controlled red отклонён: skipped/xfail в acceptance report");
  }
  const failed = report.tests.filter((entry) => entry.status === "failed");
  if (failed.length === 0) {
    throw new Error("Backend controlled red требует failed assertion нового теста");
  }
  for (const entry of failed) {
    const isChanged = changedTests.some(
      (changed) =>
        entry.className === changed.className &&
        (entry.name === changed.name || entry.name.startsWith(`${changed.name}[`)),
    );
    if (entry.failureType !== "AssertionError" || !isChanged) {
      throw new Error(
        "Backend controlled red допускает только AssertionError в добавленных или изменённых тестах",
      );
    }
  }
}

export function validateFrontendControlledRed(report, profile) {
  if ((report.errors ?? []).length > 0) {
    throw new Error("Controlled red отклонён: report содержит ошибки запуска Playwright");
  }
  const specs = reportSpecs(report);
  const entries = specs.flatMap((spec) => spec.tests);
  if (
    entries.some(
      (entry) =>
        entry.status === "skipped" || entry.results.some((result) => result.status === "skipped"),
    )
  ) {
    throw new Error("Controlled red отклонён: report содержит skipped тесты");
  }
  if (
    entries.some(
      (entry) =>
        entry.results.length !== 1 ||
        !["passed", "failed"].includes(entry.results[0].status),
    )
  ) {
    throw new Error("Controlled red отклонён: timeout, interrupted или retry в report");
  }
  const failed = specs.filter((spec) => spec.tests.some((entry) => entry.status === "unexpected"));
  if (failed.length !== 1 || failed.length === specs.length) {
    throw new Error("Controlled red требует ровно один failed тест и зелёные остальные сценарии");
  }
  const redEntries = failed[0].tests.filter((entry) => entry.status === "unexpected");
  if (redEntries.length !== 1) {
    throw new Error("Controlled red требует ровно один failed тест основного сценария");
  }
  for (const entry of entries) {
    if (
      entry !== redEntries[0] &&
      (entry.expectedStatus !== "passed" ||
        entry.status !== "expected" ||
        entry.results[0].status !== "passed")
    ) {
      throw new Error("Controlled red требует фактический passed у всех остальных сценариев");
    }
  }
  if (!["event-description", "generic"].includes(profile)) {
    throw new Error(`Неизвестный controlled-red profile: ${profile}`);
  }
  const expectedTag =
    profile === "event-description" ? "controlled-red-description" : "controlled-red";
  if (!failed[0].tags.includes(expectedTag)) {
    throw new Error(`Controlled red требует тег ${expectedTag} у failed основного сценария`);
  }
  if (profile === "event-description") {
    const negative = specs.filter((spec) => spec.tags.includes("controlled-red-negative"));
    if (
      negative.length !== 1 ||
      negative[0].file !== "upcoming-events.spec.ts" ||
      negative[0].tests.some((entry) => entry.status !== "expected")
    ) {
      throw new Error("Controlled red #15 требует ровно один negative со статусом PASS");
    }
    const spec = failed[0];
    const message = spec.tests[0].results[0].error?.message ?? "";
    if (
      spec.file !== "upcoming-events.spec.ts" ||
      !message.includes("toContainText")
    ) {
      throw new Error("Controlled red #15 должен падать на ожидаемом отсутствии описания");
    }
  } else {
    const message = failed[0].tests[0].results[0].error?.message ?? "";
    const normalizedMessage = message.replaceAll(/\u001b\[[0-9;]*m/g, "");
    const apiSetupFailure =
      /Expected:\s*2\d\d[\s\S]*Received:\s*[45]\d\d/.test(normalizedMessage) ||
      /START_OUTSIDE_BOOKING_WINDOW|INVALID_DATETIME|API\s+[45]\d\d/.test(normalizedMessage);
    if (apiSetupFailure) {
      throw new Error("Controlled red отклонён: setup/API validation failure основного сценария");
    }
    if (!message.includes("expect")) {
      throw new Error("Controlled red требует assertion failure основного сценария");
    }
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} обязателен`);
  }
  return value;
}

function changedBackendTests() {
  const gitPaths = (filter) =>
    execFileSync(
      "git",
      ["diff", "--name-only", `--diff-filter=${filter}`, "origin/main", "--", "backend/tests"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
  const tracked = gitPaths("ACMR");
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", "backend/tests"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  const added = new Set([...gitPaths("A"), ...untracked]);
  const changes = [...new Set([...tracked, ...untracked])].map((path) => ({
    path,
    base: added.has(path)
      ? null
      : execFileSync("git", ["show", `origin/main:${path}`], { encoding: "utf8" }),
    current: readFileSync(path, "utf8"),
  }));
  return readChangedBackendTests(changes);
}

function runCli() {
  const scope = process.argv[2];
  const reportPath = requiredEnv("ACCEPTANCE_REPORT");
  if (scope === "frontend") {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    validateFrontendControlledRed(report, requiredEnv("RED_PROFILE"));
  } else if (scope === "backend") {
    const report = readBackendControlledRedReport(reportPath);
    validateBackendControlledRed(report, changedBackendTests());
  } else {
    throw new Error(`Неизвестный acceptance scope: ${scope}`);
  }
  console.log(`Structured controlled-red report принят для ${scope}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
