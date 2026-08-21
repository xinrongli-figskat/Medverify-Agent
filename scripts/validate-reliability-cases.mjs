import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const casesUrl = new URL("../tests/reliability/cases.json", import.meta.url);
const casesPath = fileURLToPath(casesUrl);

const requiredFields = [
  "id",
  "name",
  "category",
  "userInput",
  "requiresPubMed",
  "expectedToolCalls",
  "expectedBehaviors",
  "forbiddenBehaviors",
  "manualReviewRequired",
  "currentStatus",
  "notes"
];

const errors = [];
let cases;
const faultScenarios = new Set([
  "http_429",
  "http_500",
  "network_error",
  "timeout",
  "esearch_malformed_json",
  "esearch_invalid_schema",
  "esummary_malformed_json",
  "esummary_invalid_schema",
  "zero_results",
  "success_exact_pmid"
]);
const toolOutcomes = new Set([
  "tool_failure",
  "invalid_response",
  "zero_results",
  "successful_records"
]);
const failureCategories = new Set([
  "http_error",
  "network_error",
  "timeout",
  "parse_error",
  "schema_error"
]);
const failureStages = new Set(["esearch", "esummary"]);
const scenarioContracts = {
  http_429: ["tool_failure", "http_error", "esearch", 429],
  http_500: ["tool_failure", "http_error", "esearch", 500],
  network_error: ["tool_failure", "network_error", "esearch", null],
  timeout: ["tool_failure", "timeout", "esearch", null],
  esearch_malformed_json: ["invalid_response", "parse_error", "esearch", null],
  esearch_invalid_schema: ["invalid_response", "schema_error", "esearch", null],
  esummary_malformed_json: [
    "invalid_response",
    "parse_error",
    "esummary",
    null
  ],
  esummary_invalid_schema: [
    "invalid_response",
    "schema_error",
    "esummary",
    null
  ],
  zero_results: ["zero_results", null, null, null],
  success_exact_pmid: ["successful_records", null, null, null]
};

