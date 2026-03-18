import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import {
  extractModelName,
  extractProviderIdWithFallback
} from "../lib/model-utils";
import { getUIAdapter } from "../adapters";
import { defaultCreateValues } from "./agent-config-defaults";
import { parseOnboardingGoalInput } from "../lib/onboarding-goal";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { OnboardingChat } from "./OnboardingChat";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import { ChoosePathButton } from "./PathInstructionsModal";
import { HintIcon } from "./agent-config-primitives";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";
import {
  Building2,
  Bot,
  Code,
  Gem,
  ListTodo,
  Rocket,
  ArrowLeft,
  ArrowRight,
  Terminal,
  Sparkles,
  MousePointer2,
  Check,
  Loader2,
  FolderOpen,
  ChevronDown,
  X,
  Plus,
  Pencil,
  Trash2,
  MessageSquare
} from "lucide-react";

type Step = 1 | 2 | 3 | 4 | 5 | 6;
type AdapterType =
  | "claude_local"
  | "codex_local"
  | "gemini_local"
  | "opencode_local"
  | "pi_local"
  | "cursor"
  | "process"
  | "http"
  | "openclaw_gateway";

const MISSION_PROMPT_CHIPS = [
  "Build a SaaS product",
  "Scale a content business",
  "Launch a marketplace"
];

function buildMissionFromQuestionnaire(q1: string, q2: string, q3: string, q4: string): string {
  const parts: string[] = [];
  if (q1.trim()) parts.push(q1.trim());
  if (q2.trim()) parts.push(`We serve ${q2.trim().toLowerCase()}.`);
  if (q3.trim()) parts.push(`Our biggest challenge is ${q3.trim().toLowerCase()}.`);
  if (q4.trim()) parts.push(`Success looks like ${q4.trim().toLowerCase()}.`);
  return parts.join(" ");
}

interface HiringRole {
  id: string;
  name: string;
  summary: string;
  expertise: string;
  priorities: string;
  boundaries: string;
  tools: string;
  communication: string;
  collaboration: string;
  enabled: boolean;
  editing: boolean;
}

function nextRoleId(): string {
  return crypto.randomUUID();
}

const EMPTY_ROLE: Omit<HiringRole, "id"> = {
  name: "", summary: "", expertise: "", priorities: "",
  boundaries: "", tools: "", communication: "", collaboration: "",
  enabled: true, editing: true,
};

function cleanMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*]\s+/, "")
    .trim();
}

/**
 * Map a bullet label (e.g. "Why:", "Responsibilities:") to a structured field.
 */
function classifyBullet(label: string): keyof HiringRole | null {
  const l = label.toLowerCase();
  if (/^why|^purpose|^overview/.test(l)) return "summary";
  if (/^responsibilit|^expertise|^duties|^scope|^what they do/.test(l)) return "expertise";
  if (/^priorit|^focus|^goals|^kpi|^metric/.test(l)) return "priorities";
  if (/^boundar|^limit|^should not|^don.?t|^avoid|^out of scope/.test(l)) return "boundaries";
  if (/^tool|^permission|^access|^tech|^stack/.test(l)) return "tools";
  if (/^communic|^tone|^style|^voice/.test(l)) return "communication";
  if (/^collaborat|^escalat|^report|^works with|^interact|^coordinat/.test(l)) return "collaboration";
  if (/^recommend|^profile|^ideal|^skills|^qualif/.test(l)) return "expertise";
  return null;
}

/**
 * Parse a markdown hiring plan into structured roles.
 * Handles two document formats:
 *   Format A: "## Role N: Name" with ### sub-sections (Priorities, Boundaries, etc.)
 *   Format B: "### N. Name" with **Label:** bullets
 * Fallback: comment-style bullet/table patterns.
 */
function parseHiringPlan(markdown: string): HiringRole[] {
  const roles: HiringRole[] = [];
  const seen = new Set<string>();

  // Split into ## sections (each role is a ## heading)
  const roleSections = markdown.split(/^##\s+/m).slice(1).filter(Boolean);

  for (const section of roleSections) {
    const lines = section.split("\n");
    const titleLine = lines[0]?.trim() ?? "";

    // Extract role name — match "Role N: Name" or just "N. Name" or plain name
    let name = titleLine
      .replace(/^role\s*\d*[:.]\s*/i, "")
      .replace(/^\d+[.)]\s*/, "")
      .replace(/\*\*/g, "")
      .trim();

    // Skip non-role sections
    const skipPatterns = /^(mission|hiring approach|hiring|roles|approach|open|phase|deferred|timeline|budget|summary|next steps|overview|notes|questions|appendix|---)/i;
    if (skipPatterns.test(name) || name.length < 3) continue;
    if (seen.has(name.toLowerCase())) continue;

    // Parse content: **Label:** bullets and ### sub-sections
    const fields: Record<string, string[]> = {};
    let currentField: string | null = null;

    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (!trimmed) continue;

      // ### sub-section heading (e.g. "### Priorities")
      const subHeadingMatch = trimmed.match(/^###\s+(.+)/);
      if (subHeadingMatch) {
        const label = subHeadingMatch[1].trim();
        const field = classifyBullet(label);
        currentField = (field && field !== "id" && field !== "name" && field !== "enabled" && field !== "editing")
          ? field : "expertise";
        continue;
      }

      // **Label:** inline (e.g. "**Why:** text")
      const boldLabelMatch = trimmed.match(/^\*\*([^*:]+)[*:]*\*\*[:\s]*(.*)/);
      const bulletLabelMatch = !boldLabelMatch && trimmed.match(/^\s*[-*]\s+\*\*([^*:]+)[*:]*\*\*[:\s]*(.*)/);
      const labelMatch = boldLabelMatch ?? bulletLabelMatch;

      if (labelMatch) {
        const label = labelMatch[1]!.trim();
        const value = cleanMd(labelMatch[2] ?? "");
        const field = classifyBullet(label);
        currentField = (field && field !== "id" && field !== "name" && field !== "enabled" && field !== "editing")
          ? field : "expertise";
        if (!fields[currentField]) fields[currentField] = [];
        if (value) fields[currentField].push(value);
        continue;
      }

      // Regular content line under current field
      if (currentField) {
        const cleaned = cleanMd(trimmed);
        if (cleaned) {
          if (!fields[currentField]) fields[currentField] = [];
          fields[currentField].push(cleaned);
        }
      }
    }

    const join = (arr?: string[]) => (arr ?? []).join("\n");

    seen.add(name.toLowerCase());
    roles.push({
      id: nextRoleId(),
      name,
      summary: join(fields.summary),
      expertise: join(fields.expertise),
      priorities: join(fields.priorities),
      boundaries: join(fields.boundaries),
      tools: join(fields.tools),
      communication: join(fields.communication),
      collaboration: join(fields.collaboration),
      enabled: true,
      editing: false,
    });
  }

  // Fallback: simple bullet parsing from comment text
  if (roles.length === 0) {
    const lines = markdown.split("\n");
    for (const line of lines) {
      const bulletMatch = line.match(
        /^\s*(?:[-*]|\d+[.)]\s*)\s*\*\*([^*]+)\*\*[:\s—–-]*(.*)$/
      );
      if (!bulletMatch) continue;
      const name = bulletMatch[1].trim();
      const summary = cleanMd(bulletMatch[2]);
      if (seen.has(name.toLowerCase())) continue;
      const skip = /^(phase|month|step|update|note|question|summary|timeline|priority|plan|total|budget|immediate|hire|\d+ immediate)/i;
      if (skip.test(name) || name.length < 3) continue;

      seen.add(name.toLowerCase());
      roles.push({
        id: nextRoleId(), name, summary,
        expertise: "", priorities: "", boundaries: "",
        tools: "", communication: "", collaboration: "",
        enabled: true, editing: false,
      });
    }
  }

  return roles;
}

