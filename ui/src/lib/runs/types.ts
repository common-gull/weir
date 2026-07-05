// Run-shaped payloads from GET /api/runs and GET /api/runs/:id.

export interface RunSummary {
  id: string;
  workflow: string;
  status: string;
  priority: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  schedule_id: string | null;
}

export interface StepRow {
  id: number;
  run_id: string;
  seq: number;
  key: string;
  name: string;
  kind: string;
  status: string;
  result: string | null;
  error: string | null;
  child_run_id: string | null;
  created_at: number;
}

export interface AttemptRow {
  seq: number;
  attempt: number;
  status: string;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface RunDetail {
  run: RunSummary & { input: string | null; result: string | null; error: string | null; attempt: number };
  steps: StepRow[];
  attempts: AttemptRow[];
  children: { id: string; workflow: string; status: string }[];
}
