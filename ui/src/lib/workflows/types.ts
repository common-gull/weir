// A registered workflow plus a roll-up of its run history, as returned by GET /api/workflows.
export interface WorkflowSummary {
    name: string;
    schedule: { cron: string; overlap?: string } | null;
    capabilities: string[];
    priority: number;
    lastRun: { id: string; status: string; created_at: number; finished_at: number | null } | null;
    counts: Record<string, number>;
}