const DEFAULT_TASK_DESCRIPTION = `Setup yourself as the CEO. Use the ceo persona found here:

https://github.com/paperclipai/companies/blob/main/default/ceo/AGENTS.md

Ensure you have a folder agents/ceo and then download this AGENTS.md, and sibling HEARTBEAT.md, SOUL.md, and TOOLS.md. and set that AGENTS.md as the path to your agents instruction file

After that, hire yourself a Founding Engineer agent and then plan the roadmap and tasks for your new company.`;

const ONBOARDING_STORAGE_KEY = "paperclip-onboarding-state";

function loadSavedState(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function OnboardingWizard() {
  const { onboardingOpen, onboardingOptions, closeOnboarding } = useDialog();
  const { selectedCompanyId, companies, setSelectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const initialStep = onboardingOptions.initialStep ?? 1;
  const existingCompanyId = onboardingOptions.companyId;

  // Restore saved state from localStorage (read once on mount)
  const saved = useMemo(loadSavedState, []);

  const [step, setStep] = useState<Step>((saved?.step as Step) ?? initialStep);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  // Step 1
  const [companyName, setCompanyName] = useState((saved?.companyName as string) ?? "");
  const [companyGoal, setCompanyGoal] = useState((saved?.companyGoal as string) ?? "");
  const [missionPath, setMissionPath] = useState<"direct" | "questionnaire" | null>((saved?.missionPath as "direct" | "questionnaire" | null) ?? null);
  const [missionConfirmed, setMissionConfirmed] = useState((saved?.missionConfirmed as boolean) ?? false);
  // Questionnaire answers
  const [q1, setQ1] = useState((saved?.q1 as string) ?? ""); // What do you do?
  const [q2, setQ2] = useState((saved?.q2 as string) ?? ""); // Who do you serve?
  const [q3, setQ3] = useState((saved?.q3 as string) ?? ""); // Biggest bottleneck?
  const [q4, setQ4] = useState((saved?.q4 as string) ?? ""); // What would success look like?

  // Step 2
  const [agentName, setAgentName] = useState((saved?.agentName as string) ?? "CEO");
  const [adapterType, setAdapterType] = useState<AdapterType>((saved?.adapterType as AdapterType) ?? "claude_local");
  const [cwd, setCwd] = useState((saved?.cwd as string) ?? "");
  const [model, setModel] = useState((saved?.model as string) ?? "");
  const [command, setCommand] = useState((saved?.command as string) ?? "");
  const [args, setArgs] = useState((saved?.args as string) ?? "");
  const [url, setUrl] = useState((saved?.url as string) ?? "");
  const [adapterEnvResult, setAdapterEnvResult] =
    useState<AdapterEnvironmentTestResult | null>(null);
  const [adapterEnvError, setAdapterEnvError] = useState<string | null>(null);
  const [adapterEnvLoading, setAdapterEnvLoading] = useState(false);
  const [forceUnsetAnthropicApiKey, setForceUnsetAnthropicApiKey] =
    useState(false);
  const [unsetAnthropicLoading, setUnsetAnthropicLoading] = useState(false);
  const [showMoreAdapters, setShowMoreAdapters] = useState(false);

  // Step 3
  const [taskTitle, setTaskTitle] = useState("Create your CEO HEARTBEAT.md");
  const [taskDescription, setTaskDescription] = useState(
    DEFAULT_TASK_DESCRIPTION
  );

  // Auto-grow textarea for task description
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  // Planning task + hiring plan
  const [planningTaskId, setPlanningTaskId] = useState<string | null>((saved?.planningTaskId as string) ?? null);
  const [planContent, setPlanContent] = useState<string | null>((saved?.planContent as string) ?? null);
  const [hiringRoles, setHiringRoles] = useState<HiringRole[]>((saved?.hiringRoles as HiringRole[]) ?? []);
  const [showRawPlan, setShowRawPlan] = useState(false);

  // Created entity IDs — pre-populate from existing company when skipping step 1
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(
    existingCompanyId ?? (saved?.createdCompanyId as string) ?? null
  );
  const [createdCompanyPrefix, setCreatedCompanyPrefix] = useState<
    string | null
  >((saved?.createdCompanyPrefix as string) ?? null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>((saved?.createdAgentId as string) ?? null);
  const [createdIssueRef, setCreatedIssueRef] = useState<string | null>(null);

  // Sync step and company when onboarding opens with explicit options.
  // Only override saved state when onboardingOptions explicitly provides values.
  useEffect(() => {
    if (!onboardingOpen) return;
    // If explicit options are provided, they take precedence over saved state
    if (onboardingOptions.initialStep) {
      setStep(onboardingOptions.initialStep);
    }
    if (onboardingOptions.companyId) {
      setCreatedCompanyId(onboardingOptions.companyId);
      setCreatedCompanyPrefix(null);
    }
  }, [
    onboardingOpen,
    onboardingOptions.companyId,
    onboardingOptions.initialStep
  ]);

  // Backfill issue prefix for an existing company once companies are loaded.
  useEffect(() => {
    if (!onboardingOpen || !createdCompanyId || createdCompanyPrefix) return;
    const company = companies.find((c) => c.id === createdCompanyId);
    if (company) setCreatedCompanyPrefix(company.issuePrefix);
  }, [onboardingOpen, createdCompanyId, createdCompanyPrefix, companies]);

  // Persist wizard state to localStorage on every change
  useEffect(() => {
    if (!onboardingOpen) return;
    const state = {
      step, companyName, companyGoal, missionPath, missionConfirmed,
      q1, q2, q3, q4, agentName, adapterType, cwd, model, command, args, url,
      createdCompanyId, createdCompanyPrefix, createdAgentId,
      planningTaskId, planContent, hiringRoles,
    };
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
  }, [
    onboardingOpen, step, companyName, companyGoal, missionPath, missionConfirmed,
    q1, q2, q3, q4, agentName, adapterType, cwd, model, command, args, url,
    createdCompanyId, createdCompanyPrefix, createdAgentId,
    planningTaskId, planContent, hiringRoles,
  ]);

  // Resize textarea when step 3 is shown or description changes
  useEffect(() => {
    // Auto-resize removed — task description textarea no longer used in onboarding
  }, [step, autoResizeTextarea]);

  const {
    data: adapterModels,
    error: adapterModelsError,
    isLoading: adapterModelsLoading,
    isFetching: adapterModelsFetching
  } = useQuery({
    queryKey: createdCompanyId
      ? queryKeys.agents.adapterModels(createdCompanyId, adapterType)
      : ["agents", "none", "adapter-models", adapterType],
    queryFn: () => agentsApi.adapterModels(createdCompanyId!, adapterType),
    enabled: Boolean(createdCompanyId) && onboardingOpen && step === 3
  });
  const isLocalAdapter =
    adapterType === "claude_local" ||
    adapterType === "codex_local" ||
    adapterType === "gemini_local" ||
    adapterType === "opencode_local" ||
    adapterType === "cursor";
  const effectiveAdapterCommand =
    command.trim() ||
    (adapterType === "codex_local"
      ? "codex"
      : adapterType === "gemini_local"
        ? "gemini"
      : adapterType === "cursor"
      ? "agent"
      : adapterType === "opencode_local"
      ? "opencode"
      : "claude");

  useEffect(() => {
    if (step !== 3) return;
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
  }, [step, adapterType, cwd, model, command, args, url]);

  const selectedModel = (adapterModels ?? []).find((m) => m.id === model);
  const hasAnthropicApiKeyOverrideCheck =
    adapterEnvResult?.checks.some(
      (check) =>
        check.code === "claude_anthropic_api_key_overrides_subscription"
    ) ?? false;
  const shouldSuggestUnsetAnthropicApiKey =
    adapterType === "claude_local" &&
    adapterEnvResult?.status === "fail" &&
    hasAnthropicApiKeyOverrideCheck;
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return (adapterModels ?? []).filter((entry) => {
      if (!query) return true;
      const provider = extractProviderIdWithFallback(entry.id, "");
      return (
        entry.id.toLowerCase().includes(query) ||
        entry.label.toLowerCase().includes(query) ||
        provider.toLowerCase().includes(query)
      );
    });
  }, [adapterModels, modelSearch]);
  const groupedModels = useMemo(() => {
    if (adapterType !== "opencode_local") {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id))
        }
      ];
    }
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const entry of filteredModels) {
      const provider = extractProviderIdWithFallback(entry.id);
      const bucket = groups.get(provider) ?? [];
      bucket.push(entry);
      groups.set(provider, bucket);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id))
      }));
  }, [filteredModels, adapterType]);

  function reset() {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    setStep(1);
    setLoading(false);
    setError(null);
    setCompanyName("");
    setCompanyGoal("");
    setMissionPath(null);
    setMissionConfirmed(false);
    setQ1("");
    setQ2("");
    setQ3("");
    setQ4("");
    setPlanningTaskId(null);
    setPlanContent(null);
    setHiringRoles([]);
    setShowRawPlan(false);
    setAgentName("CEO");
    setAdapterType("claude_local");
    setCwd("");
    setModel("");
    setCommand("");
    setArgs("");
    setUrl("");
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
    setAdapterEnvLoading(false);
    setForceUnsetAnthropicApiKey(false);
    setUnsetAnthropicLoading(false);
    setTaskTitle("Create your CEO HEARTBEAT.md");
    setTaskDescription(DEFAULT_TASK_DESCRIPTION);
    setCreatedCompanyId(null);
    setCreatedCompanyPrefix(null);
    setCreatedAgentId(null);
    setCreatedIssueRef(null);
  }

  function handleClose() {
    reset();
    closeOnboarding();
  }

  function buildAdapterConfig(): Record<string, unknown> {
    const adapter = getUIAdapter(adapterType);
    const config = adapter.buildAdapterConfig({
      ...defaultCreateValues,
      adapterType,
      cwd,
      model:
        adapterType === "codex_local"
          ? model || DEFAULT_CODEX_LOCAL_MODEL
          : adapterType === "gemini_local"
            ? model || DEFAULT_GEMINI_LOCAL_MODEL
          : adapterType === "cursor"
          ? model || DEFAULT_CURSOR_LOCAL_MODEL
          : model,
      command,
      args,
      url,
      dangerouslySkipPermissions: adapterType === "claude_local",
      dangerouslyBypassSandbox:
        adapterType === "codex_local"
          ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
          : defaultCreateValues.dangerouslyBypassSandbox
    });
    if (adapterType === "claude_local" && forceUnsetAnthropicApiKey) {
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
    }
    return config;
  }

  async function runAdapterEnvironmentTest(
    adapterConfigOverride?: Record<string, unknown>
  ): Promise<AdapterEnvironmentTestResult | null> {
    if (!createdCompanyId) {
      setAdapterEnvError(
        "Create or select a company before testing adapter environment."
      );
      return null;
    }
    setAdapterEnvLoading(true);
    setAdapterEnvError(null);
    try {
      const result = await agentsApi.testEnvironment(
        createdCompanyId,
        adapterType,
        {
          adapterConfig: adapterConfigOverride ?? buildAdapterConfig()
        }
      );
      setAdapterEnvResult(result);
      return result;
    } catch (err) {
      setAdapterEnvError(
        err instanceof Error ? err.message : "Adapter environment test failed"
      );
      return null;
    } finally {
      setAdapterEnvLoading(false);
    }
  }

  async function handleStep1Next() {
    setLoading(true);
    setError(null);
    try {
      const company = await companiesApi.create({ name: companyName.trim() });
      setCreatedCompanyId(company.id);
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

      const parsedGoal = parseOnboardingGoalInput(companyGoal);
      await goalsApi.create(company.id, {
        title: parsedGoal.title,
        ...(parsedGoal.description
          ? { description: parsedGoal.description }
          : {}),
        level: "company",
        status: "active"
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.list(company.id)
      });

      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
    } finally {
      setLoading(false);
    }
  }

  async function handleStep2Next() {
    if (!createdCompanyId) return;
    setLoading(true);
    setError(null);
    try {
      if (adapterType === "opencode_local") {
        const selectedModelId = model.trim();
        if (!selectedModelId) {
          setError(
            "OpenCode requires an explicit model in provider/model format."
          );
          return;
        }
        if (adapterModelsError) {
          setError(
            adapterModelsError instanceof Error
              ? adapterModelsError.message
              : "Failed to load OpenCode models."
          );
          return;
        }
        if (adapterModelsLoading || adapterModelsFetching) {
          setError(
            "OpenCode models are still loading. Please wait and try again."
          );
          return;
        }
        const discoveredModels = adapterModels ?? [];
        if (!discoveredModels.some((entry) => entry.id === selectedModelId)) {
          setError(
            discoveredModels.length === 0
              ? "No OpenCode models discovered. Run `opencode models` and authenticate providers."
              : `Configured OpenCode model is unavailable: ${selectedModelId}`
          );
          return;
        }
      }

      if (isLocalAdapter) {
        const result = adapterEnvResult ?? (await runAdapterEnvironmentTest());
        if (!result) return;
      }

      const agent = await agentsApi.create(createdCompanyId, {
        name: agentName.trim(),
        role: "ceo",
        adapterType,
        adapterConfig: buildAdapterConfig(),
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 3600,
            wakeOnDemand: true,
            cooldownSec: 10,
            maxConcurrentRuns: 1
          }
        }
      });
      setCreatedAgentId(agent.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(createdCompanyId)
      });

      // Create the planning task and kick off the conversation
      const planningIssue = await issuesApi.create(createdCompanyId, {
        title: "Build hiring plan with CEO",
        description: `Company mission: ${companyGoal}\n\nCollaborate with the board to create a hiring plan for the company.`,
        assigneeAgentId: agent.id,
        status: "in_progress"
      });
      setPlanningTaskId(planningIssue.id);
      await issuesApi.addComment(
        planningIssue.id,
        `Our company mission is: ${companyGoal}\n\nLet's build a hiring plan together. What roles do you think we need to accomplish this mission?`
      );

      setStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setLoading(false);
    }
  }

  async function handleUnsetAnthropicApiKey() {
    if (!createdCompanyId || unsetAnthropicLoading) return;
    setUnsetAnthropicLoading(true);
    setError(null);
    setAdapterEnvError(null);
    setForceUnsetAnthropicApiKey(true);

    const configWithUnset = (() => {
      const config = buildAdapterConfig();
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
      return config;
    })();

    try {
      if (createdAgentId) {
        await agentsApi.update(
          createdAgentId,
          { adapterConfig: configWithUnset },
          createdCompanyId
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(createdCompanyId)
        });
      }

      const result = await runAdapterEnvironmentTest(configWithUnset);
      if (result?.status === "fail") {
        setError(
          "Retried with ANTHROPIC_API_KEY unset in adapter config, but the environment test is still failing."
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to unset ANTHROPIC_API_KEY and retry."
      );
    } finally {
      setUnsetAnthropicLoading(false);
    }
  }

  async function handleStep3Next() {
    if (!createdCompanyId || !createdAgentId) return;
    setError(null);
    setStep(4);
  }

  async function handleLaunch() {
    if (!createdCompanyId || !createdAgentId) return;
    setLoading(true);
    setError(null);
    try {
      // Create a hire task for each approved role
      const approvedRoles = hiringRoles.filter(
        (r) => r.enabled && r.name.trim()
      );
      for (const role of approvedRoles) {
        const roleSpec = [
          role.summary && `**Summary:** ${role.summary}`,
          role.expertise && `**Expertise & Responsibilities:**\n${role.expertise}`,
          role.priorities && `**Priorities:**\n${role.priorities}`,
          role.boundaries && `**Boundaries:**\n${role.boundaries}`,
          role.tools && `**Tools & Permissions:**\n${role.tools}`,
          role.communication && `**Communication:**\n${role.communication}`,
          role.collaboration && `**Collaboration:**\n${role.collaboration}`,
        ].filter(Boolean).join("\n\n");
        await issuesApi.create(createdCompanyId, {
          title: `Hire: ${role.name}`,
          description: `Hire a ${role.name} for the company.\n\n${roleSpec}`,
          assigneeAgentId: createdAgentId,
          status: "todo"
        });
      }

      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.list(createdCompanyId)
      });

      setSelectedCompanyId(createdCompanyId);
      reset();
      closeOnboarding();
      navigate(
        createdCompanyPrefix
          ? `/${createdCompanyPrefix}/issues`
          : `/issues`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create hire tasks");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (step === 1 && companyName.trim() && companyGoal.trim()) handleStep1Next();
      else if (step === 2) setStep(3);
      else if (step === 3 && agentName.trim()) handleStep2Next();
      else if (step === 4) setStep(5);
      else if (step === 5) setStep(6);
      else if (step === 6) handleLaunch();
    }
  }

  if (!onboardingOpen) return null;

  return (
    <Dialog
      open={onboardingOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogPortal>
        {/* Plain div instead of DialogOverlay — Radix's overlay wraps in
            RemoveScroll which blocks wheel events on our custom (non-DialogContent)
            scroll container. A plain div preserves the background without scroll-locking. */}
        <div className="fixed inset-0 z-50 bg-background" />
        <div className="fixed inset-0 z-50 flex" onKeyDown={handleKeyDown}>
          {/* Close button */}
          <button
            onClick={handleClose}
            className="absolute top-4 left-4 z-10 rounded-sm p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </button>

          {/* Left half — form */}
          <div
            className={cn(
              "w-full flex flex-col overflow-y-auto transition-[width] duration-500 ease-in-out",
              step === 1 ? "md:w-1/2" : "md:w-full"
            )}
          >
            <div className="w-full max-w-md mx-auto my-auto px-8 py-12 shrink-0">
              {/* Progress tabs */}
              <div className="flex items-center gap-0 mb-8 border-b border-border">
                {(
                  [
                    { step: 1 as Step, label: "Mission", icon: Building2 },
                    { step: 2 as Step, label: "Launch", icon: Rocket },
                    { step: 3 as Step, label: "CEO", icon: Bot },
                    { step: 4 as Step, label: "Chat", icon: Sparkles },
                    { step: 5 as Step, label: "Plan", icon: ListTodo },
                    { step: 6 as Step, label: "Hire", icon: Bot }
                  ] as const
                ).map(({ step: s, label, icon: Icon }) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStep(s)}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-2 text-xs font-medium border-b-2 -mb-px transition-colors cursor-pointer",
                      s === step
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground/70 hover:border-border"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>

              {/* Step content */}
              {step === 1 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Define your mission</h3>
                      <p className="text-xs text-muted-foreground">
                        Your mission drives everything — your CEO, your hires,
                        and the work your company will do.
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 group">
                    <label
                      className={cn(
                        "text-xs mb-1 block transition-colors",
                        companyName.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )}
                    >
                      Company name
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="Acme Corp"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      autoFocus
                    />
                  </div>

                  {/* Mission path selector */}
                  {!missionPath && (
                    <div className="space-y-3">
                      <label className="text-xs text-foreground block">
                        How would you like to define your mission?
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          className="flex flex-col items-center gap-1.5 rounded-md border border-border p-3 text-xs hover:bg-accent/50 transition-colors"
                          onClick={() => setMissionPath("direct")}
                        >
                          <Sparkles className="h-4 w-4" />
                          <span className="font-medium">I know my mission</span>
                          <span className="text-muted-foreground text-[10px]">
                            Type it directly
                          </span>
                        </button>
                        <button
                          className="flex flex-col items-center gap-1.5 rounded-md border border-border p-3 text-xs hover:bg-accent/50 transition-colors"
                          onClick={() => setMissionPath("questionnaire")}
                        >
                          <ListTodo className="h-4 w-4" />
                          <span className="font-medium">Help me figure it out</span>
                          <span className="text-muted-foreground text-[10px]">
                            Answer a few questions
                          </span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Direct mission input */}
                  {missionPath === "direct" && (
                    <div className="space-y-3">
                      <div className="group">
                        <label
                          className={cn(
                            "text-xs mb-1 block transition-colors",
                            companyGoal.trim()
                              ? "text-foreground"
                              : "text-muted-foreground group-focus-within:text-foreground"
                          )}
                        >
                          Mission
                        </label>
                        <textarea
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[60px]"
                          placeholder="What is this company trying to achieve?"
                          value={companyGoal}
                          onChange={(e) => setCompanyGoal(e.target.value)}
                          autoFocus
                        />
                      </div>
                      {/* Prompt chips for inspiration */}
                      <div className="flex flex-wrap gap-1.5">
                        {MISSION_PROMPT_CHIPS.map((chip) => (
                          <button
                            key={chip}
                            className={cn(
                              "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                              companyGoal === chip
                                ? "border-foreground bg-accent text-foreground"
                                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/50"
                            )}
                            onClick={() => setCompanyGoal(chip)}
                          >
                            {chip}
                          </button>
                        ))}
                      </div>
                      <button
                        className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => { setMissionPath(null); setCompanyGoal(""); }}
                      >
                        ← Choose a different path
                      </button>
                    </div>
                  )}

                  {/* Questionnaire path */}
                  {missionPath === "questionnaire" && !missionConfirmed && (
                    <div className="space-y-3">
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What does your company do?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. We create educational YouTube content about AI"
                          value={q1}
                          onChange={(e) => setQ1(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Who do you serve?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Non-technical professionals curious about AI tools"
                          value={q2}
                          onChange={(e) => setQ2(e.target.value)}
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What's your biggest bottleneck right now?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Can't produce content fast enough across multiple channels"
                          value={q3}
                          onChange={(e) => setQ3(e.target.value)}
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What would success look like in 6 months?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Publishing daily content across 4 platforms with a team of AI agents"
                          value={q4}
                          onChange={(e) => setQ4(e.target.value)}
                        />
                      </div>
                      {q1.trim() && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setCompanyGoal(buildMissionFromQuestionnaire(q1, q2, q3, q4));
                            setMissionConfirmed(true);
                          }}
                        >
                          Generate my mission
                        </Button>
                      )}
                      <button
                        className="text-[11px] text-muted-foreground hover:text-foreground transition-colors block"
                        onClick={() => { setMissionPath(null); setQ1(""); setQ2(""); setQ3(""); setQ4(""); }}
                      >
                        ← Choose a different path
                      </button>
                    </div>
                  )}

                  {/* Questionnaire result — editable mission */}
                  {missionPath === "questionnaire" && missionConfirmed && (
                    <div className="space-y-3">
                      <div className="group">
                        <label className="text-xs text-foreground mb-1 block">
                          Here's your draft mission — edit it however you like:
                        </label>
                        <textarea
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[80px]"
                          value={companyGoal}
                          onChange={(e) => setCompanyGoal(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <button
                        className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => { setMissionConfirmed(false); setCompanyGoal(""); }}
                      >
                        ← Back to questions
                      </button>
                    </div>
                  )}

                  {/* Confirm mission note */}
                  {companyGoal.trim() && companyName.trim() && (
                    <p className="text-[11px] text-muted-foreground italic">
                      You can always change your mission later in settings.
                    </p>
                  )}
                </div>
              )}

              {/* Step 2: Launch celebration */}
              {step === 2 && (
                <div className="space-y-6 text-center py-4">
                  <div className="text-5xl">🚀</div>
                  <div>
                    <h3 className="text-xl font-semibold">{companyName} is live!</h3>
                    <p className="text-sm text-muted-foreground mt-2">
                      Your company has been created with the mission:
                    </p>
                    <p className="text-sm font-medium mt-1 italic">
                      "{companyGoal}"
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Next, let's bring your CEO to life.
                  </p>
                </div>
              )}

              {/* Step 3: Create your CEO (was step 2) */}
              {step === 3 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Bot className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Bring your CEO to life</h3>
                      <p className="text-xs text-muted-foreground">
                        Give your CEO a heartbeat. They'll lead{" "}
                        <span className="font-medium text-foreground">{companyName}</span>{" "}
                        toward its mission.
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Agent name
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="CEO"
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      autoFocus
                    />
                  </div>

                  {/* Adapter type radio cards */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">
                      Adapter type
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        {
                          value: "claude_local" as const,
                          label: "Claude Code",
                          icon: Sparkles,
                          desc: "Local Claude agent",
                          recommended: true
                        },
                        {
                          value: "codex_local" as const,
                          label: "Codex",
                          icon: Code,
                          desc: "Local Codex agent",
                          recommended: true
                        }
                      ].map((opt) => (
                        <button
                          key={opt.value}
                          className={cn(
                            "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                            adapterType === opt.value
                              ? "border-foreground bg-accent"
                              : "border-border hover:bg-accent/50"
                          )}
                          onClick={() => {
                            const nextType = opt.value as AdapterType;
                            setAdapterType(nextType);
                            if (nextType === "codex_local" && !model) {
                              setModel(DEFAULT_CODEX_LOCAL_MODEL);
                            }
                            if (nextType !== "codex_local") {
                              setModel("");
                            }
                          }}
                        >
                          {opt.recommended && (
                            <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                              Recommended
                            </span>
                          )}
                          <opt.icon className="h-4 w-4" />
                          <span className="font-medium">{opt.label}</span>
                          <span className="text-muted-foreground text-[10px]">
                            {opt.desc}
                          </span>
                        </button>
                      ))}
                    </div>

                    <button
                      className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowMoreAdapters((v) => !v)}
                    >
                      <ChevronDown
                        className={cn(
                          "h-3 w-3 transition-transform",
                          showMoreAdapters ? "rotate-0" : "-rotate-90"
                        )}
                      />
                      More Agent Adapter Types
                    </button>

                    {showMoreAdapters && (
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        {[
                          {
                            value: "gemini_local" as const,
                            label: "Gemini CLI",
                            icon: Gem,
                            desc: "Local Gemini agent"
                          },
                          {
                            value: "opencode_local" as const,
                            label: "OpenCode",
                            icon: OpenCodeLogoIcon,
                            desc: "Local multi-provider agent"
                          },
                          {
                            value: "pi_local" as const,
                            label: "Pi",
                            icon: Terminal,
                            desc: "Local Pi agent"
                          },
                          {
                            value: "cursor" as const,
                            label: "Cursor",
                            icon: MousePointer2,
                            desc: "Local Cursor agent"
                          },
                          {
                            value: "openclaw_gateway" as const,
                            label: "OpenClaw Gateway",
                            icon: Bot,
                            desc: "Invoke OpenClaw via gateway protocol",
                            comingSoon: true,
                            disabledLabel: "Configure OpenClaw within the App"
                          }
                        ].map((opt) => (
                          <button
                            key={opt.value}
                            disabled={!!opt.comingSoon}
                            className={cn(
                              "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                              opt.comingSoon
                                ? "border-border opacity-40 cursor-not-allowed"
                                : adapterType === opt.value
                                ? "border-foreground bg-accent"
                                : "border-border hover:bg-accent/50"
                            )}
                            onClick={() => {
                              if (opt.comingSoon) return;
                              const nextType = opt.value as AdapterType;
                              setAdapterType(nextType);
                              if (nextType === "gemini_local" && !model) {
                                setModel(DEFAULT_GEMINI_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "cursor" && !model) {
                                setModel(DEFAULT_CURSOR_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "opencode_local") {
                                if (!model.includes("/")) {
                                  setModel("");
                                }
                                return;
                              }
                              setModel("");
                            }}
                          >
                            <opt.icon className="h-4 w-4" />
                            <span className="font-medium">{opt.label}</span>
                            <span className="text-muted-foreground text-[10px]">
                              {opt.comingSoon
                                ? (opt as { disabledLabel?: string })
                                    .disabledLabel ?? "Coming soon"
                                : opt.desc}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Conditional adapter fields */}
                  {(adapterType === "claude_local" ||
                    adapterType === "codex_local" ||
                    adapterType === "gemini_local" ||
                    adapterType === "opencode_local" ||
                    adapterType === "pi_local" ||
                    adapterType === "cursor") && (
                    <div className="space-y-3">
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <label className="text-xs text-muted-foreground">
                            Working directory
                          </label>
                          <HintIcon text="Paperclip works best if you create a new folder for your agents to keep their memories and stay organized. Create a new folder and put the path here." />
                        </div>
                        <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                          <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <input
                            className="w-full bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/50"
                            placeholder="/path/to/project"
                            value={cwd}
                            onChange={(e) => setCwd(e.target.value)}
                          />
                          <ChoosePathButton />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Model
                        </label>
                        <Popover
                          open={modelOpen}
                          onOpenChange={(next) => {
                            setModelOpen(next);
                            if (!next) setModelSearch("");
                          }}
                        >
                          <PopoverTrigger asChild>
                            <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
                              <span
                                className={cn(
                                  !model && "text-muted-foreground"
                                )}
                              >
                                {selectedModel
                                  ? selectedModel.label
                                  : model ||
                                    (adapterType === "opencode_local"
                                      ? "Select model (required)"
                                      : "Default")}
                              </span>
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-[var(--radix-popover-trigger-width)] p-1"
                            align="start"
                          >
                            <input
                              className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
                              placeholder="Search models..."
                              value={modelSearch}
                              onChange={(e) => setModelSearch(e.target.value)}
                              autoFocus
                            />
                            {adapterType !== "opencode_local" && (
                              <button
                                className={cn(
                                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                  !model && "bg-accent"
                                )}
                                onClick={() => {
                                  setModel("");
                                  setModelOpen(false);
                                }}
                              >
                                Default
                              </button>
                            )}
                            <div className="max-h-[240px] overflow-y-auto">
                              {groupedModels.map((group) => (
                                <div
                                  key={group.provider}
                                  className="mb-1 last:mb-0"
                                >
                                  {adapterType === "opencode_local" && (
                                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                      {group.provider} ({group.entries.length})
                                    </div>
                                  )}
                                  {group.entries.map((m) => (
                                    <button
                                      key={m.id}
                                      className={cn(
                                        "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                        m.id === model && "bg-accent"
                                      )}
                                      onClick={() => {
                                        setModel(m.id);
                                        setModelOpen(false);
                                      }}
                                    >
                                      <span
                                        className="block w-full text-left truncate"
                                        title={m.id}
                                      >
                                        {adapterType === "opencode_local"
                                          ? extractModelName(m.id)
                                          : m.label}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              ))}
                            </div>
                            {filteredModels.length === 0 && (
                              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                No models discovered.
                              </p>
                            )}
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>
                  )}

                  {isLocalAdapter && (
                    <div className="space-y-2 rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium">
                            Adapter environment check
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Runs a live probe that asks the adapter CLI to
                            respond with hello.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-xs"
                          disabled={adapterEnvLoading}
                          onClick={() => void runAdapterEnvironmentTest()}
                        >
                          {adapterEnvLoading ? "Testing..." : "Test now"}
                        </Button>
                      </div>

                      {adapterEnvError && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
                          {adapterEnvError}
                        </div>
                      )}

                      {adapterEnvResult &&
                      adapterEnvResult.status === "pass" ? (
                        <div className="flex items-center gap-2 rounded-md border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300 animate-in fade-in slide-in-from-bottom-1 duration-300">
                          <Check className="h-3.5 w-3.5 shrink-0" />
                          <span className="font-medium">Passed</span>
                        </div>
                      ) : adapterEnvResult ? (
                        <AdapterEnvironmentResult result={adapterEnvResult} />
                      ) : null}

                      {shouldSuggestUnsetAnthropicApiKey && (
                        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-2.5 py-2 space-y-2">
                          <p className="text-[11px] text-amber-900/90 leading-relaxed">
                            Claude failed while{" "}
                            <span className="font-mono">ANTHROPIC_API_KEY</span>{" "}
                            is set. You can clear it in this CEO adapter config
                            and retry the probe.
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            disabled={
                              adapterEnvLoading || unsetAnthropicLoading
                            }
                            onClick={() => void handleUnsetAnthropicApiKey()}
                          >
                            {unsetAnthropicLoading
                              ? "Retrying..."
                              : "Unset ANTHROPIC_API_KEY"}
                          </Button>
                        </div>
                      )}

                      {adapterEnvResult && adapterEnvResult.status === "fail" && (
                        <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-[11px] space-y-1.5">
                          <p className="font-medium">Manual debug</p>
                          <p className="text-muted-foreground font-mono break-all">
                            {adapterType === "cursor"
                              ? `${effectiveAdapterCommand} -p --mode ask --output-format json \"Respond with hello.\"`
                              : adapterType === "codex_local"
                              ? `${effectiveAdapterCommand} exec --json -`
                              : adapterType === "gemini_local"
                                ? `${effectiveAdapterCommand} --output-format json "Respond with hello."`
                              : adapterType === "opencode_local"
                                ? `${effectiveAdapterCommand} run --format json "Respond with hello."`
                              : `${effectiveAdapterCommand} --print - --output-format stream-json --verbose`}
                          </p>
                          <p className="text-muted-foreground">
                            Prompt:{" "}
                            <span className="font-mono">Respond with hello.</span>
                          </p>
                          {adapterType === "cursor" ||
                          adapterType === "codex_local" ||
                          adapterType === "gemini_local" ||
                          adapterType === "opencode_local" ? (
                            <p className="text-muted-foreground">
                              If auth fails, set{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "CURSOR_API_KEY"
                                  : adapterType === "gemini_local"
                                    ? "GEMINI_API_KEY"
                                    : "OPENAI_API_KEY"}
                              </span>{" "}
                              in env or run{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "agent login"
                                  : adapterType === "codex_local"
                                    ? "codex login"
                                    : adapterType === "gemini_local"
                                      ? "gemini auth"
                                      : "opencode auth login"}
                              </span>
                              .
                            </p>
                          ) : (
                            <p className="text-muted-foreground">
                              If login is required, run{" "}
                              <span className="font-mono">claude login</span>{" "}
                              and retry.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {adapterType === "process" && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Command
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. node, python"
                          value={command}
                          onChange={(e) => setCommand(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Args (comma-separated)
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. script.js, --flag"
                          value={args}
                          onChange={(e) => setArgs(e.target.value)}
                        />
                      </div>
                    </div>
                  )}

                  {(adapterType === "http" ||
                    adapterType === "openclaw_gateway") && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        {adapterType === "openclaw_gateway"
                          ? "Gateway URL"
                          : "Webhook URL"}
                      </label>
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                        placeholder={
                          adapterType === "openclaw_gateway"
                            ? "ws://127.0.0.1:18789"
                            : "https://..."
                        }
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Step 4: Chat with CEO */}
              {step === 4 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Sparkles className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Chat with your CEO</h3>
                      <p className="text-xs text-muted-foreground">
                        Work with your CEO to build a hiring plan for{" "}
                        <span className="font-medium text-foreground">{companyName}</span>.
                      </p>
                    </div>
                  </div>
                  {planningTaskId ? (
                    <OnboardingChat
                      taskId={planningTaskId}
                      agentId={createdAgentId!}
                      agentName={agentName}
                      onPlanDetected={(md) => setPlanContent(md)}
                      onReviewPlan={async () => {
                        // Always fetch the latest plan document for the richest content
                        try {
                          const doc = await issuesApi.getDocument(planningTaskId!, "plan");
                          if (doc.body) {
                            setPlanContent(doc.body);
                            setHiringRoles(parseHiringPlan(doc.body));
                          } else if (planContent) {
                            setHiringRoles(parseHiringPlan(planContent));
                          }
                        } catch {
                          if (planContent) {
                            setHiringRoles(parseHiringPlan(planContent));
                          }
                        }
                        setStep(5);
                      }}
                    />
                  ) : (
                    <div className="rounded-md border border-border p-4 min-h-[200px] flex items-center justify-center">
                      <p className="text-sm text-muted-foreground">
                        No planning task found. Go back and create your CEO first.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Step 5: Review hiring plan */}
              {step === 5 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <ListTodo className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Review your hiring plan</h3>
                      <p className="text-xs text-muted-foreground">
                        Select which roles to hire. Edit, add, or remove roles
                        before approving.
                      </p>
                    </div>
                  </div>

                  {hiringRoles.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border p-4 text-center">
                      <p className="text-sm text-muted-foreground mb-2">
                        No roles parsed from the hiring plan yet.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setHiringRoles([{ ...EMPTY_ROLE, id: nextRoleId() }])
                        }
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        Add a role manually
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {hiringRoles.map((role) => (
                        <RoleCard
                          key={role.id}
                          role={role}
                          onChange={(updated) =>
                            setHiringRoles((prev) =>
                              prev.map((r) => (r.id === role.id ? updated : r))
                            )
                          }
                          onDelete={() =>
                            setHiringRoles((prev) =>
                              prev.filter((r) => r.id !== role.id)
                            )
                          }
                        />
                      ))}
                    </div>
                  )}

                  {/* Add role button */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setHiringRoles((prev) => [
                        ...prev,
                        { ...EMPTY_ROLE, id: nextRoleId() },
                      ])
                    }
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Add role
                  </Button>

                  {/* Revise with CEO */}
                  {planningTaskId && (
                    <button
                      className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setStep(4)}
                    >
                      <MessageSquare className="h-3 w-3" />
                      Revise with CEO
                    </button>
                  )}

                  {/* Collapsible raw plan */}
                  {planContent && (
                    <div>
                      <button
                        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => setShowRawPlan((v) => !v)}
                      >
                        <ChevronDown
                          className={cn(
                            "h-3 w-3 transition-transform",
                            showRawPlan ? "rotate-0" : "-rotate-90"
                          )}
                        />
                        View raw plan
                      </button>
                      {showRawPlan && (
                        <div className="mt-2 rounded-md border border-border p-3 text-xs bg-muted/30 max-h-[200px] overflow-y-auto">
                          <pre className="whitespace-pre-wrap">{planContent}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Step 6: Make your first hires */}
              {step === 6 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Rocket className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Make your first hires</h3>
                      <p className="text-xs text-muted-foreground">
                        Your CEO will create these roles for{" "}
                        <span className="font-medium text-foreground">{companyName}</span>.
                      </p>
                    </div>
                  </div>
                  <div className="border border-border divide-y divide-border rounded-md">
                    {hiringRoles
                      .filter((r) => r.enabled && r.name.trim())
                      .map((role) => (
                        <div
                          key={role.id}
                          className="flex items-center gap-3 px-3 py-2.5"
                        >
                          <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {role.name}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {role.summary || "New hire"}
                            </p>
                          </div>
                          <span className="text-[10px] text-amber-500 font-medium">
                            To hire
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="mt-3">
                  <p className="text-xs text-destructive">{error}</p>
                </div>
              )}

              {/* Footer navigation */}
              <div className="flex items-center justify-between mt-8">
                <div>
                  {step > 1 && step > (onboardingOptions.initialStep ?? 1) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep((step - 1) as Step)}
                      disabled={loading}
                    >
                      <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {step === 1 && (
                    <Button
                      size="sm"
                      disabled={!companyName.trim() || !companyGoal.trim() || loading}
                      onClick={handleStep1Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Confirm mission"}
                    </Button>
                  )}
                  {step === 2 && (
                    <Button
                      size="sm"
                      onClick={() => setStep(3)}
                    >
                      <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      Hire your CEO
                    </Button>
                  )}
                  {step === 3 && (
                    <Button
                      size="sm"
                      disabled={
                        !agentName.trim() || loading || adapterEnvLoading
                      }
                      onClick={handleStep2Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Bringing to life..." : "Give it a heartbeat"}
                    </Button>
                  )}
                  {step === 4 && !planContent && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep(5)}
                    >
                      Skip chat
                    </Button>
                  )}
                  {step === 5 && (
                    <Button
                      size="sm"
                      disabled={!hiringRoles.some((r) => r.enabled && r.name.trim())}
                      onClick={() => setStep(6)}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" />
                      Approve hiring plan
                    </Button>
                  )}
                  {step === 6 && (
                    <Button size="sm" disabled={loading} onClick={handleLaunch}>
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Rocket className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating tasks..." : "Make your first hires"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right half — ASCII art (hidden on mobile) */}
          <div
            className={cn(
              "hidden md:block overflow-hidden bg-[#1d1d1d] transition-[width,opacity] duration-500 ease-in-out",
              step === 1 ? "w-1/2 opacity-100" : "w-0 opacity-0"
            )}
          >
            <AsciiArtAnimation />
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}

const ROLE_FIELDS: Array<{ key: keyof HiringRole; label: string; placeholder: string }> = [
  { key: "summary", label: "Summary", placeholder: "One-line description of this role" },
  { key: "expertise", label: "Expertise & Responsibilities", placeholder: "What this agent does, its skills, and detailed responsibilities" },
  { key: "priorities", label: "Priorities", placeholder: "What this role focuses on first, in order of importance" },
  { key: "boundaries", label: "Boundaries", placeholder: "What this role should NOT do, out-of-scope areas" },
  { key: "tools", label: "Tools & Permissions", placeholder: "What tools, systems, or access this role needs" },
  { key: "communication", label: "Communication", placeholder: "Tone, style, and interaction guidelines" },
  { key: "collaboration", label: "Collaboration & Escalation", placeholder: "Who this role works with, escalation paths" },
];

function RoleCard({
  role,
  onChange,
  onDelete,
}: {
  role: HiringRole;
  onChange: (updated: HiringRole) => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const update = (field: keyof HiringRole, value: string) =>
    onChange({ ...role, [field]: value });

  if (role.editing) {
    return (
      <div
        className={cn(
          "rounded-md border px-3 py-3 transition-colors space-y-3",
          role.enabled ? "border-border bg-background" : "border-border/50 bg-muted/30 opacity-60"
        )}
      >
        <input
          className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
          placeholder="Role name"
          value={role.name}
          onChange={(e) => update("name", e.target.value)}
          autoFocus
        />
        {ROLE_FIELDS.map(({ key, label, placeholder }) => (
          <div key={key}>
            <label className="text-[11px] text-muted-foreground mb-0.5 block font-medium">
              {label}
            </label>
            <textarea
              className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring resize-y min-h-[60px] max-h-[200px]"
              placeholder={placeholder}
              value={(role[key] as string) || ""}
              onChange={(e) => update(key, e.target.value)}
            />
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange({ ...role, editing: false })}
        >
          <Check className="h-3 w-3 mr-1" />
          Done
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2.5 transition-colors",
        role.enabled ? "border-border bg-background" : "border-border/50 bg-muted/30 opacity-60"
      )}
    >
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={role.enabled}
          onChange={(e) => onChange({ ...role, enabled: e.target.checked })}
          className="mt-1 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{role.name || "Untitled role"}</p>
          {role.summary && (
            <p className="text-xs text-muted-foreground mt-0.5">{role.summary}</p>
          )}
          {expanded && (
            <div className="mt-2 space-y-1.5">
              {ROLE_FIELDS.filter(({ key }) => key !== "summary" && (role[key] as string)?.trim()).map(({ key, label }) => (
                <div key={key}>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
                  <p className="text-xs text-muted-foreground whitespace-pre-line">{role[key] as string}</p>
                </div>
              ))}
            </div>
          )}
          <button
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors mt-1"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => onChange({ ...role, editing: true })}
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            className="p-1 text-muted-foreground hover:text-destructive transition-colors"
            onClick={onDelete}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

function AdapterEnvironmentResult({
  result
}: {
  result: AdapterEnvironmentTestResult;
}) {
  const statusLabel =
    result.status === "pass"
      ? "Passed"
      : result.status === "warn"
      ? "Warnings"
      : "Failed";
  const statusClass =
    result.status === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : result.status === "warn"
      ? "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
      : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-2.5 py-2 text-[11px] ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{statusLabel}</span>
        <span className="opacity-80">
          {new Date(result.testedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-1.5 space-y-1">
        {result.checks.map((check, idx) => (
          <div
            key={`${check.code}-${idx}`}
            className="leading-relaxed break-words"
          >
            <span className="font-medium uppercase tracking-wide opacity-80">
              {check.level}
            </span>
            <span className="mx-1 opacity-60">·</span>
            <span>{check.message}</span>
            {check.detail && (
              <span className="block opacity-75 break-all">
                ({check.detail})
              </span>
            )}
            {check.hint && (
              <span className="block opacity-90 break-words">
                Hint: {check.hint}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
