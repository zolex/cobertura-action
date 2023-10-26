const core = require("@actions/core");
const github = require("@actions/github");
const { escapeMarkdown } = require("./utils");
const { processCoverage } = require("./cobertura");

const client = new github.getOctokit(
  core.getInput("repo_token", { required: true })
);
const credits = "Results for commit";

async function action(payload) {
  const { pullRequestNumber, commit } = await pullRequestInfo(payload);
  if (!commit) {
    core.error("Found no commit.");
    return;
  }

  const path = core.getInput("path", { required: true });
  const skipCovered = JSON.parse(
    core.getInput("skip_covered", { required: true })
  );
  const onlySummary = JSON.parse(
    core.getInput("only_summary", { required: true })
  );
  const useAnnotations = JSON.parse(
    core.getInput("use_annotations", { required: true })
  );
  const showLine = JSON.parse(core.getInput("show_line", { required: true }));
  const showBranch = JSON.parse(
    core.getInput("show_branch", { required: true })
  );
  const minimumCoverage = parseInt(
    core.getInput("minimum_coverage", { required: true })
  );
  const failBelowThreshold = JSON.parse(
    core.getInput("fail_below_threshold", { required: false }) || "false"
  );
  const showClassNames = JSON.parse(
    core.getInput("show_class_names", { required: true })
  );
  const showMissing = JSON.parse(
    core.getInput("show_missing", { required: true })
  );
  let showMissingMaxLength = core.getInput("show_missing_max_length", {
    required: false,
  });
  showMissingMaxLength = showMissingMaxLength
    ? parseInt(showMissingMaxLength)
    : -1;
  const linkMissingLines = JSON.parse(
    core.getInput("link_missing_lines", { required: false }) || "false"
  );
  const linkMissingLinesSourceDir =
    core.getInput("link_missing_lines_source_dir", { required: false }) || null;
  const onlyChangedFiles = JSON.parse(
    core.getInput("only_changed_files", { required: true })
  );
  const reportName = core.getInput("report_name", { required: false });

  const changedFiles = onlyChangedFiles
    ? await listChangedFiles(pullRequestNumber)
    : null;

  const reports = await processCoverage(path, { skipCovered });

  if (true === useAnnotations) {
    annotationReport(reports, commit, {
      minimumCoverage,
      showLine,
      showBranch,
      showClassNames,
      showMissing,
      showMissingMaxLength,
      filteredFiles: changedFiles,
      reportName,
      onlySummary,
      failBelowThreshold,
    });
  }

  const comment = markdownReport(reports, commit, {
    minimumCoverage,
    showLine,
    showBranch,
    showClassNames,
    showMissing,
    showMissingMaxLength,
    linkMissingLines,
    linkMissingLinesSourceDir,
    filteredFiles: changedFiles,
    reportName,
    onlySummary,
  });

  const belowThreshold = reports.some(
    (report) => Math.floor(report.total) < minimumCoverage
  );

  if (pullRequestNumber) {
    await addComment(pullRequestNumber, comment, reportName);
  }

  await addCheck(
    comment,
    reportName,
    commit,
    failBelowThreshold ? (belowThreshold ? "failure" : "success") : "neutral"
  );

  if (failBelowThreshold && belowThreshold) {
    core.setFailed("Minimum coverage requirement was not satisfied");
  }
}

