import { formatStructureIssues, runStructureCheck } from "./structure-lib.js";

const issues = await runStructureCheck();

if (issues.length > 0) {
  console.error("Structure check failed.\n");
  console.error(formatStructureIssues(issues));
  process.exitCode = 1;
} else {
  console.log("Structure check passed.");
}
