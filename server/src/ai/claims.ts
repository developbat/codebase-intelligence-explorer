export interface ClaimCommandEvidence {
  command: string;
  ok: boolean;
}

export interface ClaimEvidence {
  changedFiles: string[];
  readFiles: string[];
  commands: ClaimCommandEvidence[];
  verification: { ran: boolean; ok: boolean; command?: string };
  browserChecks: { ok: boolean; assertions: number }[];
  extractionComplete?: boolean;
  mappedChangeVerified?: boolean;
  readOnly?: boolean;
}

export interface ClaimAudit {
  claims: string[];
  issues: string[];
}

const NEGATIVE =
  /(?:not (?:applied|changed|verified|tested)|unverified|no (?:file|change)|nothing (?:changed|applied)|already (?:exists|present|implemented)|not run|did not run|could not run|cannot run|failed|failure|uygulanmadı|değiştirilmedi|doğrulanamadı|test edilmedi|çalıştırılmadı|başarısız|hata|bloker|engellendi)/i;
const APPLIED =
  /(?:uygulandı|düzeltildi|düzelttim|değiştirildi|güncellendi|eklendi|fixed|applied|changed|updated|implemented|added)/i;
const VERIFIED =
  /(?:doğrulandı|doğruladım|verified|tested|passed|geçti|başarılı|✅)/i;
const TEST_CLAIM =
  /(?:test(?:ler)? (?:geçti|başarılı)|tests? (?:pass|passed)|pytest|npm test|go test|unittest|jest|vitest|typecheck|tsc)/i;
const BROWSER_CLAIM =
  /(?:tarayıcı|browser|real page|gerçek sayfa)[^\n]{0,80}(?:doğrula|verified|passed|geçti)/i;
const TEST_COMMAND =
  /\b(?:pytest|unittest|npm\s+test|go\s+test|jest|vitest|mocha|rspec|phpunit|artisan\s+test|tsc\b|typecheck|go\s+build|cargo\s+(?:test|check)|mvn\s+test|gradle\s+test)\b/i;
const READ_CLAIM =
  /(?:okudum|inceledim|read|inspected)\s+[`"']?([\w./-]+\.(?:[a-z0-9]{1,8}))\b/gi;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function auditClaims(summary: string, evidence: ClaimEvidence): ClaimAudit {
  const text = summary.trim();
  const negative = NEGATIVE.test(text);
  const claims: string[] = [];
  const issues: string[] = [];
  if (!text) return { claims, issues };

  const hasApplied = APPLIED.test(text) && !negative;
  if (hasApplied) {
    claims.push("applied");
    if (!evidence.readOnly && evidence.changedFiles.length === 0) {
      issues.push("The summary claims a change, but no file was changed.");
    }
  }

  const testPassed = TEST_CLAIM.test(text) && VERIFIED.test(text) && !negative;
  const hasVerified = VERIFIED.test(text) && !negative;
  if (testPassed) claims.push("tests");
  if (hasVerified) claims.push("verified");

  const successfulTestCommand = evidence.commands.some(
    (command) => command.ok && TEST_COMMAND.test(command.command),
  );
  const verifiedByCommand =
    (evidence.verification.ran && evidence.verification.ok) ||
    successfulTestCommand ||
    evidence.extractionComplete === true ||
    evidence.mappedChangeVerified === true ||
    evidence.browserChecks.some((check) => check.ok && check.assertions > 0) ||
    (evidence.readOnly === true && evidence.readFiles.length > 0);
  if (hasVerified && !verifiedByCommand) {
    issues.push(
      "The summary claims verification, but no successful test/typecheck/build, browser assertion, extraction or mapped-change verification is present.",
    );
  }

  if (text.match(READ_CLAIM)) {
    const readSet = new Set(evidence.readFiles.map((file) => file.toLowerCase()));
    for (const match of text.matchAll(READ_CLAIM)) {
      const file = match[1]?.toLowerCase();
      if (!file) continue;
      if (!readSet.has(file) && ![...readSet].some((read) => read.endsWith(`/${file}`) || read.endsWith(file))) {
        issues.push(`The summary claims a read of ${file}, but that file was not read by a tool in this run.`);
      }
    }
  }

  if (BROWSER_CLAIM.test(text) && !evidence.browserChecks.some((check) => check.ok && check.assertions > 0)) {
    issues.push("The summary claims browser verification, but no real-page browser assertion was recorded.");
  }

  if (testPassed && !successfulTestCommand && !(evidence.verification.ran && evidence.verification.ok)) {
    issues.push("The summary claims passing tests, but no successful test command was run.");
  }

  return { claims, issues: unique(issues) };
}
