import { useState, useEffect } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import * as api from "../api/client";
import type { JobListing, KanbanStatus, KanbanColumnDef } from "../types";
import { KANBAN_COLUMNS } from "../types";

// ─── Card ─────────────────────────────────────────────────────────

function JobCard({
  job,
  isDragging = false,
}: {
  job: JobListing;
  isDragging?: boolean;
}) {
  const pct = job.matchScore !== undefined ? Math.round(job.matchScore * 100) : null;
  return (
    <div
      className={`card p-4 cursor-grab active:cursor-grabbing transition-all ${
        isDragging ? "opacity-50 shadow-xl ring-1 ring-accent/30" : "hover:border-border-default"
      }`}
    >
      <div className="text-sm font-medium text-zinc-100 leading-tight line-clamp-2">
        {job.title}
      </div>
      <div className="text-xs text-zinc-500 mt-1.5">{job.company}</div>
      <div className="flex items-center gap-2 mt-3">
        {job.remote && (
          <span className="text-[10px] text-emerald-500 font-medium">Remote</span>
        )}
        {pct !== null && (
          <span className={`text-[10px] font-mono ml-auto ${
            pct >= 80 ? "text-emerald-500" : pct >= 60 ? "text-amber-500" : "text-zinc-600"
          }`}>
            {pct}%
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Draggable card ───────────────────────────────────────────────

function DraggableCard({ job }: { job: JobListing }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: job.id, data: { job } });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Translate.toString(transform) }}
    >
      <JobCard job={job} isDragging={isDragging} />
    </div>
  );
}

// ─── Column ───────────────────────────────────────────────────────

function KanbanColumn({
  col,
  jobs,
}: {
  col: KanbanColumnDef;
  jobs: JobListing[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.id });

  return (
    <div className="flex flex-col min-h-0 w-[260px] flex-shrink-0">
      {/* Column header */}
      <div className="flex items-center gap-2 px-1 mb-4">
        <span
          className="w-2 h-2 rounded-full"
          style={{ background: col.accent }}
        />
        <span className="text-xs font-semibold text-zinc-400 tracking-wide">
          {col.label}
        </span>
        <span className="ml-auto text-xs text-zinc-600 font-mono">{jobs.length}</span>
      </div>

      {/* Drop zone */}
      <div
        ref={setNodeRef}
        className={`flex-1 rounded-lg min-h-[80px] p-2.5 space-y-2.5 transition-colors ${
          isOver ? "bg-accent-dim ring-1 ring-accent/20" : "bg-surface/40"
        }`}
      >
        {jobs.length === 0 && !isOver && (
          <div className="h-full flex items-center justify-center">
            <span className="text-xs text-zinc-700">Drop here</span>
          </div>
        )}
        {jobs.map((job) => (
          <DraggableCard key={job.id} job={job} />
        ))}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────

type Board = Record<KanbanStatus, JobListing[]>;

export default function TrackerPage() {
  const [board, setBoard] = useState<Board>({
    saved: [], applied: [], interview: [], offer: [], rejected: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<JobListing | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  useEffect(() => {
    api
      .listJobs({ limit: 100 })
      .then(({ jobs }) => {
        // All fetched jobs start in "saved" — board state is local only
        setBoard((b) => ({ ...b, saved: jobs }));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const onDragStart = ({ active }: DragStartEvent) => {
    const job = active.data.current?.job as JobListing | undefined;
    setActiveJob(job ?? null);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveJob(null);
    if (!over) return;

    const targetCol = over.id as KanbanStatus;
    const jobId = active.id as string;

    setBoard((prev) => {
      // Find which column currently holds this job
      const srcCol = (Object.keys(prev) as KanbanStatus[]).find((col) =>
        prev[col].some((j) => j.id === jobId)
      );
      if (!srcCol || srcCol === targetCol) return prev;

      const job = prev[srcCol].find((j) => j.id === jobId)!;
      return {
        ...prev,
        [srcCol]: prev[srcCol].filter((j) => j.id !== jobId),
        [targetCol]: [job, ...prev[targetCol]],
      };
    });
  };

  const totalJobs = Object.values(board).reduce((s, col) => s + col.length, 0);

  return (
    <div className="flex flex-col h-[calc(100vh-48px)]">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center gap-4 px-6 py-4 border-b border-border-subtle">
        <h1 className="text-sm font-semibold text-zinc-200">Application Tracker</h1>
        {totalJobs > 0 && (
          <span className="text-xs text-zinc-600">{totalJobs} jobs</span>
        )}
        <span className="ml-auto text-xs text-zinc-600">
          Board state is local — drag to track progress
        </span>
      </div>

      {/* Board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <svg className="animate-spin w-5 h-5 text-zinc-600" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          >
            <div className="flex gap-5 px-6 py-6 h-full min-h-0">
              {KANBAN_COLUMNS.map((col) => (
                <KanbanColumn key={col.id} col={col} jobs={board[col.id]} />
              ))}
            </div>

            <DragOverlay>
              {activeJob && (
                <div className="w-[224px] rotate-2 scale-105">
                  <JobCard job={activeJob} />
                </div>
              )}
            </DragOverlay>
          </DndContext>
        )}

        {!loading && !error && totalJobs === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <p className="text-zinc-500 text-sm">No jobs saved yet.</p>
            <p className="text-zinc-700 text-xs">
              Run a search and use{" "}
              <span className="font-mono text-zinc-600">orpheus search --save</span>{" "}
              to populate the tracker.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
