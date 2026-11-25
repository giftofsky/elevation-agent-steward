/**
 * i18n-фундамент (Спринт 28).
 *
 * Каталоги строк живут в `<корень пакета>/locales/<locale>.json` — плоские
 * ключи вида `"server.notFound"`. Загрузчик читает их синхронно при первом
 * обращении и кэширует: файлы маленькие, а горячий путь — `t()` в рендере.
 *
 * Поддерживается ICU-подмножество без зависимостей:
 *   - `{name}` — подстановка параметра;
 *   - `{count, plural, one {…} few {…} many {…} other {…}}` — плюрализация
 *     через встроенный `Intl.PluralRules`; `#` внутри ветки — число.
 *
 * Режим языка по умолчанию — `auto` (`DEFAULT_LOCALE_MODE`): интерфейс следует
 * за языком OpenCode. Английский остаётся резервной локалью (`DEFAULT_LOCALE`),
 * если язык хоста неизвестен: если ключа нет в текущей локали, берётся
 * английский вариант; если нет и там — возвращается сам ключ, чтобы пропажа
 * была видна, а не превращалась в пустую строку.
 *
 * Локаль процесса меняется через `setLocale()` — без перезапуска плагина.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Locale = "ru" | "en" | "zh" | "tr";

/** Порядок важен для UI: первым идёт локаль по умолчанию. */
export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "ru", "zh", "tr"];

/** Английский — локаль по умолчанию и резерв для отсутствующих ключей. */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Режим локали (T7): `auto` — следовать за языком интерфейса OpenCode,
 * конкретное значение — всегда использовать эту локаль.
 */
export type LocaleMode = "auto" | Locale;

/** Значение режима «следовать за OpenCode». */
export const LOCALE_AUTO = "auto" as const;

/**
 * Режим по умолчанию: как в OpenCode — следовать за языком интерфейса.
 * Явный выбор пользователя (`ru`/`en`/`zh`/`tr`) сохраняется как есть.
 */
export const DEFAULT_LOCALE_MODE: LocaleMode = LOCALE_AUTO;

/**
 * Каталог модуля: `src/` при запуске из исходников, `dist/` из сборки.
 *
 * В GUI-бандле (renderer Electron/webview) нет ни `import.meta.url` с реальным
 * путём к пакету, ни `process`; любой бросок на этапе загрузки модуля валит
 * весь плагин, поэтому путь вычисляется лениво и молча.
 */
