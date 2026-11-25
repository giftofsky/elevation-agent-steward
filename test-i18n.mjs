/**
 * Тесты Спринта 28: i18n-фундамент (src/i18n.ts + locales/*.json).
 * Запуск: node test-i18n.mjs (после npm run build).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_MODE,
  LOCALE_AUTO,
  SUPPORTED_LOCALES,
  availableLocales,
  absentKeys,
  catalogKeys,
  catalogPath,
  getLocale,
  hasKey,
  isLocale,
  isLocaleMode,
  mapAppLocale,
  messageIn,
  missingKeys,
  normalizeLocale,
  normalizeLocaleMode,
  registerCatalog,
  resetI18n,
  resolveLocale,
  setLocale,
  t,
} from "./dist/i18n.js";
import { localizeDashboardHtml } from "./dist/dashboard-i18n.js";

const root = path.dirname(url.fileURLToPath(new URL(import.meta.url)));

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

// --- 1. Локаль по умолчанию и нормализация ---------------------------------
resetI18n();
check("локаль по умолчанию — en", DEFAULT_LOCALE === "en");
check(
  "getLocale() после resetI18n — локаль запуска",
  getLocale() === normalizeLocale(process.env.OPENCODE_SCHEDULER_LOCALE)
);
setLocale("ru");
check("SUPPORTED_LOCALES = [en, ru, zh, tr]", SUPPORTED_LOCALES.join(",") === "en,ru,zh,tr");
check("isLocale('ru')", isLocale("ru") === true);
check("isLocale('en')", isLocale("en") === true);
check("isLocale('zh')", isLocale("zh") === true);
check("isLocale('tr')", isLocale("tr") === true);
check("isLocale('EN') — false", isLocale("EN") === false);
check("isLocale(null) — false", isLocale(null) === false);
check("normalizeLocale('en') → en", normalizeLocale("en") === "en");
check("normalizeLocale('zh') → zh", normalizeLocale("zh") === "zh");
check("normalizeLocale('tr') → tr", normalizeLocale("tr") === "tr");
check("normalizeLocale('de') → en", normalizeLocale("de") === "en");
check("normalizeLocale(undefined) → en", normalizeLocale(undefined) === "en");

// BCP 47 → Locale (T7): префиксный маппинг; регистр и разделитель не важны.
check("mapAppLocale('zh-CN') → zh", mapAppLocale("zh-CN") === "zh");
check("mapAppLocale('zh-Hans') → zh", mapAppLocale("zh-Hans") === "zh");
check("mapAppLocale('en-GB') → en", mapAppLocale("en-GB") === "en");
check("mapAppLocale('ru-RU') → ru", mapAppLocale("ru-RU") === "ru");
check("mapAppLocale('tr-TR') → tr", mapAppLocale("tr-TR") === "tr");
check("mapAppLocale('ZH_hant_TW') → zh", mapAppLocale("ZH_hant_TW") === "zh");
check("mapAppLocale('de-DE') → en", mapAppLocale("de-DE") === "en");
check("mapAppLocale('') → en", mapAppLocale("") === "en");
check("normalizeLocale('zh-CN') → zh", normalizeLocale("zh-CN") === "zh");

// Режим локали (T7): auto + явные значения, неизвестное → fallback.
check("LOCALE_AUTO = auto", LOCALE_AUTO === "auto");
check("режим локали по умолчанию — auto", DEFAULT_LOCALE_MODE === "auto");
check("isLocaleMode('auto')", isLocaleMode("auto") === true);
check("isLocaleMode('zh')", isLocaleMode("zh") === true);
check("isLocaleMode('de') — false", isLocaleMode("de") === false);
check("normalizeLocaleMode('auto') → auto", normalizeLocaleMode("auto") === "auto");
check("normalizeLocaleMode('zh-CN') → zh", normalizeLocaleMode("zh-CN") === "zh");
check("normalizeLocaleMode('de') → auto", normalizeLocaleMode("de") === "auto");
check("normalizeLocaleMode(undefined) → auto", normalizeLocaleMode(undefined) === "auto");
check("normalizeLocaleMode('de', 'auto') → auto", normalizeLocaleMode("de", "auto") === "auto");
check("resolveLocale('auto') → en", resolveLocale("auto") === "en");
check("resolveLocale('auto', 'zh') → zh", resolveLocale("auto", "zh") === "zh");
check("resolveLocale('auto', 'uk') → en", resolveLocale("auto", "uk") === "en");
check("resolveLocale('zh') → zh", resolveLocale("zh") === "zh");
check("setLocale('en') возвращает en", setLocale("en") === "en");
check("setLocale меняет getLocale", getLocale() === "en");
check("setLocale('xx') откатывает к en", setLocale("xx") === "en" && getLocale() === "en");

// --- 2. Каталоги на диске ---------------------------------------------------
const ruFile = catalogPath("ru");
const enFile = catalogPath("en");
const zhFile = catalogPath("zh");
const trFile = catalogPath("tr");

// QA-PORT-13: при junction dist/ realpath модуля указывает в dev-установку,
// где tr.json отсутствует. Изолированная проверка: модуль лежит во временном
// каталоге с ru/en/zh, а cwd — корень репозитория с полным locales/.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "steward-i18n-cwd-"));
  try {
    fs.mkdirSync(path.join(tmp, "dist"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "locales"), { recursive: true });
    fs.copyFileSync(path.join(root, "dist", "i18n.js"), path.join(tmp, "dist", "i18n.js"));
    for (const loc of ["ru", "en", "zh"]) {
      fs.copyFileSync(
        path.join(root, "locales", `${loc}.json`),
        path.join(tmp, "locales", `${loc}.json`),
      );
    }
    const moduleHref = url.pathToFileURL(path.join(tmp, "dist", "i18n.js")).href;
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { catalogPath } from ${JSON.stringify(moduleHref)}; console.log(catalogPath("tr") || "");`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    check(
      "QA-PORT-13: catalogPath('tr') падает в cwd, даже если рядом с модулем только ru/en/zh",
      probe.status === 0 && (probe.stdout ?? "").trim() === path.join(root, "locales", "tr.json"),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
check("catalogPath('ru') находит locales/ru.json", !!ruFile && ruFile.endsWith(path.join("locales", "ru.json")));
check("catalogPath('en') находит locales/en.json", !!enFile && enFile.endsWith(path.join("locales", "en.json")));
check("catalogPath('zh') находит locales/zh.json", !!zhFile && zhFile.endsWith(path.join("locales", "zh.json")));
check("catalogPath('tr') находит locales/tr.json", !!trFile && trFile.endsWith(path.join("locales", "tr.json")));
check("availableLocales() = [en, ru, zh, tr]", availableLocales().join(",") === "en,ru,zh,tr");
check("каталоги читаются как JSON-объекты", !!JSON.parse(fs.readFileSync(ruFile, "utf8")));
check("hasKey('server.notFound', 'ru')", hasKey("server.notFound", "ru") === true);
check("hasKey('no.such.key', 'ru') — false", hasKey("no.such.key", "ru") === false);

// --- 3. Паритет каталогов ---------------------------------------------------
check("missingKeys('en') пуст", missingKeys("en").length === 0);
check("absentKeys('en') пуст", absentKeys("en").length === 0);
check("missingKeys('ru') пуст", missingKeys("ru").length === 0);
check("absentKeys('ru') пуст", absentKeys("ru").length === 0);
check(
  "число ключей ru и en совпадает",
  catalogKeys("ru").length === catalogKeys("en").length
);
check("missingKeys('tr') пуст", missingKeys("tr").length === 0);
check("absentKeys('tr') пуст", absentKeys("tr").length === 0);
check(
  "паритет ключей во всех локалях (ru/en/zh/tr)",
  SUPPORTED_LOCALES.every(
    (loc) =>
      missingKeys(loc).length === 0 &&
      absentKeys(loc).length === 0 &&
      catalogKeys(loc).length === catalogKeys("ru").length
  )
);
check(
  "все значения каталогов — непустые строки",
  SUPPORTED_LOCALES.every((loc) => {
    const file = catalogPath(loc);
    const raw = file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    return catalogKeys(loc).every(
      (key) =>
        typeof messageIn(loc, key) === "string" &&
        messageIn(loc, key).trim().length > 0 &&
        typeof raw[key] === "string"
    );
  })
);

// tr: детерминизм каталога и перевода (A-5.1).
// QA-PORT-13: если каталог не найден, тест обязан упасть проверкой выше, а не
// TypeError в fs.readFileSync(null).
const trRaw1 = trFile ? fs.readFileSync(trFile, "utf8") : "";
const trRaw2 = trFile ? fs.readFileSync(trFile, "utf8") : "";
check(
  "tr: каталог читается детерминированно",
  trRaw1 === trRaw2 &&
    JSON.stringify(JSON.parse(trRaw1)) === JSON.stringify(JSON.parse(trRaw2))
);
check(
  "tr: catalogKeys отсортированы",
  JSON.stringify(catalogKeys("tr")) === JSON.stringify([...catalogKeys("tr")].sort())
);
setLocale("tr");
check("tr: setLocale('tr') возвращает tr", getLocale() === "tr");
check("tr: статический ключ переведён", t("server.notFound") === "Sayfa bulunamadı.");
check(
  "tr: интерполяция переведена",
  t("server.taskNotFound", { task: "build" }).includes("görevi bulunamadı") &&
    t("server.taskNotFound", { task: "build" }).includes("build")
);
check(
  "tr: перевод детерминирован при повторных вызовах",
  t("server.taskNotFound", { task: "build" }) ===
    t("server.taskNotFound", { task: "build" }) &&
    t("server.notFound") === t("server.notFound")
);
check(
  "tr: плюрализация интерполирует число",
  t("common.runsCount", { count: 5 }).includes("5") &&
    t("common.runsCount", { count: 5 }) === t("common.runsCount", { count: 5 })
);
setLocale("ru");

// PL-36: self_analysis локализован — ключи есть во всех локалях и
// не возвращают сам ключ (t() не падает на фолбэк).
const SELF_ANALYSIS_KEYS = [
  "selfAnalysis.level.excellent",
  "selfAnalysis.level.good",
  "selfAnalysis.level.fair",
  "selfAnalysis.level.poor",
  "selfAnalysis.level.critical",
  "selfAnalysis.health",
  "selfAnalysis.anomaliesHigh",
  "selfAnalysis.anomaliesAll",
  "selfAnalysis.noAnomalies",
  "selfAnalysis.degrading",
  "selfAnalysis.highPriority",
  "selfAnalysis.rec.successRate",
  "selfAnalysis.rec.errorRate",
  "selfAnalysis.rec.duration",
  "selfAnalysis.rec.timeouts",
  "selfAnalysis.rec.crashes",
];
check(
  "PL-36: selfAnalysis.* ключи присутствуют во всех локалях",
  SUPPORTED_LOCALES.every((loc) =>
    SELF_ANALYSIS_KEYS.every((key) => hasKey(key, loc))
  )
);
setLocale("ru");
check(
  "PL-36: selfAnalysis.health интерполируется и локализован",
  t("selfAnalysis.health", { level: "отличное", score: 95 }).includes("95") &&
    t("selfAnalysis.health", { level: "отличное", score: 95 }).startsWith("Здоровье")
);
check(
  "PL-36: selfAnalysis.degrading склоняется по числу",
  t("selfAnalysis.degrading", { count: 1 }) !== t("selfAnalysis.degrading", { count: 5 })
);

// --- 4. Подстановка параметров ---------------------------------------------
resetI18n();
setLocale("ru");
check(
  "интерполяция {parentId}",
  t("server.matrixNotFound", { parentId: "nightly" }) === 'Матрица "nightly" не найдена.'
);
check(
  "интерполяция {task}",
  t("server.taskNotFound", { task: "build" }) === 'Задача "build" не найдена.'
);
check(
  "пропущенный параметр остаётся плейсхолдером",
  t("server.taskNotFound") === 'Задача "{task}" не найдена.'
);
check("статический ключ", t("server.notFound") === "Страница не найдена.");
check("ключ без перевода возвращается как есть", t("no.such.key") === "no.such.key");
check(
  "неизвестный ключ не интерполируется",
  t("no.such.key", { x: 1 }) === "no.such.key"
);

// --- 5. Плюрализация ru -----------------------------------------------------
resetI18n();
setLocale("ru");
check("ru plural 1 → one", t("common.runsCount", { count: 1 }) === "запусков: 1 запуск");
check("ru plural 2 → few", t("common.runsCount", { count: 2 }) === "запусков: 2 запуска");
check("ru plural 5 → many", t("common.runsCount", { count: 5 }) === "запусков: 5 запусков");
check("ru plural 21 → one", t("common.runsCount", { count: 21 }) === "запусков: 21 запуск");
check("ru plural 11 → many", t("common.runsCount", { count: 11 }) === "запусков: 11 запусков");

// --- 6. Плюрализация en -----------------------------------------------------
setLocale("en");
check("en plural 1 → one", t("common.runsCount", { count: 1 }) === "runs: 1 run");
check("en plural 2 → other", t("common.runsCount", { count: 2 }) === "runs: 2 runs");
check("en: статический ключ переведён", t("server.notFound") === "Page not found.");
check(
  "en: интерполяция переведена",
  t("server.taskNotFound", { task: "build" }) === 'Task "build" not found.'
);
check("en: заголовок дашборда переведён", t("app.dashboardTitle") === "Web dashboard");

// --- 7. Переключение без перезапуска ---------------------------------------
setLocale("ru");
check("переключение en → ru", t("server.notFound") === "Страница не найдена.");
check("смена локали не требует resetI18n", getLocale() === "ru");

// --- 8. Отсутствующий ключ → fallback на en --------------------------------
// В локалях набор ключей одинаковый, поэтому fallback проверяем на
// искусственном каталоге: подменяем файл en на время теста нельзя (read-only),
// зато видно, что отсутствующий ключ возвращает сам ключ, а не пустую строку.
setLocale("en");
check("отсутствующий в en ключ → сам ключ", t("no.such.key") === "no.such.key");

// --- 8b. Китайский каталог: fallback на en ---------------------------------
// zh.json наполняется пакетами (план локали закрыт и удалён). Проверяем сам
// механизм на пустом каталоге: отсутствующий ключ обязан давать английский
// вариант, а не сырой ключ. Подмена каталога не зависит от прогресса перевода.
registerCatalog("zh", {});
setLocale("zh");
check("setLocale('zh') возвращает zh", getLocale() === "zh");
check(
  "zh: отсутствующий ключ → английский вариант",
  t("server.notFound") === "Page not found."
);
check(
  "zh: плюрализация отсутствующего ключа считается по en",
  t("common.runsCount", { count: 5 }) === "runs: 5 runs"
);
resetI18n();

// --- 9. Локаль запуска через переменную окружения ---------------------------
const i18nUrl = url.pathToFileURL(path.join(root, "dist", "i18n.js")).href;
const child = spawnSync(
  process.execPath,
  ["-e", `import(${JSON.stringify(i18nUrl)}).then((m) => console.log(m.getLocale()))`],
  { env: { ...process.env, OPENCODE_SCHEDULER_LOCALE: "en" }, encoding: "utf8" }
);
check(
  "OPENCODE_SCHEDULER_LOCALE=en задаёт локаль запуска",
  child.stdout.trim() === "en"
);

// --- 10. Локализация готового HTML дашборда ---------------------------------
const dashboardRu = "<div>Всего запусков: 8 задач · Все · 31 с · не задан workdir задачи — снимок дерева</div>";
check(
  "дашборд ru: исходный HTML не меняется",
  localizeDashboardHtml(dashboardRu, "ru") === dashboardRu
);
const dashboardEn = localizeDashboardHtml(dashboardRu, "en");
check(
  "дашборд en: метрики и статусы переводятся",
  dashboardEn.includes("Total runs") && dashboardEn.includes("All")
);
check(
  "дашборд en: короткие слова по границам, без порчи «задачи»",
  dashboardEn.includes("8 tasks") &&
    localizeDashboardHtml("<div>задачи планировщика</div>", "en").includes("задачи планировщика")
);
check(
  "дашборд en: длительности и причины pre-flight переводятся",
  dashboardEn.includes("31 s") &&
    dashboardEn.includes("workdir not set for the task — tree snapshot")
);
check(
  "дашборд en: неизвестная локаль получает английский",
  localizeDashboardHtml(dashboardRu, "de") === dashboardEn
);

// QW-14.4: турецкий каталог должен быть виден в GUI, RPC и утилите прогонов.
const guiSource = fs.readFileSync(path.join(process.cwd(), "src", "gui.tsx"), "utf8");
const rpcSource = fs.readFileSync(path.join(process.cwd(), "src", "rpc.ts"), "utf8");
const runTestsSource = fs.readFileSync(path.join(process.cwd(), "scripts", "run-tests.mjs"), "utf8");
check(
  "QW-14.4: GUI регистрирует tr и показывает его в селекторе",
  guiSource.includes('import trCatalog from "../locales/tr.json"') &&
    guiSource.includes('registerCatalog("tr", trCatalog)') &&
    guiSource.includes('<option value="tr">')
);
check(
  "QW-14.4: RPC locale enum содержит tr во всех трёх схемах",
  (rpcSource.match(/enum: \["auto", "ru", "en", "zh", "tr"\]/g) ?? []).length === 3
);
check(
  "QW-14.4: run-tests.mjs принимает --locale=tr",
  runTestsSource.includes('["ru", "en", "zh", "tr"].includes(options.locale)')
);
check(
  "QW-14.4: ключ gui.languageTr есть во всех четырёх каталогах",
  SUPPORTED_LOCALES.every((loc) => hasKey("gui.languageTr", loc))
);

const failed = results.filter((r) => !r.ok);
console.log(`\ni18n: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
