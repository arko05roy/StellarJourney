import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT = `${ROOT}docs/level-5`;
const PREVIEW = `${ROOT}.artifacts/level5/workbook`;
const wb = Workbook.create();
wb.comments.setSelf({ displayName: "Paymap Team" });

const instructions = wb.worksheets.add("Instructions");
const responses = wb.worksheets.add("Responses");
const analysis = wb.worksheets.add("Analysis");

const blue = "#2563EB";
const navy = "#101114";
const pale = "#E8F0FF";
const line = "#D9DEE8";
const muted = "#5E6573";

function header(range) {
  range.format.fill = navy;
  range.format.font = { color: "#FFFFFF", bold: true };
  range.format.rowHeight = 28;
}

instructions.showGridLines = false;
instructions.getRange("A1:H2").merge();
instructions.getRange("A1").values = [["Paymap Level 5 · Feedback Analysis"]];
instructions.getRange("A1:H2").format.fill = navy;
instructions.getRange("A1:H2").format.font = { color: "#FFFFFF", bold: true, size: 22 };
instructions.getRange("A4:H4").merge();
instructions.getRange("A4").values = [["Use genuine Google Form exports only. Never create placeholder users, ratings, wallets, or transaction hashes."]];
instructions.getRange("A4:H4").format.fill = "#FFF4DC";
instructions.getRange("A4:H4").format.font = { color: "#7A4A00", bold: true };
instructions.getRange("A6:B11").values = [
  ["Step", "Action"],
  ["1", "Create the Google Form using docs/level-5/google-form-spec.md."],
  ["2", "Collect consented responses and genuine Stellar testnet transaction hashes."],
  ["3", "Google Forms → Responses → Link to Sheets → File → Download → Microsoft Excel (.xlsx)."],
  ["4", "Copy exported rows into the Responses sheet. Preserve one respondent per row."],
  ["5", "Set Verification Status only after checking the wallet and transaction in Stellar Expert/Lab."],
];
header(instructions.getRange("A6:B6"));
instructions.getRange("A6:B11").format.borders = { insideHorizontal: { style: "thin", color: line }, insideVertical: { style: "thin", color: line }, top: { style: "thin", color: line }, bottom: { style: "thin", color: line }, left: { style: "thin", color: line }, right: { style: "thin", color: line } };
instructions.getRange("A13:B18").values = [
  ["Requirement", "Workbook evidence"],
  ["50+ onboarded users", "Analysis!B5"],
  ["Active usage proof", "Analysis!B8 plus transaction hashes in Responses column J"],
  ["Product feedback", "Rating and free-text fields in Responses"],
  ["Feedback iteration", "Rank themes outside this workbook; link implementation commits in README"],
  ["Privacy", "Do not publish email addresses. Publish aggregate screenshots or a redacted export."],
];
header(instructions.getRange("A13:B13"));
instructions.getRange("A:A").format.columnWidth = 22;
instructions.getRange("B:B").format.columnWidth = 90;
instructions.freezePanes.freezeRows(2);

responses.showGridLines = false;
const columns = [
  "Timestamp", "Name", "Email", "Wallet Address", "Rating (1-5)",
  "What worked?", "What was confusing?", "Feature request",
  "Consent to contact", "Testnet transaction hash", "Verification status",
];
responses.getRange("A1:K1").values = [columns];
header(responses.getRange("A1:K1"));
responses.freezePanes.freezeRows(1);
responses.getRange("A2:K501").format.borders = { insideHorizontal: { style: "hair", color: "#EDF0F5" } };
responses.getRange("A:A").format.columnWidth = 20;
responses.getRange("B:B").format.columnWidth = 22;
responses.getRange("C:C").format.columnWidth = 30;
responses.getRange("D:D").format.columnWidth = 62;
responses.getRange("E:E").format.columnWidth = 14;
responses.getRange("F:H").format.columnWidth = 38;
responses.getRange("I:I").format.columnWidth = 18;
responses.getRange("J:J").format.columnWidth = 70;
responses.getRange("K:K").format.columnWidth = 20;
responses.getRange("E2:E501").dataValidation = { rule: { type: "whole", operator: "between", formula1: 1, formula2: 5 } };
responses.getRange("I2:I501").dataValidation = { rule: { type: "list", values: ["Yes", "No"] } };
responses.getRange("K2:K501").dataValidation = { rule: { type: "list", values: ["Pending", "Verified", "Invalid"] } };
responses.getRange("D2:D501").conditionalFormats.add("duplicateValues", { format: { fill: "#FFE3E3", font: { color: "#9A1C1C" } } });
responses.getRange("K2:K501").conditionalFormats.add("containsText", { text: "Verified", format: { fill: "#DCFCE7", font: { color: "#166534" } } });
responses.getRange("K2:K501").conditionalFormats.add("containsText", { text: "Invalid", format: { fill: "#FFE3E3", font: { color: "#9A1C1C" } } });