function moduleDir(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/** Каталоги, где может лежать `locales/` (оба варианта дают корень пакета). */
function candidateCatalogDirs(): string[] {
  const dirs: string[] = [];
  const dir = moduleDir();
  if (dir) {
    dirs.push(path.resolve(dir, "../locales"), path.resolve(dir, "locales"));
  }
  // QA-PORT-13: в свежем worktree `dist/` — junction на dev-установку, поэтому
  // realpath модуля указывает в её `locales/`, где может не быть новой локали
  // (например, `tr.json`). Рабочая директория — исходный репозиторий, её
  // `locales/` и есть актуальный источник. Кандидат из cwd идёт последним и
  // используется только если рядом с модулем нужного файла нет; в GUI-бандле
  // `process` отсутствует, поэтому обращение защищено.
  try {
    if (typeof process !== "undefined" && typeof process.cwd === "function") {
      const cwd = process.cwd();
      const checkoutLocales = path.resolve(cwd, "locales");
      const isDevCheckout =
        fs.existsSync(path.join(cwd, "src", "i18n.ts")) &&
        SUPPORTED_LOCALES.every((locale) =>
          fs.existsSync(path.join(checkoutLocales, `${locale}.json`)),
        );
      if (isDevCheckout) {
        // Исходный чек-аут — актуальный источник каталогов, даже если модуль
        // загружен через junction из более старой dev-установки: иначе ru/en/zh
        // берутся из старых файлов, а tr — из новых, и паритет ключей ломается.
        dirs.unshift(checkoutLocales);
      } else {
        dirs.push(checkoutLocales);
      }
      dirs.push(path.resolve(cwd, "dist", "locales"));
    }
  } catch {
    // Нет cwd — остаются каталоги рядом с модулем.
  }
  return [...new Set(dirs)];
}

const catalogs = new Map<Locale, Record<string, string>>();
const pluralRules = new Map<Locale, Intl.PluralRules>();

/**
 * Локаль запуска: `OPENCODE_SCHEDULER_LOCALE=en` позволяет прогнать набор
 * тестов на другой локали без правки настроек. Не задана — локаль по умолчанию.
 *
 * `process` отсутствует в GUI-бандле (renderer), поэтому обращение к нему
 * защищено: иначе `ReferenceError: process is not defined` ломает загрузку
 * всего плагина ещё до регистрации панели.
 */
function envLocale(): string | undefined {
  try {
    return typeof process !== "undefined" && process.env
      ? process.env.OPENCODE_SCHEDULER_LOCALE
      : undefined;
  } catch {
    return undefined;
  }
}

const INITIAL_LOCALE: Locale = normalizeLocale(envLocale());

let currentLocale: Locale = INITIAL_LOCALE;

/** true, если значение — поддерживаемая локаль. */
export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/** true, если значение — допустимый режим локали (включая `auto`). */
export function isLocaleMode(value: unknown): value is LocaleMode {
  return value === LOCALE_AUTO || isLocale(value);
}

/**
 * Маппинг BCP 47 → поддерживаемая локаль: `zh-CN`/`zh-Hans` → `zh`,
 * `en-GB` → `en`, `ru-RU` → `ru`; неизвестное значение → `fallback`.
 * Регистр и разделитель (`-` или `_`) не важны.
 */
export function mapAppLocale(
  value: unknown,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  if (typeof value !== "string") return fallback;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : fallback;
}

/** Приводит произвольное значение к поддерживаемой локали (с учётом BCP 47). */
export function normalizeLocale(
  value: unknown,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  return mapAppLocale(value, fallback);
}

/** Приводит значение к режиму локали: `auto` или поддерживаемая локаль. */
export function normalizeLocaleMode(
  value: unknown,
  fallback: LocaleMode = DEFAULT_LOCALE_MODE,
): LocaleMode {
  if (value === LOCALE_AUTO) return LOCALE_AUTO;
  if (typeof value === "string") {
    const base = value.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return fallback;
}

/**
 * Разрешает режим в конкретную локаль. Серверный процесс языка OpenCode не
 * видит, поэтому при `auto` берётся последняя известная локаль интерфейса
 * (`uiLocale`, её присылает GUI), иначе — локаль по умолчанию.
 */
export function resolveLocale(mode: LocaleMode, lastKnown?: Locale): Locale {
  if (mode !== LOCALE_AUTO) return mode;
  return isLocale(lastKnown) ? lastKnown : DEFAULT_LOCALE;
}

/** Текущая локаль процесса. */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Переключает локаль процесса. Возвращает фактическую локаль (невалидное
 * значение откатывается к локали по умолчанию).
 */
export function setLocale(locale: unknown): Locale {
  currentLocale = normalizeLocale(locale, DEFAULT_LOCALE);
  return currentLocale;
}

/** Путь к файлу каталога или null, если файла нет. */
export function catalogPath(locale: Locale): string | null {
  for (const dir of candidateCatalogDirs()) {
    const file = path.join(dir, `${locale}.json`);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Нет файла — пробуем следующий каталог.
    }
  }
  return null;
}

/** Читает каталог с диска (с кэшем). Битый файл — пустой каталог. */
function readCatalog(locale: Locale): Record<string, string> {
  const cached = catalogs.get(locale);
  if (cached) return cached;

  const file = catalogPath(locale);
  const parsed: Record<string, string> = {};
  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value === "string" && value.length > 0) parsed[key] = value;
        }
      }
    } catch (err: unknown) {
      console.error(
        `[i18n] Не удалось прочитать ${file}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  catalogs.set(locale, parsed);
  return parsed;
}

/**
 * Регистрирует каталог, встроенный в GUI-бандл.
 *
 * В webview OpenCode нет доступа к файлам пакета: `document.currentScript`
 * указывает на ресурс приложения, поэтому `catalogPath()` не находит
 * `locales/*.json` и `t()` возвращает сырые ключи. GUI импортирует JSON на
 * этапе сборки и кладёт его сюда — файлы на диске больше не нужны.
 */
export function registerCatalog(
  locale: Locale,
  messages: Record<string, unknown>,
): void {
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === "string" && value.length > 0) parsed[key] = value;
  }
  catalogs.set(locale, parsed);
}

/** Список ключей каталога (отсортированный). */
export function catalogKeys(locale: Locale = currentLocale): string[] {
  return Object.keys(readCatalog(locale)).sort();
}

/** true, если ключ есть в каталоге указанной локали. */
export function hasKey(key: string, locale: Locale = currentLocale): boolean {
  return Object.prototype.hasOwnProperty.call(readCatalog(locale), key);
}

/** Значение ключа в конкретной локали без fallback; undefined — ключа нет. */
export function messageIn(locale: Locale, key: string): string | undefined {
  return readCatalog(locale)[key];
}

/**
 * Ключи, которых не хватает относительно русской локали.
 * Пустой массив — каталог полный.
 */
export function missingKeys(locale: Locale): string[] {
  const base = new Set(catalogKeys(DEFAULT_LOCALE));
  return catalogKeys(locale).filter((key) => !base.has(key));
}

