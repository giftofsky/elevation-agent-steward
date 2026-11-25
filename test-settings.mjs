/**
 * Настройки: триаж и семантика правил.
 * Запуск: node test-settings.mjs (после npm run build).
 *
 * Проверки вынесены из test-notifications-v2.mjs, чтобы сюита уведомлений
 * не разрасталась и настройки можно было менять независимо.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-settings-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(
  tempRoot,
  "opencode",
  "windows-scheduler"
);

const settingsModule = await import("./dist/settings.js");
const { getPluginDir } = await import("./dist/types.js");
const { evaluateTriageRules } = await import("./dist/core/triage-rules.js");

let passed = 0;
let failed = 0;

function check(name, condition, details = "") {
  if (condition) {
    passed++;
    console.log(`OK   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${details ? ` - ${details}` : ""}`);
  }
}

const settingsFile = path.join(process.env.OPENCODE_SCHEDULER_HOME, "settings.json");
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });

// QA-PLUGIN-DIR: путь каталога/настроек пересчитывается после изменения env,
// даже если модули были импортированы статически до подмены.
{
  const originalHome = process.env.OPENCODE_SCHEDULER_HOME;
  const alternateHome = path.join(tempRoot, "opencode", "alternate-home");
  process.env.OPENCODE_SCHEDULER_HOME = alternateHome;
  check(
    "QA-PLUGIN-DIR: getPluginDir() следует за OPENCODE_SCHEDULER_HOME после импорта",
    getPluginDir() === alternateHome
  );
  check(
    "QA-PLUGIN-DIR: getSettingsFilePath() не использует кэш момента импорта",
    settingsModule.getSettingsFilePath() === path.join(alternateHome, "settings.json")
  );
  process.env.OPENCODE_SCHEDULER_HOME = originalHome;
}

// 1. Дефолты триажа
const defaults = settingsModule.defaultNotifications();
check(
  "defaultNotifications: триаж выключен и указывает на Ollama",
  defaults.triage?.mode === "off" &&
    defaults.triage?.baseUrl === "http://127.0.0.1:11434" &&
    defaults.triage?.model === "qwen3:4b" &&
    defaults.triage?.timeoutMs === 60000 &&
    defaults.triage?.fallback === "rules" &&
    defaults.triage?.confidenceThreshold === 0.6
);
check(
  "defaultNotifications: rules undefined означает встроенные правила",
  defaults.triage?.rules === undefined
);

// 2. Старый settings.json без triage получает безопасный дефолт
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    notifications: {
      enabled: true,
      onlyOnError: false,
      webhook: { enabled: true, url: "http://127.0.0.1:9/hook" },
    },
  }),
  "utf8"
);
const loaded = await settingsModule.loadSettings();
check(
  "loadSettings: старый settings.json получает triage off",
  loaded.notifications.triage?.mode === "off" &&
    loaded.notifications.triage?.baseUrl === "http://127.0.0.1:11434"
);

// 3. Некорректные enum-ы откатываются, числа зажимаются
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    notifications: {
      enabled: true,
      onlyOnError: true,
      triage: {
        mode: "auto",
        baseUrl: "ftp://bad",
        model: "  qwen3:4b  ",
        timeoutMs: 500,
        fallback: "nonsense",
        confidenceThreshold: 2.5,
      },
    },
  }),
  "utf8"
);
const clamped = await settingsModule.loadSettings();
check(
  "loadSettings: triage валидирует enum-ы и зажимает числа",
  clamped.notifications.triage?.mode === "auto" &&
    clamped.notifications.triage?.baseUrl === "http://127.0.0.1:11434" &&
    clamped.notifications.triage?.model === "qwen3:4b" &&
    clamped.notifications.triage?.timeoutMs === 1000 &&
    clamped.notifications.triage?.fallback === "rules" &&
    clamped.notifications.triage?.confidenceThreshold === 1
);

// 4. Старое имя "skip" означало «не применять правила», а не «не отправлять».
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    notifications: {
      enabled: true,
      onlyOnError: true,
      triage: { mode: "llm", fallback: "skip" },
    },
  }),
  "utf8"
);
const legacyFallback = await settingsModule.loadSettings();
check(
  "loadSettings: fallback skip нормализуется в notify",
  legacyFallback.notifications.triage?.fallback === "notify"
);

// 5. Новое имя notify сохраняется как есть
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    notifications: {
      enabled: true,
      onlyOnError: true,
      triage: { mode: "llm", fallback: "notify" },
    },
  }),
  "utf8"
);
const notifyFallback = await settingsModule.loadSettings();
check(
  "loadSettings: fallback notify сохраняется",
  notifyFallback.notifications.triage?.fallback === "notify"
);

// 6. Частичное сохранение триажа не сбрасывает остальные уведомления
await settingsModule.saveSettings({
  notifications: { enabled: true, onlyOnError: true, triage: { mode: "rules" } },
});
const partial = await settingsModule.loadSettings();
check(
  "saveSettings: частичный triage сохраняет остальные настройки",
  partial.notifications.triage?.mode === "rules" &&
    partial.notifications.enabled === true &&
    partial.notifications.onlyOnError === true &&
    partial.notifications.webhook?.timeoutMs === 10000 &&
    partial.notifications.digest?.frequency === "daily"
);

// 7. Пользовательские правила нормализуются, невалидные отбрасываются
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    notifications: {
      enabled: true,
      triage: {
        mode: "rules",
        rules: [
          { id: "keep", field: "task", operator: "equals", value: "deploy", priority: "50" },
          { id: "bad-op", field: "cost", operator: "contains", value: 1 },
          { id: "bad-regex", field: "error", operator: "regex", value: "[bad" },
          { id: "bad-field", field: "unknown", operator: "equals", value: "x" },
        ],
      },
    },
  }),
  "utf8"
);
const withRules = await settingsModule.loadSettings();
check(
  "loadSettings: правила триажа нормализуются и отбрасывают невалидные",
  withRules.notifications.triage?.rules?.length === 1 &&
    withRules.notifications.triage?.rules?.[0].id === "keep" &&
    withRules.notifications.triage?.rules?.[0].priority === 50
);

// 8. Семантика rules: undefined = встроенные, [] = ни одного
const timeoutInput = {
  taskName: "deploy",
  status: "error",
  error: "Process timed out after 30s",
};
const builtIn = evaluateTriageRules(timeoutInput);
check(
  "evaluateTriageRules: undefined применяет встроенные правила",
  builtIn.matched === true && builtIn.ruleId === "error-timeout"
);
const noRulesEvaluation = evaluateTriageRules(timeoutInput, []);
check(
  "evaluateTriageRules: пустой массив отключает встроенные правила",
  noRulesEvaluation.matched === false
);

await settingsModule.saveSettings({
  notifications: { enabled: true, onlyOnError: true, triage: { rules: [] } },
});
const noRules = await settingsModule.loadSettings();
check(
  "saveSettings: пустой массив правил сохраняется и отключает встроенные",
  Array.isArray(noRules.notifications.triage?.rules) && noRules.notifications.triage?.rules?.length === 0
);
check(
  "loadSettings: rules undefined не превращается в пустой массив",
  settingsModule.defaultNotifications().triage?.rules === undefined &&
    Array.isArray(noRules.notifications.triage?.rules)
);

// Язык интерфейса (T7): режим auto и обратная совместимость явных локалей.
const defaultLocaleSettings = await settingsModule.loadSettings();
check(
  "loadSettings: режим локали по умолчанию — auto",
  defaultLocaleSettings.locale === "auto"
);

await settingsModule.saveSettings({ locale: "auto" });
const autoLocaleSettings = await settingsModule.loadSettings();
check(
  "saveSettings/loadSettings: режим auto сохраняется",
  autoLocaleSettings.locale === "auto"
);

await settingsModule.saveSettings({ locale: "zh-CN" });
const bcpLocaleSettings = await settingsModule.loadSettings();
check(
  "saveSettings: BCP 47 zh-CN маппится в zh",
  bcpLocaleSettings.locale === "zh"
);

await settingsModule.saveSettings({ locale: "en" });
const explicitLocaleSettings = await settingsModule.loadSettings();
check(
  "saveSettings: явная локаль en сохраняется",
  explicitLocaleSettings.locale === "en"
);

fs.writeFileSync(settingsFile, JSON.stringify({ locale: "en-GB" }), "utf8");
const legacyLocaleSettings = await settingsModule.loadSettings();
check(
  "loadSettings: старый settings.json с en-GB читается как en",
  legacyLocaleSettings.locale === "en"
);

fs.writeFileSync(settingsFile, JSON.stringify({ locale: "de-DE" }), "utf8");
const unknownLocaleSettings = await settingsModule.loadSettings();
check(
  "loadSettings: неизвестная локаль откатывается к auto",
  unknownLocaleSettings.locale === "auto"
);

// S24: последняя известная локаль интерфейса для серверного процесса.
const defaultUiLocale = await settingsModule.loadSettings();
check(
  "loadSettings: uiLocale по умолчанию — en",
  defaultUiLocale.uiLocale === "en"
);

await settingsModule.saveSettings({ uiLocale: "zh" });
const savedUiLocale = await settingsModule.loadSettings();
check("saveSettings/loadSettings: uiLocale сохраняется", savedUiLocale.uiLocale === "zh");

fs.writeFileSync(settingsFile, JSON.stringify({ locale: "auto", uiLocale: "en-GB" }), "utf8");
const autoUiLocale = await settingsModule.loadSettings();
check(
  "loadSettings: auto + uiLocale en-GB → режим auto, локаль en",
  autoUiLocale.locale === "auto" && autoUiLocale.uiLocale === "en"
);

// Экономика v2, E-1.1: бюджетные лимиты.
fs.writeFileSync(settingsFile, JSON.stringify({ locale: "auto" }), "utf8");
const defaultBudgets = await settingsModule.loadSettings();
check(
  "loadSettings: budgets по умолчанию выключен и без лимитов",
  defaultBudgets.budgets?.enabled === false &&
    defaultBudgets.budgets?.dailyUsd === 0 &&
    defaultBudgets.budgets?.weeklyUsd === 0
);

fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    budgets: { enabled: true, dailyUsd: -5, weeklyUsd: 2.5 },
  }),
  "utf8"
);
const clampedBudgets = await settingsModule.loadSettings();
check(
  "loadSettings: отрицательный лимит зажат до 0",
  clampedBudgets.budgets?.enabled === true &&
    clampedBudgets.budgets?.dailyUsd === 0 &&
    clampedBudgets.budgets?.weeklyUsd === 2.5
);

fs.writeFileSync(
  settingsFile,
  JSON.stringify({ budgets: { enabled: "yes", dailyUsd: "oops" } }),
  "utf8"
);
const legacyBudgets = await settingsModule.loadSettings();
check(
  "loadSettings: битые поля budgets откатываются к дефолту",
  legacyBudgets.budgets?.enabled === false && legacyBudgets.budgets?.dailyUsd === 0
);

await settingsModule.saveSettings({ budgets: { enabled: true, dailyUsd: 3, weeklyUsd: 20 } });
const savedBudgets = await settingsModule.loadSettings();
check(
  "saveSettings/loadSettings: budgets сохраняются частично",
  savedBudgets.budgets?.enabled === true &&
    savedBudgets.budgets?.dailyUsd === 3 &&
    savedBudgets.budgets?.weeklyUsd === 20 &&
    savedBudgets.locale === "auto"
);

// Итог
console.log(`\nSettings: ${passed}/${passed + failed} проверок прошли.`);
if (failed > 0) {
  process.exit(1);
}
