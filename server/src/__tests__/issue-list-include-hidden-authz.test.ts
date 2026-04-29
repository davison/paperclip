import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(async () => false),
      hasPermission: vi.fn(async () => false),
    }),
    agentService: () => ({ getById: vi.fn(async () => null) }),
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => ({}),
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
    ISSUE_LIST_MAX_LIMIT: 200,
    clampIssueListLimit: (n: number) => Math.min(n, 200),
  }));
}

type Actor =
  | {
      type: "board";
      userId: string;
      companyIds?: string[];
      source?: "local_implicit" | string;
      isInstanceAdmin?: boolean;
      memberships?: Array<{ companyId: string; status: string; membershipRole: string }>;
    }
  | { type: "agent"; agentId: string; companyId: string; runId?: string };

async function createApp(actor: Actor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/issues includeHidden authz (RED-177)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue({ items: [], total: 0 });
  });

  it("rejects includeHidden=true from a non-admin board user with 403", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
    });
    const res = await request(app).get("/api/companies/company-1/issues?includeHidden=true");
    expect(res.status).toBe(403);
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("rejects includeHidden=true from an agent with 403", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    });
    const res = await request(app).get("/api/companies/company-1/issues?includeHidden=1");
    expect(res.status).toBe(403);
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("allows includeHidden=true from a local_implicit board caller and forwards the flag", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const res = await request(app).get("/api/companies/company-1/issues?includeHidden=true");
    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ includeHidden: true }),
    );
  });

  it("allows includeHidden=true from an instance admin and forwards the flag", async () => {
    const app = await createApp({
      type: "board",
      userId: "admin-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: true,
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    });
    const res = await request(app).get("/api/companies/company-1/issues?includeHidden=1");
    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ includeHidden: true }),
    );
  });

  it("does not require admin when includeHidden is omitted", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
    });
    const res = await request(app).get("/api/companies/company-1/issues");
    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ includeHidden: false }),
    );
  });
});
