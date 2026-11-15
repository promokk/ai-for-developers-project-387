import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readBackendControlledRedReport,
  readChangedBackendTests,
  validateBackendControlledRed,
  validateFrontendControlledRed,
} from "./controlled-red.mjs";

function passingSpec(title, file = "upcoming-events.spec.ts", tags = []) {
  return {
    title,
    file,
    tags,
    tests: [
      {
        expectedStatus: "passed",
        status: "expected",
        results: [{ status: "passed", duration: 10 }],
      },
    ],
  };
}

function failingDescriptionSpec(
  message = 'Error: expect(locator).toContainText(expected) failed\n\nExpected substring: "Обсудить запуск"',
) {
  return {
    title: "показывает описание типа события",
    file: "upcoming-events.spec.ts",
    tags: ["controlled-red-description"],
    tests: [
      {
        expectedStatus: "passed",
        status: "unexpected",
        results: [
          {
            status: "failed",
            duration: 10,
            error: {
              message,
            },
          },
        ],
      },
    ],
  };
}

function playwrightReport(specs) {
  return {
    suites: [{ title: "upcoming-events.spec.ts", file: "upcoming-events.spec.ts", specs }],
    errors: [],
    stats: {
      expected: specs.length - 1,
      skipped: 0,
      unexpected: 1,
      flaky: 0,
    },
  };
}

test("ожидаемый red описания принят, а negative и существующие тесты зелёные", () => {
  const report = playwrightReport([
    failingDescriptionSpec(),
    passingSpec("не показывает заглушку без описания", "upcoming-events.spec.ts", [
      "controlled-red-negative",
    ]),
    passingSpec("сохраняет группировку повестки"),
  ]);

  assert.doesNotThrow(() => validateFrontendControlledRed(report, "event-description"));
});

test("посторонний assertion при зелёном основном отклонён", () => {
  const unrelated = failingDescriptionSpec();
  unrelated.title = "проверяет другую страницу";
  unrelated.file = "booking.spec.ts";
  unrelated.tags = [];
  const report = playwrightReport([
    passingSpec("показывает описание типа события"),
    unrelated,
    passingSpec("не показывает заглушку без описания", "upcoming-events.spec.ts", [
      "controlled-red-negative",
    ]),
  ]);

  assert.throws(
    () => validateFrontendControlledRed(report, "event-description"),
    /Controlled red/,
  );
});

test("красный negative при зелёном основном отклонён", () => {
  const negative = failingDescriptionSpec();
  negative.title = "не показывает заглушку без описания";
  negative.tags = ["controlled-red-negative"];
  const report = playwrightReport([
    passingSpec("показывает описание типа события"),
    negative,
  ]);

  assert.throws(
    () => validateFrontendControlledRed(report, "event-description"),
    /Controlled red/,
  );
});

test("unexpected skipped отклонён даже при ожидаемом red основного", () => {
  const skipped = passingSpec("существующий сценарий");
  skipped.tests[0].status = "skipped";
  skipped.tests[0].results = [{ status: "skipped", duration: 0 }];
  const report = playwrightReport([failingDescriptionSpec(), skipped]);

  assert.throws(() => validateFrontendControlledRed(report, "event-description"), /skipped/);
});

test("ошибка запуска Playwright отклоняется по structured report", () => {
  const report = playwrightReport([failingDescriptionSpec(), passingSpec("negative", "upcoming-events.spec.ts", ["controlled-red-negative"])]);
  report.errors.push({ message: "Error: web server did not start" });

  assert.throws(() => validateFrontendControlledRed(report, "event-description"), /ошибки запуска/);
});

test("timeout основного сценария не засчитывается как assertion", () => {
  const timedOut = failingDescriptionSpec(
    "Test timeout of 30000ms exceeded.\nError: expect(locator).toContainText(expected) failed",
  );
  timedOut.tests[0].results[0].status = "timedOut";
  const report = playwrightReport([timedOut, passingSpec("negative", "upcoming-events.spec.ts", ["controlled-red-negative"])]);

  assert.throws(() => validateFrontendControlledRed(report, "event-description"), /timeout/);
});

