"use client";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

type GymClass = {
  _id: Id<"classes">;
  name: string;
  instructor: string;
  dayOfWeek: string;
  time: string;
};

type Props = {
  gymClass?: GymClass;
  onClose: () => void;
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default function ClassModal({ gymClass, onClose }: Props) {
  const add = useMutation(api.classes.add);
  const update = useMutation(api.classes.update);

  const [name, setName] = useState(gymClass?.name ?? "");
  const [instructor, setInstructor] = useState(gymClass?.instructor ?? "");
  const [dayOfWeek, setDayOfWeek] = useState(gymClass?.dayOfWeek ?? "Monday");
  const [time, setTime] = useState(gymClass?.time ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const fields = { name, instructor, dayOfWeek, time };
    if (gymClass) {
      await update({ id: gymClass._id, ...fields });
    } else {
      await add(fields);
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.75)" }}>
      <div className="w-full max-w-md rounded-xl p-8" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
        <h2 className="text-xl mb-6" style={{ color: "#FFFFFF", fontWeight: 500 }}>
          {gymClass ? "Edit Class" : "Add Class"}
        </h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field label="Class Name">
            <input required value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="BJJ Fundamentals" />
          </Field>
          <Field label="Instructor">
            <input required value={instructor} onChange={(e) => setInstructor(e.target.value)} className="input" placeholder="Coach Zain" />
          </Field>
          <Field label="Day of Week">
            <select value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)} className="input">
              {DAYS.map((d) => <option key={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Time">
            <input required value={time} onChange={(e) => setTime(e.target.value)} className="input" placeholder="6:00 PM" />
          </Field>

          <div className="flex gap-3 mt-2">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-lg font-semibold py-2 transition-colors disabled:opacity-50"
              style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
              onMouseEnter={e => { if (!saving) e.currentTarget.style.backgroundColor = "#B91C1C"; }}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#E02020")}
            >
              {saving ? "Saving…" : gymClass ? "Save Changes" : "Add Class"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg font-semibold py-2 transition-colors"
              style={{ backgroundColor: "#1A1A1A", color: "#FFFFFF", border: "0.5px solid #333333" }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#222222")}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#1A1A1A")}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs uppercase tracking-wider" style={{ color: "#555555" }}>{label}</label>
      {children}
    </div>
  );
}
