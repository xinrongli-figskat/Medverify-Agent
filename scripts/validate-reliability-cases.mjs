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
    item.forbiddenOutputPatterns !== undefined &&
    (!Array.isArray(item.forbiddenOutputPatterns) ||
      item.forbiddenOutputPatterns.some(
        (pattern) => typeof pattern !== "string" || pattern === ""
      ))
  ) {
    errors.push(`${label}：forbiddenOutputPatterns 必须是非空字符串数组。`);
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