test("Expected 201/Received 422 в setup основного сценария отклонён", () => {
  const report = playwrightReport([
    failingDescriptionSpec(
      "Error: expect(received).toBe(expected)\n\nExpected: 201\nReceived: 422",
    ),
    passingSpec("не показывает заглушку без описания", "upcoming-events.spec.ts", [
      "controlled-red-negative",
    ]),
  ]);

  assert.throws(
    () => validateFrontendControlledRed(report, "event-description"),
    /Controlled red/,
  );
});

test("backend принимает AssertionError нового acceptance-теста при зелёных соседних", () => {
  const report = {
    tests: [
      {
        className: "tests.test_bookings",
        name: "test_new_behavior",
        status: "failed",
        failureType: "AssertionError",
      },
      { className: "tests.test_event_types", name: "test_existing", status: "passed" },
    ],
  };

  assert.doesNotThrow(() =>
    validateBackendControlledRed(report, [{ className: "tests.test_bookings", name: "test_new_behavior" }]),
  );
});

test("backend fixture/setup ERROR блокирует bypass даже при failed assertion", () => {
  const report = {
    tests: [
      {
        className: "tests.test_bookings",
        name: "test_new_behavior",
        status: "failed",
        failureType: "AssertionError",
      },
      {
        className: "tests.test_bookings",
        name: "test_broken_fixture",
        status: "error",
        errorType: "RuntimeError",
      },
    ],
  };

  assert.throws(
    () => validateBackendControlledRed(report, [{ className: "tests.test_bookings", name: "test_new_behavior" }]),
    /fixture\/setup\/collection ERROR/,
  );
});

test("backend collection ERROR блокирует bypass без failed assertion", () => {
  const report = {
    tests: [
      {
        className: "tests.test_bookings",
        name: "test_bookings",
        status: "error",
        errorType: "SyntaxError",
      },
    ],
  };

  assert.throws(
    () => validateBackendControlledRed(report, [{ className: "tests.test_bookings", name: "test_new_behavior" }]),
    /fixture\/setup\/collection ERROR/,
  );
});

test("controlled red #15 требует явно помеченный зелёный negative", () => {
  const report = playwrightReport([
    failingDescriptionSpec(),
    passingSpec("сохраняет группировку повестки"),
  ]);

  assert.throws(
    () => validateFrontendControlledRed(report, "event-description"),
    /negative.*PASS/,
  );
});

test("JUnit XML сохраняет fixture/setup error как структурный ERROR", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "controlled-red-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.xml");
  writeFileSync(
    reportPath,
    '<testsuite><testcase classname="tests.test_bookings" name="test_broken_fixture"><error type="RuntimeError">fixture failed</error></testcase></testsuite>',
  );

  const report = readBackendControlledRedReport(reportPath);
  assert.equal(report.tests[0].status, "error");
  assert.equal(report.tests[0].errorType, "RuntimeError");
  assert.throws(
    () => validateBackendControlledRed(report, [{ className: "tests.test_bookings", name: "test_new_behavior" }]),
    /fixture\/setup\/collection ERROR/,
  );
});

test("backend не относит failure похожего имени модуля к изменённым тестам", () => {
  const report = {
    tests: [
      {
        className: "tests.test_bookings_extra",
        name: "test_existing",
        status: "failed",
        failureType: "AssertionError",
      },
    ],
  };

  assert.throws(
    () => validateBackendControlledRed(report, [{ className: "tests.test_bookings", name: "test_new_behavior" }]),
    /изменённых тестах/,
  );
});

test("JUnit XML распознаёт AssertionError из traceback без атрибута type", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "controlled-red-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.xml");
  writeFileSync(
    reportPath,
    '<testsuite><testcase classname="tests.test_bookings" name="test_new"><failure message="assert False">E       assert False\n\ntests/test_bookings.py:1: AssertionError</failure></testcase></testsuite>',
  );

  const report = readBackendControlledRedReport(reportPath);
  assert.equal(report.tests[0].failureType, "AssertionError");
  assert.doesNotThrow(() =>
    validateBackendControlledRed(report, [
      { className: "tests.test_bookings", name: "test_new" },
    ]),
  );
});