function formatFileUrl(sourceDir, fileName, commit) {
  const repo = github.context.repo;
  sourceDir = sourceDir ? sourceDir : "";
  // Strip leading and trailing slashes.
  sourceDir = sourceDir.replace(/\/$/, "").replace(/^\//, "");
  const path = (sourceDir ? `${sourceDir}/` : "") + fileName;
  return `https://github.com/${repo.owner}/${repo.repo}/blob/${commit}/${path}`;
}

function formatRangeText([start, end]) {
  return `${start}` + (start === end ? "" : `-${end}`);
}

function tickWrap(string) {
  return "`" + string + "`";
}

function cropRangeList(separator, showMissingMaxLength, ranges) {
  if (showMissingMaxLength <= 0) return [ranges, false];
  let accumulatedJoin = "";
  for (const [index, range] of ranges.entries()) {
    accumulatedJoin += `${separator}${range}`;
    if (index === 0) continue;
    if (accumulatedJoin.length > showMissingMaxLength)
      return [ranges.slice(0, index), true];
  }
  return [ranges, false];
}

function linkRange(fileUrl, range) {
  const [start, end] = range.slice(1, -1).split("-", 2);
  const rangeReference = `L${start}` + (end ? `-L${end}` : "");
  // Insert plain=1 to disabled rendered views.
  const url = `${fileUrl}?plain=1#${rangeReference}`;
  return `[${range}](${url})`;
}

function formatMissingLines(
  fileUrl,
  lineRanges,
  showMissingMaxLength,
  showMissingLineLinks
) {
  const formatted = lineRanges.map(formatRangeText);
  const separator = " ";
  // Apply cropping before inserting ticks and linking, so that only non-syntax
  // characters are counted.
  const [cropped, isCropped] = cropRangeList(
    separator,
    showMissingMaxLength,
    formatted
  );
  const wrapped = cropped.map(tickWrap);
  const linked = showMissingLineLinks
    ? wrapped.map((range) => linkRange(fileUrl, range))
    : wrapped;
  const joined = linked.join(separator) + (isCropped ? " &hellip;" : "");
  return joined || " ";
}

function markdownReport(reports, commit, options) {
  const {
    minimumCoverage = 100,
    showLine = false,
    showBranch = false,
    showClassNames = false,
    showMissing = false,
    showMissingMaxLength = -1,
    linkMissingLines = false,
    linkMissingLinesSourceDir = null,
    filteredFiles = null,
    reportName = "Coverage Report",
    onlySummary = false,
  } = options || {};
  const status = (total) =>
    total >= minimumCoverage ? ":white_check_mark:" : ":x:";
  // Setup files
  const files = [];
  let output = "## Coverage Report\n";
  for (const report of reports) {
    const folder = reports.length <= 1 ? "" : ` ${report.folder}`;
    for (const file of report.files.filter(
      (file) => filteredFiles == null || filteredFiles.includes(file.filename)
    )) {
      const fileTotal = Math.floor(file.total);
      const fileLines = Math.floor(file.line);
      const fileBranch = Math.floor(file.branch);
      const fileMissing =
        showMissingMaxLength > 0
          ? crop(file.missing, showMissingMaxLength)
          : file.missing;
      if (false === onlySummary) {
        files.push([
          escapeMarkdown(showClassNames ? file.name : file.filename),
          `\`${fileTotal}%\``,
          showLine ? `\`${fileLines}%\`` : undefined,
          showBranch ? `\`${fileBranch}%\`` : undefined,
          status(fileTotal),
          showMissing ? (fileMissing ? `\`${fileMissing}\`` : " ") : undefined,
        ]);
      }
    }

    // Construct table
    /*
    | File          | Coverage |                    |
    |---------------|:--------:|:------------------:|
    | **All files** | `78%`    | :x:                |
    | foo.py        | `80%`    | :white_check_mark: |
    | bar.py        | `75%`    | :x:                |

    _Minimum allowed coverage is `80%`_
    */

    const total = Math.floor(report.total);
    const linesTotal = Math.floor(report.line);
    const branchTotal = Math.floor(report.branch);
    const table = [
      [
        "File",
        "Coverage",
        showLine ? "Lines" : undefined,
        showBranch ? "Branches" : undefined,
        " ",
        showMissing ? "Missing" : undefined,
      ],
      [
        "-",
        ":-:",
        showLine ? ":-:" : undefined,
        showBranch ? ":-:" : undefined,
        ":-:",
        showMissing ? ":-:" : undefined,
      ],
      [
        "**All files**",
        `\`${total}%\``,
        showLine ? `\`${linesTotal}%\`` : undefined,
        showBranch ? `\`${branchTotal}%\`` : undefined,
        status(total),
        showMissing ? " " : undefined,
      ],
      ...files,
    ]
      .map((row) => {
        return `| ${row.filter(Boolean).join(" | ")} |`;
      })
      .join("\n");
    const titleText = `<strong>${reportName}${folder}</strong>`;
    output += `${titleText}\n\n${table}\n\n`;
  }
  const minimumCoverageText = `_Minimum allowed coverage is \`${minimumCoverage}%\`_`;
  const footerText = `<p>Results for commit ${commit}.</p>`;
  output += `${minimumCoverageText}\n\n${footerText}`;
  return output;
}

async function addComment(pullRequestNumber, body, reportName) {
  const comments = await client.rest.issues.listComments({
    issue_number: pullRequestNumber,
    ...github.context.repo,
  });
  const commentFilter = reportName ? reportName : credits;
  const comment = comments.data.find((comment) =>
    comment.body.includes(commentFilter)
  );
  if (comment != null) {
    await client.rest.issues.updateComment({
      comment_id: comment.id,
      body: body,
      ...github.context.repo,
    });
  } else {
    await client.rest.issues.createComment({
      issue_number: pullRequestNumber,
      body: body,
      ...github.context.repo,
    });
  }
}

function annotationReport(reports, commit, options) {
  const {
    minimumCoverage = 100,
    showLine = false,
    showBranch = false,
    showClassNames = false,
    showMissing = false,
    showMissingMaxLength = -1,
    filteredFiles = null,
    failBelowThreshold = false,
  } = options || {};
  const covered = (total) => total >= minimumCoverage;
  const crop = (str, at) =>
    str.length > at ? str.slice(0, at).concat("...") : str;

  for (const report of reports) {
    for (const file of report.files.filter(
      (file) => filteredFiles == null || filteredFiles.includes(file.filename)
    )) {
      const fileTotal = Math.floor(file.total);
      if (!covered(fileTotal)) {
        const fileLines = Math.floor(file.line);
        const fileBranch = Math.floor(file.branch);
        const fileMissing =
          showMissingMaxLength > 0
            ? crop(file.missing, showMissingMaxLength)
            : file.missing;
        const annotation = [
          escapeMarkdown(showClassNames ? file.name : file.filename),
          `Coverage: ${fileTotal}%`,
          showLine ? `Lines: ${fileLines}%` : undefined,
          showBranch ? `Branches: ${fileBranch}%` : undefined,
          showMissing
            ? fileMissing
              ? `Missing: ${fileMissing}`
              : " "
            : undefined,
        ];
        const message = annotation.filter(Boolean).join(", ");
        if (failBelowThreshold) {
          core.error(message);
        } else {
          core.warning(message);
        }
      }
    }
  }
}

async function addCheck(body, reportName, sha, conclusion) {
  const checkName = reportName ? reportName : "coverage";

  await client.rest.checks.create({
    name: checkName,
    head_sha: sha,
    status: "completed",
    conclusion: conclusion,
    output: {
      title: checkName,
      summary: body,
    },
    ...github.context.repo,
  });
}

async function listChangedFiles(pullRequestNumber) {
  const files = await client.rest.pulls.listFiles({
    pull_number: pullRequestNumber,
    ...github.context.repo,
  });
  return files.data.map((file) => file.filename);
}

async function pullRequestInfo(payload = {}) {
  let commit = null;
  let pullRequestNumber = core.getInput("pull_request_number", {
    required: false,
  });

  if (pullRequestNumber) {
    // Use the supplied PR
    pullRequestNumber = parseInt(pullRequestNumber);
    const { data } = await client.rest.pulls.get({
      pull_number: pullRequestNumber,
      ...github.context.repo,
    });
    commit = data.head.sha;
  } else if (payload.workflow_run) {
    // Fetch all open PRs and match the commit hash.
    commit = payload.workflow_run.head_commit.id;
    const { data } = await client.rest.pulls.list({
      ...github.context.repo,
      state: "open",
    });
    pullRequestNumber = data
      .filter((d) => d.head.sha === commit)
      .reduce((n, d) => d.number, "");
  } else if (payload.pull_request) {
    // Try to find the PR from payload
    const { pull_request: pullRequest } = payload;
    pullRequestNumber = pullRequest.number;
    commit = pullRequest.head.sha;
  } else if (payload.after) {
    commit = payload.after;
  }

  return { pullRequestNumber, commit };
}

module.exports = {
  action,
  markdownReport,
  addComment,
  addCheck,
  listChangedFiles,
};