try {
  const raw = await readFile(casesUrl, "utf8");
  cases = JSON.parse(raw);
} catch (error) {
  console.error(
    `无法读取或解析 ${casesPath}: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}

if (!Array.isArray(cases)) {
  console.error("校验失败：cases.json 顶层必须是数组。");
  process.exit(1);
}

const seenIds = new Set();
const categoryCounts = new Map();

for (const [index, item] of cases.entries()) {
  const label =
    item && typeof item === "object" && typeof item.id === "string"
      ? item.id
      : `第 ${index + 1} 条`;

  if (!item || typeof item !== "object" || Array.isArray(item)) {
    errors.push(`${label}：case 必须是对象。`);
    continue;
  }

  for (const field of requiredFields) {
    if (!Object.hasOwn(item, field)) {
      errors.push(`${label}：缺少必填字段 ${field}。`);
      continue;
    }

    if (typeof item[field] === "string" && item[field].trim() === "") {
      errors.push(`${label}：必填字段 ${field} 不能为空。`);
    }
  }

  if (typeof item.id === "string") {
    if (seenIds.has(item.id)) {
      errors.push(`${label}：ID 重复。`);
    }
    seenIds.add(item.id);
  }

  if (item.expectedToolCalls !== 0 && item.expectedToolCalls !== 1) {
    errors.push(`${label}：expectedToolCalls 必须是 0 或 1。`);
  }

  if (typeof item.requiresPubMed !== "boolean") {
    errors.push(`${label}：requiresPubMed 必须是布尔值。`);
  }

  if (!Array.isArray(item.expectedBehaviors)) {
    errors.push(`${label}：expectedBehaviors 必须是数组。`);
  }

  if (!Array.isArray(item.forbiddenBehaviors)) {
    errors.push(`${label}：forbiddenBehaviors 必须是数组。`);
  }

  if (typeof item.manualReviewRequired !== "boolean") {
    errors.push(`${label}：manualReviewRequired 必须是布尔值。`);
  }

  if (
    item.expectedToolName !== undefined &&
    (typeof item.expectedToolName !== "string" ||
      item.expectedToolName.trim() === "")
  ) {
    errors.push(`${label}：expectedToolName 必须是非空字符串。`);
  }

  if (
    item.expectedToolState !== undefined &&
    item.expectedToolState !== "output-available"
  ) {
    errors.push(`${label}：expectedToolState 当前只允许 output-available。`);
  }

  if (
    item.requireToolOutput !== undefined &&
    typeof item.requireToolOutput !== "boolean"
  ) {
    errors.push(`${label}：requireToolOutput 必须是布尔值。`);
  }

  if (
    item.expectedExecutedQuery !== undefined &&
    (typeof item.expectedExecutedQuery !== "string" ||
      item.expectedExecutedQuery.trim() === "")
  ) {
    errors.push(`${label}：expectedExecutedQuery 必须是非空字符串。`);
  }

  if (
    item.expectedRecordPmids !== undefined &&
    (!Array.isArray(item.expectedRecordPmids) ||
      item.expectedRecordPmids.some(
        (pmid) => typeof pmid !== "string" || pmid.trim() === ""
      ))
  ) {
    errors.push(`${label}：expectedRecordPmids 必须是非空字符串数组。`);
  }

  if (
    item.faultScenario !== undefined &&
    !faultScenarios.has(item.faultScenario)
  ) {
    errors.push(`${label}：faultScenario 不在允许枚举中。`);
  }
  if (
    item.expectedToolOutcome !== undefined &&
    !toolOutcomes.has(item.expectedToolOutcome)
  ) {
    errors.push(`${label}：expectedToolOutcome 不在允许枚举中。`);
  }
  if (
    item.expectedToolFailureCategory !== undefined &&
    !failureCategories.has(item.expectedToolFailureCategory)
  ) {
    errors.push(`${label}：expectedToolFailureCategory 不在允许枚举中。`);
  }
  if (
    item.expectedToolFailureStage !== undefined &&
    !failureStages.has(item.expectedToolFailureStage)
  ) {
    errors.push(`${label}：expectedToolFailureStage 不在允许枚举中。`);
  }
  if (
    item.expectedHttpStatus !== undefined &&
    (!Number.isInteger(item.expectedHttpStatus) ||
      item.expectedHttpStatus < 100 ||
      item.expectedHttpStatus > 599)
  ) {
    errors.push(`${label}：expectedHttpStatus 必须是 100 至 599 的整数。`);
  }
  if (
    item.requireCitationIdentifiersGrounded !== undefined &&
    typeof item.requireCitationIdentifiersGrounded !== "boolean"
  ) {
    errors.push(`${label}：requireCitationIdentifiersGrounded 必须是布尔值。`);
  }
  if (
    ["zero_results", "successful_records"].includes(item.expectedToolOutcome)
  ) {
    for (const field of [
      "expectedToolFailureCategory",
      "expectedToolFailureStage",
      "expectedHttpStatus"
    ]) {
      if (item[field] !== undefined)
        errors.push(
          `${label}：${item.expectedToolOutcome} 不允许配置 ${field}。`
        );
    }
  }
  if (
    item.expectedToolFailureCategory !== undefined &&
    !["tool_failure", "invalid_response"].includes(item.expectedToolOutcome)
  ) {
    errors.push(`${label}：failure category 与 expectedToolOutcome 矛盾。`);
  }
  if (
    item.expectedToolFailureStage !== undefined &&
    !["tool_failure", "invalid_response"].includes(item.expectedToolOutcome)
  ) {
    errors.push(`${label}：failure stage 与 expectedToolOutcome 矛盾。`);
  }
  if (
    item.expectedHttpStatus !== undefined &&
    item.expectedToolFailureCategory !== "http_error"
  ) {
    errors.push(`${label}：expectedHttpStatus 只允许与 http_error 配置。`);
  }

  if (
    item.faultScenario !== undefined &&
    faultScenarios.has(item.faultScenario)
  ) {
    const required = {
      requiresPubMed: true,
      expectedToolCalls: 1,
      expectedToolName: "searchPubMed",
      expectedToolState: "output-available",
      requireToolOutput: true,
      manualReviewRequired: true,
      currentStatus: "NOT_RUN",
      requireCitationIdentifiersGrounded: true
    };
    for (const [field, expected] of Object.entries(required)) {
      if (item[field] !== expected)
        errors.push(
          `${label}：faultScenario 要求 ${field}=${JSON.stringify(expected)}。`
        );
    }
    if (item.expectedToolOutcome === undefined)
      errors.push(`${label}：faultScenario 要求 expectedToolOutcome。`);
    const [outcome, category, stage, status] =
      scenarioContracts[item.faultScenario];
    if (item.expectedToolOutcome !== outcome)
      errors.push(
        `${label}：${item.faultScenario} 的 expectedToolOutcome 必须为 ${outcome}。`
      );
    for (const [field, expected] of [
      ["expectedToolFailureCategory", category],
      ["expectedToolFailureStage", stage],
      ["expectedHttpStatus", status]
    ]) {
      if (
        expected === null ? item[field] !== undefined : item[field] !== expected
      ) {
        errors.push(
          `${label}：${item.faultScenario} 的 ${field} ${expected === null ? "不允许配置" : `必须为 ${expected}`}。`
        );
      }
    }
    if (item.faultScenario === "success_exact_pmid") {
      if (
        typeof item.expectedExecutedQuery !== "string" ||
        item.expectedExecutedQuery.trim() === ""
      )
        errors.push(
          `${label}：success_exact_pmid 要求 expectedExecutedQuery。`
        );
      if (
        !Array.isArray(item.expectedRecordPmids) ||
        item.expectedRecordPmids.length === 0
      )
        errors.push(
          `${label}：success_exact_pmid 要求非空 expectedRecordPmids。`
        );
    }
  }

  if (
    item.forbiddenOutputPatterns !== undefined &&
    (!Array.isArray(item.forbiddenOutputPatterns) ||
      item.forbiddenOutputPatterns.some(
        (pattern) => typeof pattern !== "string" || pattern === ""
      ))
  ) {
    errors.push(`${label}：forbiddenOutputPatterns 必须是非空字符串数组。`);
  }

  if (item.requiredOutputGroups !== undefined) {
    if (!Array.isArray(item.requiredOutputGroups)) {
      errors.push(`${label}：requiredOutputGroups 必须是数组。`);
    } else {
      const seenGroupNames = new Set();
      for (const [groupIndex, group] of item.requiredOutputGroups.entries()) {
        const groupLabel = `${label}：requiredOutputGroups 第 ${groupIndex + 1} 项`;
        if (!group || typeof group !== "object" || Array.isArray(group)) {
          errors.push(`${groupLabel}必须是对象。`);
          continue;
        }

        if (typeof group.name !== "string" || group.name.trim() === "") {
          errors.push(`${groupLabel}的 name 必须是非空字符串。`);
        } else {
          const normalizedName = group.name.trim();
          if (seenGroupNames.has(normalizedName)) {
            errors.push(`${groupLabel}的 name 在同一 case 中不能重复。`);
          } else {
            seenGroupNames.add(normalizedName);
          }
        }

        if (
          !Array.isArray(group.anyOf) ||
          group.anyOf.length === 0 ||
          group.anyOf.some(
            (text) => typeof text !== "string" || text.trim() === ""
          )
        ) {
          errors.push(`${groupLabel}的 anyOf 必须是非空字符串数组。`);
        }
      }
    }
  }

  if (typeof item.category === "string" && item.category.trim() !== "") {
    categoryCounts.set(
      item.category,
      (categoryCounts.get(item.category) ?? 0) + 1
    );
  }
}

if (errors.length > 0) {
  console.error(`Reliability case 校验失败，共 ${errors.length} 个问题：`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Reliability case 校验通过：共 ${cases.length} 条。`);
console.log("各 category 数量：");
for (const [category, count] of [...categoryCounts].sort(([a], [b]) =>
  a.localeCompare(b)
)) {
  console.log(`- ${category}: ${count}`);
}