test("backend отклоняет skipped negative при красном основном", () => {
  const report = {
    tests: [
      {
        className: "tests.test_bookings",
        name: "test_new_behavior",
        status: "failed",
        failureType: "AssertionError",
      },
      { className: "tests.test_bookings", name: "test_negative", status: "skipped" },
    ],
  };

  assert.throws(
    () => validateBackendControlledRed(report, [{ className: "tests.test_bookings", name: "test_new_behavior" }]),
    /skipped\/xfail/,
  );
});

test("backend отклоняет старый failed при зелёном новом тесте в том же файле", () => {
  const report = {
    tests: [
      {
        className: "tests.test_bookings",
        name: "test_existing",
        status: "failed",
        failureType: "AssertionError",
      },
      { className: "tests.test_bookings", name: "test_new_behavior", status: "passed" },
    ],
  };

  assert.throws(
    () => validateBackendControlledRed(report, [{ className: "tests.test_bookings", name: "test_new_behavior" }]),
    /добавленных или изменённых тестах/,
  );
});

test("AST сопоставление возвращает только добавленные или изменённые pytest-тесты", () => {
  const changes = [
    {
      path: "backend/tests/test_bookings.py",
      base: "def test_existing():\n    assert True\n",
      current:
        "def test_existing():\n    assert True\n\ndef test_new_behavior():\n    assert False\n",
    },
  ];

  assert.deepEqual(readChangedBackendTests(changes), [
    { className: "tests.test_bookings", name: "test_new_behavior" },
  ]);

  changes[0].current = "def test_existing():\n    assert False\n";
  assert.deepEqual(readChangedBackendTests(changes), [
    { className: "tests.test_bookings", name: "test_existing" },
  ]);
});

for (const scenario of ["negative", "соседний"]) {
  test(`test.fail с фактическим failed у ${scenario} сценария отклонён`, () => {
    const expectedFailure = passingSpec(scenario);
    expectedFailure.tests[0].expectedStatus = "failed";
    expectedFailure.tests[0].results[0].status = "failed";
    if (scenario === "negative") {
      expectedFailure.tags = ["controlled-red-negative"];
    }
    const negative =
      scenario === "negative"
        ? expectedFailure
        : passingSpec("negative", "upcoming-events.spec.ts", ["controlled-red-negative"]);
    const neighbor = scenario === "соседний" ? expectedFailure : passingSpec("соседний");
    const report = playwrightReport([failingDescriptionSpec(), negative, neighbor]);

    assert.throws(
      () => validateFrontendControlledRed(report, "event-description"),
      /фактический passed/,
    );
  });
}

function failingGenericSpec(message) {
  const spec = failingDescriptionSpec(message);
  spec.tags = ["controlled-red"];
  return spec;
}

test("generic отклоняет Expected 201/Received 422 из setup helper", () => {
  const report = playwrightReport([
    failingGenericSpec(
      "Error: \u001b[2mexpect(\u001b[22mreceived).toBe(expected)\n\nExpected: \u001b[32m201\u001b[39m\nReceived: \u001b[31m422\u001b[39m",
    ),
    passingSpec("соседний"),
  ]);

  assert.throws(
    () => validateFrontendControlledRed(report, "generic"),
    /setup\/API validation/,
  );
});

test("generic принимает genuine target assertion без setup/API маркеров", () => {
  const report = playwrightReport([
    failingGenericSpec(
      'Error: expect(locator).toHaveText(expected) failed\n\nExpected: "Новое поведение"\nReceived: "Текущее поведение"',
    ),
    passingSpec("соседний"),
  ]);

  assert.doesNotThrow(() => validateFrontendControlledRed(report, "generic"));
});

for (const message of [
  "Error: expect(received).toBe(expected)\nExpected: 200\nReceived: 400",
  "Error: expect(response.ok).toBe(true)\nAPI 422",
  "Error: expect(response.status()).toBe(201)\nSTART_OUTSIDE_BOOKING_WINDOW",
  "Error: expect(response.status()).toBe(201)\nINVALID_DATETIME",
]) {
  test("generic отклоняет API validation/setup маркеры", () => {
    const report = playwrightReport([failingGenericSpec(message), passingSpec("соседний")]);

    assert.throws(
      () => validateFrontendControlledRed(report, "generic"),
      /setup\/API validation/,
    );
  });
}