/** Ключи, которые есть в русской локали, но отсутствуют в указанной. */
export function absentKeys(locale: Locale): string[] {
  const target = new Set(catalogKeys(locale));
  return catalogKeys(DEFAULT_LOCALE).filter((key) => !target.has(key));
}

/** Сбрасывает кэш каталогов и локаль к локали запуска (для тестов). */
export function resetI18n(): void {
  catalogs.clear();
  pluralRules.clear();
  currentLocale = INITIAL_LOCALE;
}

/** Категория плюрализации для числа (`one`/`few`/`many`/`other`). */
function pluralCategory(count: number, locale: Locale): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

/** Форматирует число для подстановки `#` в плюральной ветке. */
function formatCount(count: number, locale: Locale): string {
  try {
    return new Intl.NumberFormat(locale).format(count);
  } catch {
    return String(count);
  }
}

/** Индекс парной `}` для `{` на позиции `openIndex`; -1 — не закрыта. */
function findClosingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Индекс первой запятой верхнего уровня (вне фигурных скобок); -1 — нет. */
function topLevelCommaIndex(body: string): number {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) return i;
  }
  return -1;
}

/**
 * Разбирает ветки plural: `one {…} few {…} many {…} other {…}`.
 * Ветки разделены пробелами/запятыми, содержимое — в фигурных скобках.
 */
function parsePluralBranches(text: string): Record<string, string> {
  const branches: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    const keyStart = i;
    while (i < text.length && text[i] !== "{") i++;
    if (i >= text.length) break;
    const key = text.slice(keyStart, i).trim();
    const end = findClosingBrace(text, i);
    if (end === -1) break;
    if (key) branches[key] = text.slice(i + 1, end);
    i = end + 1;
  }
  return branches;
}

/**
 * Разворачивает шаблон: `{name}` и `{count, plural, …}`.
 * `count` передаётся только внутри плюральной ветки — там `#` становится числом.
 */
function renderTemplate(
  template: string,
  locale: Locale,
  params: Record<string, unknown>,
  count?: number,
): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "#" && count !== undefined) {
      out += formatCount(count, locale);
      i++;
      continue;
    }
    if (ch !== "{") {
      out += ch;
      i++;
      continue;
    }
    const end = findClosingBrace(template, i);
    if (end === -1) {
      out += template.slice(i);
      break;
    }
    out += renderExpression(template.slice(i + 1, end), locale, params);
    i = end + 1;
  }
  return out;
}

/** Разворачивает одно выражение `{…}` (параметр или plural). */
function stringifyParam(value: unknown): string {
  // String() на unknown не триггерит no-base-to-string: правило срабатывает
  // только после сужения до `{}` (после исключения null/undefined).
  return String(value);
}

function renderExpression(
  body: string,
  locale: Locale,
  params: Record<string, unknown>,
): string {
  const comma = topLevelCommaIndex(body);
  const name = (comma === -1 ? body : body.slice(0, comma)).trim();
  const value = params[name];

  if (comma === -1) {
    // Нет параметра — оставляем плейсхолдер, чтобы пропажа была видна.
    return value === undefined || value === null ? `{${body}}` : stringifyParam(value);
  }

  const rest = body.slice(comma + 1).trim();
  const typeMatch = /^([a-zA-Z]+)/.exec(rest);
  const type = typeMatch ? typeMatch[1] : "";

  if (type === "plural") {
    const numeric = Number(value);
    const count = Number.isFinite(numeric) ? numeric : 0;
    const branches = parsePluralBranches(rest.slice(type.length));
    const category = pluralCategory(count, locale);
    const chosen = branches[category] ?? branches.other ?? "";
    return renderTemplate(chosen, locale, params, count);
  }

  // Неизвестный тип аргумента — подставляем значение как есть.
  return value === undefined || value === null ? `{${body}}` : stringifyParam(value);
}

/** Параметры подстановки: `{name}` или `count` для плюрализации. */
export type TranslateParams = Record<string, unknown>;

/**
 * Переводит ключ. Отсутствующий ключ → английский вариант → сам ключ.
 * Если сработал fallback, плюрализация тоже считается по английским правилам.
 */
export function t(key: string, params?: TranslateParams): string {
  const locale = currentLocale;
  let template = readCatalog(locale)[key];
  let renderLocale = locale;

  if (template === undefined && locale !== DEFAULT_LOCALE) {
    template = readCatalog(DEFAULT_LOCALE)[key];
    renderLocale = DEFAULT_LOCALE;
  }

  if (template === undefined) return key;
  return renderTemplate(template, renderLocale, params ?? {});
}

/** Все локали, у которых каталог реально найден на диске. */
export function availableLocales(): Locale[] {
  return SUPPORTED_LOCALES.filter((locale) => catalogPath(locale) !== null);
}
