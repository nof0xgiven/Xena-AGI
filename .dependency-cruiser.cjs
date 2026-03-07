/** @type {import('dependency-cruiser').CruiseOptions} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Keep module relationships acyclic so orchestration stays inspectable.",
      from: {},
      to: {
        circular: true
      }
    },
    {
      name: "api-no-deep-runtime-imports",
      severity: "error",
      comment: "API entrypoints should hand off to ingress, not reach into runtime internals.",
      from: {
        path: "^src/api/"
      },
      to: {
        path: "^src/(artifacts|memory|observability|orchestration|persistence|providers|reconciliation|runtime|tools)(/|$)"
      }
    },
    {
      name: "core-no-api-imports",
      severity: "error",
      comment: "Core modules should not depend on HTTP concerns.",
      from: {
        path: "^src/(agents|artifacts|contracts|ingress|memory|observability|orchestration|persistence|prompts|providers|reconciliation|runtime|tools|trigger)(/|$)"
      },
      to: {
        path: "^src/api(/|$)"
      }
    },
    {
      name: "persistence-no-high-level-orchestration",
      severity: "error",
      comment: "Persistence should remain foundational and avoid importing orchestration layers.",
      from: {
        path: "^src/persistence/"
      },
      to: {
        path: "^src/(api|ingress|memory|orchestration|reconciliation|runtime|trigger)(/|$)"
      }
    }
  ],
  options: {
    tsConfig: {
      fileName: "tsconfig.json"
    },
    doNotFollow: {
      path: "node_modules"
    },
    exclude: {
      path: "^(coverage|dist|node_modules)"
    }
  }
};
