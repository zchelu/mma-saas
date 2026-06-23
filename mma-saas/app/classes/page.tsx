"use client";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import AppHeader from "../components/app-header";
import ClassModal from "./class-modal";

type GymClass = {
  _id: Id<"classes">;
  name: string;
  instructor: string;
  dayOfWeek: string;
  time: string;
};

export default function ClassesPage() {
  const classes = useQuery(api.classes.getAll);
  const enrollmentCounts = useQuery(api.enrollments.getEnrollmentCounts);
  const remove = useMutation(api.classes.remove);
  const [modal, setModal] = useState<null | "add" | GymClass>(null);
  const router = useRouter();

  async function handleDelete(id: Id<"classes">) {
    if (!confirm("Delete this class?")) return;
    await remove({ id });
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-12">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Classes</h1>
          <button
            onClick={() => setModal("add")}
            className="rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-zinc-200 transition-colors"
          >
            + Add Class
          </button>
        </div>

        <div className="rounded-xl border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900 text-zinc-400 uppercase text-xs tracking-wider">
                <th className="text-left px-6 py-3">Class</th>
                <th className="text-left px-6 py-3">Instructor</th>
                <th className="text-left px-6 py-3">Day</th>
                <th className="text-left px-6 py-3">Time</th>
                <th className="text-left px-6 py-3">Enrolled</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {classes === undefined ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-zinc-500">Loading...</td></tr>
              ) : classes.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-zinc-500">No classes yet.</td></tr>
              ) : (
                (classes as GymClass[]).map((c) => (
                  <tr key={c._id} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900 transition-colors">
                    <td className="px-6 py-4 font-medium">{c.name}</td>
                    <td className="px-6 py-4 text-zinc-400">{c.instructor}</td>
                    <td className="px-6 py-4 text-zinc-400">{c.dayOfWeek}</td>
                    <td className="px-6 py-4 text-zinc-400">{c.time}</td>
                    <td className="px-6 py-4 text-zinc-400">
                      {enrollmentCounts ? (enrollmentCounts[c._id] ?? 0) : "—"}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-3 justify-end">
                        <button
                          onClick={() => router.push(`/classes/${c._id}`)}
                          className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          Manage
                        </button>
                        <button onClick={() => setModal(c)} className="text-xs text-zinc-400 hover:text-white transition-colors">Edit</button>
                        <button onClick={() => handleDelete(c._id)} className="text-xs text-red-500 hover:text-red-400 transition-colors">Delete</button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      {modal !== null && (
        <ClassModal
          gymClass={modal === "add" ? undefined : modal}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