analysis.showGridLines = false;
analysis.getRange("A1:H2").merge();
analysis.getRange("A1").values = [["Paymap User Growth Dashboard"]];
analysis.getRange("A1:H2").format.fill = navy;
analysis.getRange("A1:H2").format.font = { color: "#FFFFFF", bold: true, size: 22 };
analysis.getRange("A4:B9").values = [
  ["Metric", "Value"],
  ["Onboarded users", null],
  ["Average rating", null],
  ["Feedback responses", null],
  ["Verified transactions", null],
  ["Level 5 user gate", null],
];
analysis.getRange("B5:B9").formulas = [
  ["=COUNTA(Responses!D2:D501)"],
  ["=IFERROR(AVERAGE(Responses!E2:E501),0)"],
  ["=COUNT(Responses!E2:E501)"],
  ["=COUNTIF(Responses!K2:K501,\"Verified\")"],
  ["=IF(B5>=50,\"READY\",\"PENDING\")"],
];
header(analysis.getRange("A4:B4"));
analysis.getRange("A5:B9").format.borders = { insideHorizontal: { style: "thin", color: line }, insideVertical: { style: "thin", color: line }, top: { style: "thin", color: line }, bottom: { style: "thin", color: line }, left: { style: "thin", color: line }, right: { style: "thin", color: line } };
analysis.getRange("B5:B9").format.font = { bold: true, color: blue, size: 16 };
analysis.getRange("B6").format.numberFormat = "0.0";
analysis.getRange("D4:E9").values = [
  ["Rating", "Responses"],
  [1, null],
  [2, null],
  [3, null],
  [4, null],
  [5, null],
];
analysis.getRange("E5:E9").formulas = [
  ["=COUNTIF(Responses!E2:E501,D5)"],
  ["=COUNTIF(Responses!E2:E501,D6)"],
  ["=COUNTIF(Responses!E2:E501,D7)"],
  ["=COUNTIF(Responses!E2:E501,D8)"],
  ["=COUNTIF(Responses!E2:E501,D9)"],
];
header(analysis.getRange("D4:E4"));
analysis.getRange("D4:E9").format.borders = { insideHorizontal: { style: "thin", color: line }, insideVertical: { style: "thin", color: line }, top: { style: "thin", color: line }, bottom: { style: "thin", color: line }, left: { style: "thin", color: line }, right: { style: "thin", color: line } };
analysis.getRange("A12:H12").merge();
analysis.getRange("A12").values = [["READINESS RULES"]];
analysis.getRange("A12:H12").format.fill = pale;
analysis.getRange("A12:H12").format.font = { color: blue, bold: true };
analysis.getRange("A14:B17").values = [
  ["Gate", "Formula-backed status"],
  ["50+ wallets", null],
  ["50+ feedback ratings", null],
  ["50+ verified transactions", null],
];
analysis.getRange("B15:B17").formulas = [
  ["=IF(B5>=50,\"PASS\",\"PENDING\")"],
  ["=IF(B7>=50,\"PASS\",\"PENDING\")"],
  ["=IF(B8>=50,\"PASS\",\"PENDING\")"],
];
header(analysis.getRange("A14:B14"));
analysis.getRange("A:A").format.columnWidth = 30;
analysis.getRange("B:B").format.columnWidth = 22;
analysis.getRange("C:C").format.columnWidth = 4;
analysis.getRange("D:D").format.columnWidth = 14;
analysis.getRange("E:E").format.columnWidth = 18;
analysis.getRange("F:H").format.columnWidth = 14;
analysis.getRange("B9").conditionalFormats.add("containsText", { text: "READY", format: { fill: "#DCFCE7", font: { color: "#166534", bold: true } } });
analysis.getRange("B9").conditionalFormats.add("containsText", { text: "PENDING", format: { fill: "#FFE3E3", font: { color: "#9A1C1C", bold: true } } });
const chart = analysis.charts.add("column", analysis.getRange("D4:E9"));
chart.setPosition("D11", "H24");
chart.title = "Rating distribution";
chart.hasLegend = false;

wb.comments.addThread({ cell: analysis.getRange("B5") }, "Source: genuine wallet addresses pasted into Responses!D2:D501.");
wb.comments.addThread({ cell: analysis.getRange("B8") }, "Source: transactions manually verified before marking Responses!K as Verified.");

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(PREVIEW, { recursive: true });
for (const name of ["Instructions", "Responses", "Analysis"]) {
  const rendered = await wb.render({ sheetName: name, autoCrop: "all", scale: 1, format: "png" });
  await fs.writeFile(`${PREVIEW}/${name}.png`, new Uint8Array(await rendered.arrayBuffer()));
}
const out = await SpreadsheetFile.exportXlsx(wb);
await out.save(`${OUT}/Paymap-User-Feedback-Analysis.xlsx`);

const inspection = await wb.inspect({ kind: "sheet,formula", maxChars: 8000, tableMaxRows: 10, tableMaxCols: 12 });
await fs.writeFile(`${PREVIEW}/inspection.ndjson`, inspection.ndjson);
